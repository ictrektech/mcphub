#!/usr/bin/env python3
"""Verify a VOS image using disposable mock identities; never modify an installed VOS app."""
import argparse
import base64
import json
import re
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.DEVNULL).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--keep-running', action='store_true', help='Retain disposable containers for browser QA; remove them afterwards')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    work = Path.home() / 'dev/build/mcphub'
    work.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix='runtime-', dir=work))
    temp.chmod(0o755)
    network = 'mcphub-validation-' + temp.name
    identity, hub = network + '-identity', network + '-hub'
    keep = False
    try:
        docker('network', 'create', network)
        docker('run', '-d', '--name', identity, '--network', network, '--network-alias', 'identity',
               '-p', '127.0.0.1::9000', '-v', f'{root}/tests/fixtures:/validation:ro',
               '--entrypoint', 'node', args.image, '/validation/vos-userinfo.mjs')
        docker('run', '-d', '--init', '--name', hub, '--network', network, '--network-alias', 'hub',
               '--security-opt', 'no-new-privileges:true', '-v', f'{temp}/data:/app/data',
               '-v', f'{root}/tests/fixtures:/validation:ro', '-e', 'VOS_AUTH_ENABLED=true',
               '-e', 'VOS_USERINFO_URL=http://identity:9000/userinfo', '-e', 'BASE_PATH=/app/com.ictrek.mcphub',
               '-e', 'MCPHUB_VOS_VERSION=1.2.3-vos.01', '-e', 'NODE_ENV=production', '-e', 'USE_DB=false', args.image)
        port = docker('port', identity, '9000/tcp').rsplit(':', 1)[1]
        base = f'http://127.0.0.1:{port}/app/com.ictrek.mcphub'

        def api(path, body=None, user='admin', expected=200, method=None, bearer=None):
            headers = {'Content-Type': 'application/json'}
            if user:
                headers['x-vos-token'] = 'validation-' + user
            if bearer:
                headers['Authorization'] = 'Bearer ' + bearer
            req = Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
            try:
                response = urlopen(req, timeout=10)
            except HTTPError as exc:
                response = exc
            payload = response.read()
            assert response.status == expected, f'{path}: HTTP {response.status}, expected {expected}'
            return json.loads(payload) if payload else {}

        for _ in range(60):
            try:
                if api('/config')['data']['vosAuthEnabled']:
                    break
            except (HTTPError, URLError, AssertionError, ValueError):
                time.sleep(1)
        else:
            raise RuntimeError('VOS image did not become ready')
        assert api('/config')['data']['version'] == '1.2.3-vos.01'
        api('/api/auth/user', user=None, expected=401)
        admin = api('/api/auth/user')['user']
        member = api('/api/auth/user', user='member')['user']
        assert admin['isAdmin'] and not member['isAdmin']
        command = {'type': 'stdio', 'command': 'node', 'args': ['/validation/vos-stdio.mjs'], 'visibility': 'private'}
        api('/api/servers', {'name': 'validation-echo', 'config': command}, user='member', expected=403)
        api('/api/servers', {'name': 'validation-echo', 'config': command})
        for _ in range(30):
            info = api('/api/servers/validation-echo')['data']
            if info['tools']:
                break
            time.sleep(1)
        assert info['tools'], 'stdio MCP tool discovery failed'
        tool_name = info['tools'][0]['name']
        api('/api/servers/validation-echo', user='member', expected=403)
        result = api('/api/tools/call/validation-echo', {'toolName': tool_name, 'arguments': {'text': 'VOS runtime passed'}})
        assert 'data' in result, result
        assert result['data']['content'][0]['text'] == 'VOS runtime passed'
        command['visibility'] = 'public'
        api('/api/servers/validation-echo', {'config': command}, method='PUT')
        shared = api('/api/servers/validation-echo', user='member')['data']['config']
        assert 'command' not in shared and 'env' not in shared
        result = api('/api/tools/call/validation-echo', {'toolName': tool_name, 'arguments': {'text': 'shared invocation'}}, user='member')
        assert result['data']['content'][0]['text'] == 'shared invocation'
        encoded = base64.urlsafe_b64encode(json.dumps({'application':'app','user_id':'fixture-app','username':'com.ictrek.consumer'},separators=(',',':')).encode()).decode().rstrip('=')
        app_token = 'eyJhbGciOiJIUzI1NiJ9.' + encoded + '.Zml4dHVyZQ'
        identity_info = api('/api/integration/whoami', user=None, bearer=app_token)['data']
        assert identity_info['kind'] == 'application' and identity_info['is_admin'] is False
        api('/api/auth/user', user=None, bearer=app_token, expected=401)
        discovered = api('/api/integration/discovery', user=None, bearer=app_token)['data']
        assert [server['name'] for server in discovered['servers']] == ['validation-echo']
        assert discovered['mcp_path'] == '/app/com.ictrek.mcphub/mcp'
        key = api('/api/auth/keys', {'name': 'runtime-user-key'}, user='member', expected=201)['data']['token']
        client = """
import fs from 'node:fs';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const {token, visible} = JSON.parse(fs.readFileSync(0, 'utf8'));
const client = new Client({name:'vos-validation-client', version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL('http://hub:3000/app/com.ictrek.mcphub/mcp'), {requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
const {tools} = await client.listTools();
if (Boolean(tools.length) !== visible) throw new Error('User key visibility mismatch');
if (visible) {
 const result = await client.callTool({name:tools[0].name, arguments:{text:'external client passed'}});
 if (result.content[0].text !== 'external client passed') throw new Error('MCP call failed');
}
await client.close();
"""
        def check_client(visible, credential=key):
            result = subprocess.run(['docker', 'exec', '-i', hub, 'node', '--input-type=module', '-e', client],
                                    input=json.dumps({'token': credential, 'visible': visible}), text=True, capture_output=True)
            assert result.returncode == 0, 'External user-key MCP client failed: ' + result.stderr[-1000:]
        check_client(True)
        check_client(True, app_token)
        command['visibility'] = 'private'
        api('/api/servers/validation-echo', {'config': command}, method='PUT')
        check_client(False)
        check_client(False, app_token)
        command['visibility'] = 'public'
        api('/api/servers/validation-echo', {'config': command}, method='PUT')
        api('/api/servers/validation-echo/toggle', {'enabled': False})
        time.sleep(1)
        processes = docker('exec', hub, 'ps', '-eo', 'args')
        assert 'node /validation/vos-stdio.mjs' not in processes, 'disabled stdio process survived'
        api('/api/servers/validation-echo/toggle', {'enabled': True})
        api('/api/servers/validation-echo/reload', {})
        docker('exec', hub, 'sh', '-c', 'test ! -S /var/run/docker.sock && ! command -v dockerd')
        # PID 1 is a Docker init process; the actual application and stdio child run as 10001.
        assert re.search(r'10001\s+node dist/index.js', docker('exec', hub, 'ps', '-eo', 'uid,args'))
        print('PASS: VOS verification, roles, private/public sharing, external user-key calls, stdio tool calls, stop/restart/reload, no Docker socket/daemon, non-root application')
        print('Mock-identity browser QA URL: ' + base + '/')
        if args.keep_running:
            keep = True
            print('Cleanup: docker rm -f ' + hub + ' ' + identity + ' && docker network rm ' + network)
    finally:
        if not keep:
            log = subprocess.run(['docker', 'logs', hub], capture_output=True, text=True)
            (temp / 'container.log').write_text(log.stdout + log.stderr)
            for name in [hub, identity]:
                subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
            subprocess.run(['docker', 'network', 'rm', network], capture_output=True)


if __name__ == '__main__':
    main()
