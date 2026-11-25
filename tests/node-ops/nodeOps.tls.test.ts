// §A-2 control-plane mTLS acceptance tests. Real TLS sockets, real
// nodeToken/nodeOpsTls/controller; only the services around them are mocked.
import { readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const FIXTURES = path.join(__dirname, 'fixtures');
const ca = readFileSync(path.join(FIXTURES, 'ca.pem'));
const serverKey = readFileSync(path.join(FIXTURES, 'server.key'));
const serverCert = readFileSync(path.join(FIXTURES, 'server.crt'));
const clientCert = (name: string) => readFileSync(path.join(FIXTURES, `client-${name}.crt`));
const clientKey = (name: string) => readFileSync(path.join(FIXTURES, `client-${name}.key`));

const ADMIN_TOKEN = 'a'.repeat(40); // peer node-a, scope admin
const NODE_B_TOKEN = 'b'.repeat(40); // peer node-b
const READ_TOKEN = 'c'.repeat(40); // peer read-only, actions [read]

const TOKENS_ENV = JSON.stringify([
  { name: 'node-a', token: ADMIN_TOKEN, actions: ['read', 'logs', 'definition', 'control', 'import', 'import-stdio'], scope: 'admin' },
  { name: 'node-b', token: NODE_B_TOKEN, actions: ['read', 'logs'], scope: 'node' },
  { name: 'read-only', token: READ_TOKEN, actions: ['read'], scope: 'node' },
]);

jest.mock('dotenv', () => ({ __esModule: true, default: { config: jest.fn() } }));

const runtimeConfig = { basePath: '/app/mcphub', port: 3000, mcpHubVersion: 'test', readonly: false };
jest.mock('../../src/config/index.js', () => ({ __esModule: true, default: runtimeConfig }));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/services/dataService.js', () => ({
  DataService: jest.fn().mockImplementation(() => ({ filterData: (records: unknown[]) => records })),
}));
jest.mock('../../src/services/authorizationService.js', () => ({
  authorizationService: { can: () => true },
}));
jest.mock('../../src/services/serverConfigPresenter.js', () => ({
  presentServerForPrincipal: (record: unknown) => ({ view: 'full', data: record }),
}));
jest.mock('../../src/services/logService.js', () => ({ __esModule: true, default: { getLogs: () => [] } }));
jest.mock('../../src/services/mcpService.js', () => ({
  getServersInfo: async () => [],
  addServer: jest.fn(async () => ({ success: true })),
  toggleServerStatus: jest.fn(async () => ({ success: true })),
  notifyToolChanged: jest.fn(async () => undefined),
  broadcastToolListChanged: jest.fn(),
  broadcastPromptListChanged: jest.fn(),
  broadcastResourceListChanged: jest.fn(),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({
    findAll: async () => [],
    findById: async (name: string) => ({ name, owner: 'node-a', visibility: 'public' }),
  }),
}));
jest.mock('../../src/utils/serverConfigPersistence.js', () => ({
  normalizeServerConfigForPersistence: (config: unknown) => config,
}));

const originalEnv = { ...process.env };

const buildApp = async (): Promise<Express> => {
  jest.resetModules();
  const middleware = await import('../../src/middlewares/nodeToken.js');
  const controller = await import('../../src/controllers/nodeOpsController.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/node-ops/health', middleware.requireNodeToken(null), controller.nodeOpsHealth);
  app.get('/node-ops/servers', middleware.requireNodeToken('read'), controller.nodeOpsListServers);
  app.post(
    '/node-ops/servers/:name/enable',
    middleware.requireNodeToken('control'),
    controller.nodeOpsEnableServer,
  );
  return app;
};

interface TlsServer {
  port: number;
  close: () => Promise<void>;
}

const startTlsServer = async (app: Express): Promise<TlsServer> => {
  const server = https.createServer(
    { key: serverKey, cert: serverCert, ca, requestCert: true, rejectUnauthorized: true },
    app,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

interface TlsGetResult {
  status?: number;
  body?: Record<string, unknown>;
  error?: Error;
}

const tlsGet = (
  port: number,
  reqPath: string,
  opts: { client?: string; token?: string; method?: 'GET' | 'POST' } = {},
): Promise<TlsGetResult> =>
  new Promise((resolve) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: opts.method ?? 'GET',
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
        agent: new https.Agent({
          ca,
          ...(opts.client ? { cert: clientCert(opts.client), key: clientKey(opts.client) } : {}),
        }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) {
            resolve({ error: error as Error });
          }
        });
      },
    );
    req.on('error', (error: Error) => resolve({ error }));
    req.end();
  });

describe('node-ops mTLS control plane (§A-2)', () => {
  beforeEach(() => {
    process.env.MCP_NODE_TOKENS = TOKENS_ENV;
    delete process.env.MCP_NODE_OPS_REQUIRE_TLS;
    delete process.env.MCP_NODE_MTLS_ONLY;
    delete process.env.MCP_NODE_OPS_TLS_CERT;
    delete process.env.MCP_NODE_OPS_TLS_KEY;
    delete process.env.MCP_NODE_OPS_TLS_CA;
    runtimeConfig.readonly = false;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('answers 403 tls-required for /node-ops on a plain HTTP socket', async () => {
    const app = await buildApp();
    const noToken = await request(app).get('/node-ops/health');
    expect(noToken.status).toBe(403);
    expect(noToken.body.code).toBe('tls-required');
    const withToken = await request(app).get('/node-ops/health').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(withToken.status).toBe(403);
    expect(withToken.body.code).toBe('tls-required');
  });

  it('allows the A-1 token-only behaviour when REQUIRE_TLS is explicitly disabled', async () => {
    process.env.MCP_NODE_OPS_REQUIRE_TLS = 'false';
    const app = await buildApp();
    const res = await request(app).get('/node-ops/health').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.capabilities).toContain('control');
  });

  it('rejects the TLS handshake when no client certificate is presented', async () => {
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      const result = await tlsGet(tls.port, '/node-ops/health', { token: ADMIN_TOKEN });
      expect(result.error).toBeDefined();
      expect(result.status).toBeUndefined();
    } finally {
      await tls.close();
    }
  });

  it('rejects a certificate CN that is not a registered peer with node-peer-unknown', async () => {
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      const result = await tlsGet(tls.port, '/node-ops/health', { client: 'ghost', token: ADMIN_TOKEN });
      expect(result.status).toBe(403);
      expect(result.body?.code).toBe('node-peer-unknown');
    } finally {
      await tls.close();
    }
  });

  it('rejects a CN/token peer mismatch with node-peer-mismatch', async () => {
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      const result = await tlsGet(tls.port, '/node-ops/health', { client: 'node-a', token: NODE_B_TOKEN });
      expect(result.status).toBe(403);
      expect(result.body?.code).toBe('node-peer-mismatch');
    } finally {
      await tls.close();
    }
  });

  it('rejects an action gap with node-action-forbidden even for a valid cert+token pair', async () => {
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      // read-only token lacks `control`; its cert CN matches its peer name, so
      // the failure happens at the action check, not identity.
      const result = await tlsGet(tls.port, '/node-ops/servers/demo/enable', {
        client: 'read-only',
        token: READ_TOKEN,
        method: 'POST',
      });
      expect(result.status).toBe(403);
      expect(result.body?.code).toBe('node-action-forbidden');
    } finally {
      await tls.close();
    }
  });

  it('serves the A-1 behaviour unchanged for a valid certificate + token pair', async () => {
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      const result = await tlsGet(tls.port, '/node-ops/health', { client: 'node-a', token: ADMIN_TOKEN });
      expect(result.status).toBe(200);
      expect(result.body?.success).toBe(true);
      const data = result.body?.data as Record<string, unknown>;
      expect(data.capabilities).toContain('control');
      expect(data.name).toBeDefined();
    } finally {
      await tls.close();
    }
  });

  it('identifies the peer by certificate alone in mTLS-only mode', async () => {
    process.env.MCP_NODE_MTLS_ONLY = 'true';
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      const ok = await tlsGet(tls.port, '/node-ops/health', { client: 'node-a' });
      expect(ok.status).toBe(200);
      expect(ok.body?.success).toBe(true);
      const ghost = await tlsGet(tls.port, '/node-ops/health', { client: 'ghost' });
      expect(ghost.status).toBe(403);
      expect(ghost.body?.code).toBe('node-peer-unknown');
    } finally {
      await tls.close();
    }
  });

  it('writes audit lines carrying the client-cert fingerprint', async () => {
    const app = await buildApp();
    const tls = await startTlsServer(app);
    try {
      const result = await tlsGet(tls.port, '/node-ops/servers/demo/enable', {
        client: 'node-a',
        token: ADMIN_TOKEN,
        method: 'POST',
      });
      expect(result.status).toBe(200);
      const loggerModule = await import('../../src/utils/logger.js');
      const messages = (loggerModule.logger.info as unknown as jest.Mock).mock.calls
        .map((call) => JSON.stringify(call))
        .join('\n');
      expect(messages).toContain('[node-ops] audit');
      expect(messages).toContain('certFingerprint');
      expect(messages).not.toContain(ADMIN_TOKEN);
    } finally {
      await tls.close();
    }
  });
});
