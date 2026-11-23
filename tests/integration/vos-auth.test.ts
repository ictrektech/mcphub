// VOS adaptation integration tests use a disposable user store and real HTTP userinfo verifier.
jest.mock('openid-client', () => ({}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import {
  JsonFileDaoFactory,
  setDaoFactory,
  getUserDao,
  getServerDao,
} from '../../src/dao/DaoFactory.js';
import { clearSettingsCache } from '../../src/config/index.js';
import { initI18n } from '../../src/utils/i18n.js';
import { initMiddlewares } from '../../src/middlewares/index.js';
import { sseUserContextMiddleware } from '../../src/middlewares/userContext.js';
import {
  handleMcpPostRequest,
  transports,
  closeModernMcpHandler,
} from '../../src/services/sseService.js';
import { initRoutes } from '../../src/routes/index.js';
import { authenticateVosToken } from '../../src/services/vosAuthService.js';
import { initializeDefaultUser } from '../../src/models/User.js';
import { authorizationService } from '../../src/services/authorizationService.js';

const originalEnv = { ...process.env };
let directory: string;
let verifier: Server;
let app: express.Express;
let role = 'system_admin';
let enabled = 1;
let calls = 0;
const appToken = jwt.sign(
  { application: 'app', user_id: 'app-context-id', username: 'com.ictrek.consumer' },
  'fixture-signing-key',
);
const memberToken = jwt.sign(
  { application: 'com.ictrek.consumer', user_id: 'member-subject' },
  'fixture-signing-key',
);

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-vos-'));
  process.env.USE_DB = 'false';
  process.env.VOS_AUTH_ENABLED = 'true';
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  const idp = express();
  idp.get('/userinfo', (req, res) => {
    calls++;
    const token = req.header('authorization');
    if (token === 'Bearer redirect') {
      res.redirect('http://127.0.0.1/steal');
      return;
    }
    if (token === `Bearer ${appToken}`) {
      res.json({
        sub: 'com.ictrek.consumer',
        preferred_username: 'com.ictrek.consumer',
        role_code: 'system_admin',
        enable: 1,
      });
      return;
    }
    if (
      token !== 'Bearer admin-token' &&
      token !== 'Bearer member-token' &&
      token !== `Bearer ${memberToken}`
    ) {
      res.sendStatus(401);
      return;
    }
    res.json({
      sub: token === 'Bearer admin-token' ? 'admin-subject' : 'member-subject',
      preferred_username: 'admin',
      role_code: token === 'Bearer admin-token' ? role : 'user',
      enable: enabled,
    });
  });
  verifier = await new Promise<Server>((resolve) => {
    const server = idp.listen(0, '127.0.0.1', () => resolve(server));
  });
  process.env.VOS_USERINFO_URL = `http://127.0.0.1:${(verifier.address() as { port: number }).port}/userinfo`;
  fs.writeFileSync(
    process.env.MCPHUB_SETTING_PATH,
    JSON.stringify({
      mcpServers: {},
      users: [],
      groups: [],
      systemConfig: { routing: { skipAuth: true, enableBearerAuth: false } },
    }),
  );
  clearSettingsCache();
  setDaoFactory(new JsonFileDaoFactory());
  app = express();
  await initI18n();
  initMiddlewares(app);
  await initRoutes(app);
  app.post('/mcp', sseUserContextMiddleware, handleMcpPostRequest);
});

afterAll(async () => {
  for (const session of Object.values(transports)) await session.transport.close();
  await closeModernMcpHandler();
  await new Promise<void>((resolve, reject) =>
    verifier.close((error) => (error ? reject(error) : resolve())),
  );
  fs.rmSync(directory, { recursive: true, force: true });
  process.env = originalEnv;
  clearSettingsCache();
  setDaoFactory(new JsonFileDaoFactory());
});

it('provisions platform users without a default local administrator', async () => {
  await initializeDefaultUser();
  expect(await getUserDao().findAll()).toHaveLength(0);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      request(app).post('/api/auth/vos').set('Authorization', 'Bearer admin-token'),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(await getUserDao().findAll()).toHaveLength(1);
  expect(responses[0].body.user.isAdmin).toBe(true);
  expect(responses[0].body.user.username).not.toBe('admin');
  expect(responses[0].body).not.toHaveProperty('token');
  expect(JSON.stringify(responses[0].body)).not.toContain('password');
});

it('rejects missing, forged and redirected credentials, even if skipAuth is configured', async () => {
  // Same-origin browser transport may include cookies, but cookies never replace
  // the verified application access token on the VOS login endpoint.
  expect(
    (await request(app).post('/api/auth/vos').set('Cookie', 'access_token=admin-token')).status,
  ).toBe(401);
  expect((await request(app).get('/api/auth/user')).status).toBe(401);
  expect(
    (await request(app).get('/api/auth/user').set('x-auth-token', 'forged').set('x-user', 'admin'))
      .status,
  ).toBe(401);
  expect((await request(app).get('/api/auth/user').set('x-vos-token', 'forged')).status).toBe(401);
  expect(
    (await request(app).post('/api/auth/vos').set('Authorization', 'Bearer redirect')).status,
  ).toBe(401);
  const config = await request(app).get('/public-config');
  expect(config.body.data.skipAuth).toBe(false);
});

it('disables password login and local registration in VOS mode', async () => {
  expect(
    (await request(app).post('/api/auth/login').send({ username: 'admin', password: 'unused' }))
      .status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/api/auth/register')
        .send({ username: 'new-user', password: 'Unused-Password-123' })
    ).status,
  ).toBe(403);
});

it('checks live platform status and role for every authenticated request', async () => {
  const before = calls;
  expect(
    (await request(app).get('/api/auth/user').set('x-vos-token', 'admin-token')).body.user.isAdmin,
  ).toBe(true);
  role = 'user';
  expect(
    (await request(app).get('/api/auth/user').set('x-vos-token', 'admin-token')).body.user.isAdmin,
  ).toBe(false);
  enabled = 0;
  expect((await request(app).get('/api/auth/user').set('x-vos-token', 'admin-token')).status).toBe(
    401,
  );
  enabled = 1;
  role = 'system_admin';
  expect(calls - before).toBe(3);
});

it("shares usage without disclosing another user's configuration", async () => {
  const admin = await authenticateVosToken('admin-token');
  const member = await authenticateVosToken('member-token');
  await getServerDao().create({
    name: 'shared',
    type: 'streamable-http',
    url: 'https://example.test/mcp',
    enabled: false,
    owner: admin.username,
    visibility: 'public',
    headers: { Authorization: 'Bearer PRIVATE_UPSTREAM_SECRET' },
  });
  expect(
    authorizationService.can(
      'server.invoke',
      { owner: admin.username, visibility: 'public' },
      member,
    ),
  ).toBe(true);
  expect(
    authorizationService.can(
      'server.invoke',
      { owner: admin.username, visibility: 'private' },
      member,
    ),
  ).toBe(false);
  expect(
    authorizationService.can(
      'server.invoke',
      { owner: admin.username, visibility: 'group', sharedWithUsers: [member.username] },
      member,
    ),
  ).toBe(true);
  const result = await request(app).get('/api/servers/shared').set('x-vos-token', 'member-token');
  expect(result.status).toBe(200);
  expect(result.body.data.config).not.toHaveProperty('headers');
  expect(result.text).not.toContain('PRIVATE_UPSTREAM_SECRET');
  expect(
    (
      await request(app)
        .post('/api/servers')
        .set('x-vos-token', 'member-token')
        .send({ name: 'command', config: { type: 'stdio', command: 'node', args: [] } })
    ).status,
  ).toBe(403);
});

it('routes dashboard tool calls before the generic OpenAPI tool route', async () => {
  const response = await request(app)
    .post('/api/tools/call/shared')
    .set('x-vos-token', 'admin-token')
    .send({ toolName: 'not-connected', arguments: {} });
  expect(response.status).toBe(200);
  // A disabled upstream cannot execute; the dashboard controller still returns
  // its documented envelope instead of OpenAPI's raw tool result.
  expect(response.body.data).toEqual(
    expect.objectContaining({ toolName: 'not-connected', isError: true }),
  );
});

it('never accepts an anonymous MCP connection when VOS mode is enabled', async () => {
  const result = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
  expect(result.status).toBe(401);
});

it('localizes VOS errors independently for concurrent Chinese and English requests', async () => {
  const [zh, en] = await Promise.all([
    request(app).get('/api/auth/user').set('Accept-Language', 'zh-CN'),
    request(app).get('/api/auth/user').set('Accept-Language', 'en-US'),
  ]);
  expect(zh.status).toBe(401);
  expect(en.status).toBe(401);
  expect(zh.body.message).toContain('请从 VOS 打开');
  expect(en.body.message).toContain('Open MCPHub from VOS');
});

it('limits platform app credentials to integration endpoints without provisioning an administrator', async () => {
  const count = (await getUserDao().findAll()).length;
  expect(
    (await request(app).post('/api/auth/vos').set('Authorization', `Bearer ${appToken}`)).status,
  ).toBe(401);
  expect(
    (await request(app).get('/api/auth/user').set('Authorization', `Bearer ${appToken}`)).status,
  ).toBe(401);
  const identity = await request(app)
    .get('/api/integration/whoami')
    .set('Authorization', `Bearer ${appToken}`);
  expect(identity.status).toBe(200);
  expect(identity.body.data).toEqual(
    expect.objectContaining({
      kind: 'application',
      is_admin: false,
      scope: 'public',
      application_id: 'com.ictrek.consumer',
    }),
  );
  expect((await getUserDao().findAll()).length).toBe(count);
  const application = await authenticateVosToken(appToken, { allowApplication: true });
  expect(
    authorizationService.can(
      'server.invoke',
      { owner: application.username, visibility: 'private' },
      application,
    ),
  ).toBe(false);
  expect(
    authorizationService.can(
      'server.invoke',
      { owner: 'other', visibility: 'group', sharedWithUsers: [application.username] },
      application,
    ),
  ).toBe(false);
});

it('returns only authorized discovery metadata for users and application credentials', async () => {
  const admin = await authenticateVosToken('admin-token');
  const member = await authenticateVosToken('member-token');
  for (const [name, owner, visibility, enabled, sharedWithUsers] of [
    ['public-api', admin.username, 'public', true, []],
    ['private-api', admin.username, 'private', true, []],
    ['member-api', member.username, 'private', true, []],
    ['shared-api', admin.username, 'group', true, [member.username]],
    ['disabled-api', admin.username, 'public', false, []],
  ] as const) {
    await getServerDao().create({
      name,
      owner,
      visibility,
      enabled,
      sharedWithUsers: [...sharedWithUsers],
      type: 'streamable-http',
      url: 'https://private-upstream.example.test/SECRET_URL',
      headers: { Authorization: 'Bearer SECRET_KEY' },
    });
  }
  const application = await request(app)
    .get('/api/integration/discovery')
    .set('Authorization', `Bearer ${appToken}`);
  expect(application.status).toBe(200);
  expect(application.body.data.servers.map((server: { name: string }) => server.name)).toEqual([
    'public-api',
  ]);
  expect(application.body.data).toEqual(
    expect.objectContaining({ mcp_path: '/mcp', transport: 'streamable-http' }),
  );
  expect(application.text).not.toMatch(/SECRET|headers|command|password/);
  const user = await request(app)
    .get('/api/integration/discovery')
    .set('Authorization', `Bearer ${memberToken}`);
  expect(user.body.data.servers.map((server: { name: string }) => server.name).sort()).toEqual([
    'member-api',
    'public-api',
    'shared-api',
  ]);
});

it('verifies VOS JWTs on the MCP transport instead of trusting their decoded claims', async () => {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'VOS consumer', version: '1' },
    },
  };
  const forged = jwt.sign({ application: 'app', user_id: 'forged' }, 'wrong-fixture-key');
  const rejected = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${forged}`)
    .send(payload);
  expect(rejected.status).toBe(401);
  const accepted = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Authorization', `Bearer ${appToken}`)
    .send(payload);
  expect(accepted.status).toBe(200);
});
