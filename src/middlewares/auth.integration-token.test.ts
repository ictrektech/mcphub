// Must be set before auth.js is imported: the integration token is read once
// at module load time.
process.env.MCPHUB_INTEGRATION_TOKEN = 'fixed-integration-token-123';

const mockIsVosAuthEnabled = jest.fn(() => true);
const mockAuthenticateVosToken = jest.fn();

jest.mock('../services/vosAuthService.js', () => ({
  isVosAuthEnabled: () => mockIsVosAuthEnabled(),
  authenticateVosToken: (...args: any[]) => mockAuthenticateVosToken(...args),
}));

jest.mock('../dao/index.js', () => ({
  getUserDao: () => ({ findByUsername: async () => null }),
  getBearerKeyDao: () => ({ findEnabled: async () => [] }),
  getSystemConfigDao: () => ({ get: async () => null }),
}));
jest.mock('../utils/systemConfigCache.js', () => ({ getCachedSystemConfig: () => null }));
jest.mock('../config/index.js', () => ({
  __esModule: true,
  default: { readonly: false, basePath: '' },
  loadSettings: () => ({}),
}));
jest.mock('../config/jwt.js', () => ({ JWT_SECRET: 'test-secret' }));
jest.mock('../services/betterAuthConfig.js', () => ({ getBetterAuthRuntimeConfig: async () => ({ enabled: false }) }));

import express from 'express';
import request from 'supertest';
import { auth } from './auth.js';

const INTEGRATION_TOKEN = 'fixed-integration-token-123';

const makeApp = () => {
  const app = express();
  // Real deployment mounts the API router at `${basePath}/api`; req.baseUrl
  // must be `/api` for isDashboardApiRequest() to recognize the route.
  const api = express.Router();
  api.get('/integration/discovery', auth, (req, res) => {
    res.json({ success: true, user: (req as any).user });
  });
  app.use('/api', api);
  app.get('/mcp/tools', auth, (_req, res) => res.json({ success: true }));
  return app;
};

describe('auth integration token in VOS mode', () => {
  const original = process.env.MCPHUB_INTEGRATION_TOKEN;

  beforeAll(() => {
    process.env.MCPHUB_INTEGRATION_TOKEN = INTEGRATION_TOKEN;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.MCPHUB_INTEGRATION_TOKEN;
    else process.env.MCPHUB_INTEGRATION_TOKEN = original;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsVosAuthEnabled.mockReturnValue(true);
  });

  it('accepts the static integration token on dashboard API without VOS validation', async () => {
    const res = await request(makeApp())
      .get('/api/integration/discovery')
      .set('Authorization', `Bearer ${INTEGRATION_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.user.isAdmin).toBe(true);
    expect(res.body.user.username).toBe('integration');
    expect(mockAuthenticateVosToken).not.toHaveBeenCalled();
  });

  it('does not accept the integration token on MCP tool routes', async () => {
    // Non-matching routes fall through to VOS validation; real authenticateVosToken
    // throws on an invalid VOS token, which the middleware turns into 401.
    mockAuthenticateVosToken.mockRejectedValueOnce(new Error('invalid VOS token'));
    const res = await request(makeApp())
      .get('/mcp/tools')
      .set('Authorization', `Bearer ${INTEGRATION_TOKEN}`);
    expect(res.status).toBe(401);
    expect(mockAuthenticateVosToken).toHaveBeenCalled();
  });

  it('falls back to VOS validation for a non-matching token', async () => {
    mockAuthenticateVosToken.mockResolvedValueOnce({ sub: 'vos-user', isAdmin: false });
    const res = await request(makeApp())
      .get('/api/integration/discovery')
      .set('Authorization', 'Bearer some-vos-token');
    expect(res.status).toBe(200);
    expect(mockAuthenticateVosToken).toHaveBeenCalled();
  });
});
