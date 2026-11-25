import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';

type NodeAction = 'read' | 'logs' | 'definition' | 'control' | 'import' | 'import-stdio';

interface StoredServer {
  name: string;
  type: string;
  enabled: boolean;
  status: string;
  owner: string;
  visibility: string;
  description?: string;
  config: Record<string, unknown>;
}

interface Principal {
  username: string;
  isAdmin: boolean;
  userGroups: string[];
}

const BASE_PATH = '/app/com.ictrek.mcphub';
const PREFIX = `${BASE_PATH}/node-ops`;
const ADMIN_TOKEN = 'a'.repeat(40);
const NODE_TOKEN = 'b'.repeat(40);
const READ_TOKEN = 'c'.repeat(40);
const ALL_ACTIONS: NodeAction[] = [
  'read',
  'logs',
  'definition',
  'control',
  'import',
  'import-stdio',
];
const DEFINITION_WHITELIST = [
  'type',
  'url',
  'command',
  'args',
  'env',
  'headers',
  'passthroughHeaders',
  'description',
  'protocolNegotiation',
  'enableKeepAlive',
  'keepAliveInterval',
  'startOnDemand',
  'idleTimeoutMs',
  'options',
  'openapi',
  'tools',
  'prompts',
  'resources',
] as const;

const store = new Map<string, StoredServer>();
const logEntries: Array<{ timestamp: string; type: string; source: string; message: string }> = [];
const runtimeConfig = { basePath: BASE_PATH, port: 3000, mcpHubVersion: 'test', readonly: false };

const isOwnerOrAdmin = (record: StoredServer, principal: Principal) =>
  principal.isAdmin || record.owner === principal.username;

const canSee = (record: StoredServer, principal: Principal) =>
  isOwnerOrAdmin(record, principal) || record.visibility === 'public';

jest.mock('dotenv', () => ({
  __esModule: true,
  default: { config: jest.fn() },
}));

jest.mock('../../src/config/index.js', () => ({
  __esModule: true,
  default: runtimeConfig,
}));

jest.mock('../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/utils/rateLimit.js', () => ({
  createStandardRateLimiter: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

jest.mock('../../src/services/dataService.js', () => ({
  DataService: jest.fn().mockImplementation(() => ({
    filterData: (records: StoredServer[], principal: Principal) =>
      records.filter((record) => canSee(record, principal)),
  })),
}));

jest.mock('../../src/services/authorizationService.js', () => ({
  authorizationService: {
    can: (action: string, record: StoredServer, principal: Principal) =>
      action === 'server.discover'
        ? canSee(record, principal)
        : isOwnerOrAdmin(record, principal),
  },
}));

jest.mock('../../src/services/serverConfigPresenter.js', () => ({
  presentServerForPrincipal: (record: StoredServer, principal: Principal) => ({
    view: isOwnerOrAdmin(record, principal) ? 'full' : 'public',
    data: isOwnerOrAdmin(record, principal)
      ? { ...record.config }
      : { type: record.config.type, url: record.config.url, description: record.config.description },
  }),
}));

jest.mock('../../src/services/logService.js', () => ({
  __esModule: true,
  default: { getLogs: () => logEntries },
}));

jest.mock('../../src/services/mcpService.js', () => ({
  getServersInfo: async () =>
    [...store.values()].map((server) => ({ name: server.name, status: server.status })),
  getServerByName: jest.fn(),
  addServer: async (name: string, config: StoredServer['config']) => {
    if (store.has(name)) return { success: false, message: 'already exists' };
    store.set(name, {
      name,
      type: String(config.type),
      enabled: config.enabled !== false,
      status: config.enabled === false ? 'disconnected' : 'connecting',
      owner: String(config.owner ?? 'unknown'),
      visibility: String(config.visibility ?? 'public'),
      config: { ...config },
    });
    return { success: true };
  },
  toggleServerStatus: async (name: string, enabled: boolean) => {
    const server = store.get(name);
    if (!server) return { success: false, message: 'not found' };
    server.enabled = enabled;
    server.status = enabled ? 'connecting' : 'disconnected';
    return { success: true };
  },
  notifyToolChanged: jest.fn().mockResolvedValue(undefined),
  broadcastToolListChanged: jest.fn(),
  broadcastPromptListChanged: jest.fn(),
  broadcastResourceListChanged: jest.fn(),
}));

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findAll: async () => [...store.values()],
    findById: async (name: string) => store.get(name) ?? null,
  }),
}));

jest.mock('../../src/utils/serverConfigPersistence.js', () => ({
  normalizeServerConfigForPersistence: (config: Record<string, unknown>) => ({ ...config }),
}));

const seed = () => {
  store.clear();
  store.set('shared-http', {
    name: 'shared-http',
    type: 'streamable-http',
    enabled: true,
    status: 'connected',
    owner: 'admin',
    visibility: 'public',
    description: 'shared http server',
    config: {
      type: 'streamable-http',
      url: 'http://10.0.0.9:8080/mcp/gitea',
      headers: { Authorization: '${UPSTREAM_TOKEN}' },
      description: 'shared http server',
      enableKeepAlive: true,
      oauth: { accessToken: 'MUST_NOT_LEAK' },
    },
  });
  store.set('secret-http', {
    name: 'secret-http',
    type: 'sse',
    enabled: true,
    status: 'connected',
    owner: 'alice',
    visibility: 'private',
    config: { type: 'sse', url: 'http://10.0.0.10/sse', description: 'private server' },
  });
  store.set('playwright', {
    name: 'playwright',
    type: 'stdio',
    enabled: true,
    status: 'connected',
    owner: 'admin',
    visibility: 'private',
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    },
  });
  logEntries.length = 0;
  logEntries.push({
    timestamp: '2026-11-25T03:20:04.114Z',
    type: 'error',
    source: 'main',
    message: 'Upstream server stderr {"serverName":"playwright","message":"boom"}',
  });
};

const originalEnv = { ...process.env };

describe('node-ops against the implemented middleware and controller', () => {
  let app: Express;

  beforeEach(async () => {
    process.env.MCP_NODE_TOKENS = JSON.stringify([
      { name: 'node-a', token: ADMIN_TOKEN, actions: ALL_ACTIONS, scope: 'admin' },
      {
        name: 'node-b',
        token: NODE_TOKEN,
        actions: ['read', 'logs', 'definition', 'control', 'import'],
        scope: 'node',
      },
      { name: 'read-only', token: READ_TOKEN, actions: ['read'], scope: 'node' },
    ]);
    delete process.env.READONLY;
    runtimeConfig.readonly = false;
    jest.resetModules();
    seed();

    const middleware = await import('../../src/middlewares/nodeToken.js');
    const controller = await import('../../src/controllers/nodeOpsController.js');
    const limiter: RequestHandler = middleware.nodeOpsRateLimiter;
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.get(`${PREFIX}/health`, limiter, middleware.requireNodeToken(null), controller.nodeOpsHealth);
    app.get(`${PREFIX}/servers`, limiter, middleware.requireNodeToken('read'), controller.nodeOpsListServers);
    app.get(
      `${PREFIX}/servers/:name/logs`,
      limiter,
      middleware.requireNodeToken('logs'),
      controller.nodeOpsServerLogs,
    );
    app.get(
      `${PREFIX}/servers/:name/definition`,
      limiter,
      middleware.requireNodeToken('definition'),
      controller.nodeOpsServerDefinition,
    );
    app.post(
      `${PREFIX}/servers/:name/enable`,
      limiter,
      middleware.requireNodeToken('control'),
      controller.nodeOpsEnableServer,
    );
    app.post(
      `${PREFIX}/servers/:name/disable`,
      limiter,
      middleware.requireNodeToken('control'),
      controller.nodeOpsDisableServer,
    );
    app.post(`${PREFIX}/servers`, limiter, middleware.requireNodeToken('import'), controller.nodeOpsImportServer);
    app.all(`${PREFIX}/*`, limiter, controller.nodeOpsNotFound);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const get = (path: string, token?: string) => {
    const pending = request(app).get(`${PREFIX}${path}`);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };
  const post = (path: string, body?: unknown, token?: string) => {
    const pending = request(app).post(`${PREFIX}${path}`);
    const authenticated = token ? pending.set('Authorization', `Bearer ${token}`) : pending;
    return body === undefined ? authenticated : authenticated.send(body);
  };

  it('rejects a missing token with code node-token-missing', async () => {
    const res = await get('/servers');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('node-token-missing');
  });

  it('rejects a wrong token with code node-token-invalid', async () => {
    const res = await get('/servers', 'x'.repeat(40));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('node-token-invalid');
  });

  it('rejects an action gap with 403 and reports health capabilities', async () => {
    const denied = await post('/servers/playwright/enable', undefined, READ_TOKEN);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('node-action-forbidden');
    const health = await get('/health', READ_TOKEN);
    expect(health.status).toBe(200);
    expect(health.body.data.capabilities).toEqual(['read']);
  });

  it('hides another owners private server from scope:node but not scope:admin', async () => {
    const nodeView = await get('/servers', NODE_TOKEN);
    expect(nodeView.status).toBe(200);
    expect(nodeView.body.data.servers.map((entry: { name: string }) => entry.name)).not.toContain(
      'secret-http',
    );
    const adminView = await get('/servers', ADMIN_TOKEN);
    expect(adminView.body.data.servers.map((entry: { name: string }) => entry.name)).toContain(
      'secret-http',
    );
  });

  it('forbids exporting a server owned by someone else', async () => {
    const res = await get('/servers/secret-http/definition', NODE_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('node-scope-forbidden');
  });

  it('forbids stdio import without import-stdio', async () => {
    const res = await post(
      '/servers',
      { name: 'injected-stdio', definition: { type: 'stdio', command: 'npx' } },
      NODE_TOKEN,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('stdio-import-forbidden');
  });

  it('rejects a definition carrying an oauth key', async () => {
    const res = await post(
      '/servers',
      {
        name: 'oauth-smuggle',
        definition: { type: 'streamable-http', url: 'http://10.0.0.1/mcp', oauth: { accessToken: 'x' } },
      },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid-definition');
  });

  it('rejects a duplicate import with 409 server-duplicate', async () => {
    const res = await post(
      '/servers',
      { name: 'shared-http', definition: { type: 'streamable-http', url: 'http://other/mcp' } },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('server-duplicate');
  });

  it('disables a server and broadcasts the three list changes', async () => {
    const res = await post('/servers/playwright/disable', undefined, ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'playwright', enabled: false, status: 'disconnected' });
    const mcp = await import('../../src/services/mcpService.js');
    expect(mcp.broadcastToolListChanged).toHaveBeenCalledTimes(1);
    expect(mcp.broadcastPromptListChanged).toHaveBeenCalledTimes(1);
    expect(mcp.broadcastResourceListChanged).toHaveBeenCalledTimes(1);
    const list = await get('/servers', ADMIN_TOKEN);
    const entry = list.body.data.servers.find((item: { name: string }) => item.name === 'playwright');
    expect(entry).toMatchObject({ enabled: false, status: 'disconnected' });
  });

  it('returns 200 with matched:0 when no log record matches', async () => {
    const res = await get('/servers/shared-http/logs?tail=20', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ text: '', matched: 0, partial: true });
  });

  it('round-trips a definition through export and import with the whitelist intact', async () => {
    const exported = await get('/servers/shared-http/definition', ADMIN_TOKEN);
    expect(exported.status).toBe(200);
    const definition = exported.body.data.definition as Record<string, unknown>;
    expect(definition.oauth).toBeUndefined();
    expect(definition.headers.Authorization).toBe('${UPSTREAM_TOKEN}');
    expect(Object.keys(definition).sort()).toEqual(
      DEFINITION_WHITELIST.filter((key) => key in definition).sort(),
    );

    const imported = await post(
      '/servers',
      { name: 'roundtrip-http', definition, enable: false },
      ADMIN_TOKEN,
    );
    expect(imported.status).toBe(200);
    expect(imported.body.data).toMatchObject({
      name: 'roundtrip-http',
      created: true,
      enabled: false,
      status: 'disconnected',
    });

    const reExported = await get('/servers/roundtrip-http/definition', ADMIN_TOKEN);
    expect(reExported.status).toBe(200);
    expect(reExported.body.data.definition).toEqual(definition);
  });

  it('rejects an out-of-range tail and write actions in readonly mode', async () => {
    const invalidTail = await get('/servers/playwright/logs?tail=2001', ADMIN_TOKEN);
    expect(invalidTail.status).toBe(400);
    expect(invalidTail.body.code).toBe('invalid-tail');

    runtimeConfig.readonly = true;
    const readonly = await post('/servers/playwright/enable', undefined, ADMIN_TOKEN);
    expect(readonly.status).toBe(403);
    expect(readonly.body.code).toBe('readonly');
  });

  it('answers unknown paths with JSON and keeps tokens out of audit logs', async () => {
    const unknown = await get('/nope', ADMIN_TOKEN);
    expect(unknown.status).toBe(404);
    expect(unknown.headers['content-type']).toContain('application/json');
    expect(unknown.body.success).toBe(false);
    expect(['not-found', 'server-not-found']).toContain(unknown.body.code);

    await post('/servers/playwright/disable', undefined, ADMIN_TOKEN);
    const loggerModule = await import('../../src/utils/logger.js');
    const messages = (loggerModule.logger.info as unknown as jest.Mock).mock.calls
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(messages).toContain('[node-ops] audit');
    expect(messages).not.toContain(ADMIN_TOKEN);
  });
});
