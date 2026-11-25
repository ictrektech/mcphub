import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  credentialStatus,
  dataPlaneEnvNameOf,
  deleteCredential,
  resolveDataPlaneToken,
  setCredential,
} from '../../src/services/nodeCredentialStore.js';

const originalDir = process.env.MCP_NODE_SECRETS_DIR;
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcphub-node-secrets-'));
  file = join(dir, 'node-secrets.json');
  process.env.MCP_NODE_SECRETS_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.MCP_NODE_SECRETS_DIR;
  else process.env.MCP_NODE_SECRETS_DIR = originalDir;
});

describe('node credential store', () => {
  it('writes only the canonical id key with 0600 permissions', async () => {
    await setCredential({ id: 'node-b', name: 'peer-b' }, '  mcphub_from_store  ');

    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed).toEqual({ 'node-b': 'mcphub_from_store' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('reads the token only from the store', async () => {
    await setCredential('node-b', 'mcphub_from_store');

    expect(await resolveDataPlaneToken('node-b')).toBe('mcphub_from_store');
    expect(await credentialStatus('node-b')).toEqual({ configured: true, source: 'store' });
  });

  it('ignores a matching environment variable entirely', async () => {
    process.env[dataPlaneEnvNameOf('node-b')] = 'mcphub_from_env';

    expect(await resolveDataPlaneToken('node-b')).toBeUndefined();
    expect(await credentialStatus('node-b')).toEqual({ configured: false, source: null });
    delete process.env[dataPlaneEnvNameOf('node-b')];
  });

  it('falls back to the node name when no id entry exists', async () => {
    await setCredential('peer-b', 'mcphub_key');

    expect(await resolveDataPlaneToken({ id: 'new-id', name: 'peer-b' })).toBe('mcphub_key');
  });

  it('reports unconfigured and refuses invalid node ids or blank tokens', async () => {
    expect(await credentialStatus('node-b')).toEqual({ configured: false, source: null });
    await expect(setCredential('node-b', '  ')).rejects.toThrow();
    await expect(setCredential('bad id', 'token')).rejects.toThrow();
  });

  it('deletes only the canonical key and leaves other nodes alone', async () => {
    await setCredential({ id: 'node-b', name: 'peer-b' }, 'mcphub_b');
    await setCredential('node-c', 'mcphub_c');
    await deleteCredential({ id: 'node-b', name: 'peer-b' });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'node-c': 'mcphub_c' });
  });
});
