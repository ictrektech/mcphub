// Disposable validation fixture: mock VOS identity and a browser bridge, never production auth.
import http from 'node:http';
import { Readable } from 'node:stream';
const appToken = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({application:'app',user_id:'fixture-app',username:'com.ictrek.consumer'})).toString('base64url') + '.Zml4dHVyZQ';
const bridge = `<script>
window.vos_platform={
 api:{v1000:{oauth2:{authorize:async p=>({code:'validation-code',state:p.state}),token:async()=>({access_token:'validation-admin',expires_in:300})}}},
 platform:{getUser:async()=>({sub:'validation-admin-subject'})},
 getState:async()=>({locale:window.parent.__validationLocale || 'zh-CN'}),
 broadcast:{on:(event,handler)=>{const listener=e=>handler(e.detail);window.addEventListener('validation-'+event,listener);return()=>window.removeEventListener('validation-'+event,listener)}}
};
</script>`;
http.createServer(async (req, res) => {
  if (req.url === '/validation') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>MCPHub VOS language validation</title></head>
<body style="margin:0;font:14px system-ui"><div style="padding:8px;background:#eef2ff">
Simulated VOS identity and language — validation only
<button onclick="setLocale('zh-CN')">VOS: 中文</button><button onclick="setLocale('en-US')">VOS: English</button>
</div><iframe id="app" src="/app/com.ictrek.mcphub/servers" style="border:0;width:100%;height:calc(100vh - 42px)"></iframe>
<script>window.__validationLocale='zh-CN';function setLocale(locale){window.__validationLocale=locale;document.getElementById('app').contentWindow.dispatchEvent(new CustomEvent('validation-locale-change',{detail:{locale}}))}</script>
</body></html>`);
    return;
  }
  if (req.url === '/userinfo') {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (token === appToken) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({sub:'com.ictrek.consumer',preferred_username:'com.ictrek.consumer',enable:1,role_code:'system_admin'}));
      return;
    }
    if (!['validation-admin', 'validation-member'].includes(token)) { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ sub: `${token}-subject`, preferred_username: token,
      enable: 1, role_code: token === 'validation-admin' ? 'system_admin' : 'user' }));
    return;
  }
  try {
    const headers = { ...req.headers };
    for (const name of ['host', 'connection', 'content-length']) delete headers[name];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`http://hub:3000${req.url}`, { method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' });
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) res.setHeader(name, value);
    });
    if (upstream.headers.get('content-type')?.includes('text/html')) {
      res.end((await upstream.text()).replace('<head>', `<head>${bridge}`));
    } else if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else res.end();
  } catch { res.writeHead(502).end(); }
}).listen(9000, '0.0.0.0');
