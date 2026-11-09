import { webcrypto } from 'node:crypto';
jest.mock('../../frontend/src/utils/runtime', () => ({
  getRuntimeConfig: () => ({ vosAuthEnabled: true }),
  getApiUrl: (path: string) => `/app/com.ictrek.mcphub/api${path}`,
}));
const oldWindow = global.window;
const oldFetch = global.fetch;
let authorize: jest.Mock;
let token: jest.Mock;
let getUser: jest.Mock;
let login: jest.Mock;
beforeEach(() => {
  jest.resetModules();
  authorize = jest.fn(async (params) => ({ code: 'auth-code', state: params.state }));
  token = jest.fn(async () => ({
    access_token: 'platform-token',
    expires_in: 3600,
    refresh_token: 'refresh-token',
  }));
  getUser = jest.fn(async () => ({ sub: 'subject-a' }));
  login = jest.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, user: { username: 'verified-user', isAdmin: false } }),
  }));
  global.fetch = login;
  global.window = {
    vos_platform: { api: { v1000: { oauth2: { authorize, token } } }, platform: { getUser } },
    location: { reload: jest.fn() },
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true });
});
afterAll(() => {
  global.window = oldWindow;
  global.fetch = oldFetch;
});
it('uses PKCE and deduplicates concurrent login without browser token storage', async () => {
  const { getVosSession } = await import('../../frontend/src/services/vosAuthService');
  const sessions = await Promise.all([getVosSession(), getVosSession()]);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(authorize.mock.calls[0][0]).toEqual(
    expect.objectContaining({ client_id: 'com.ictrek.mcphub', code_challenge_method: 'S256' }),
  );
  expect(token.mock.calls[0][0]).toEqual(
    expect.objectContaining({
      grant_type: 'authorization_code',
      code_verifier: expect.any(String),
    }),
  );
  expect(sessions[0]?.user.username).toBe('verified-user');
  expect(login).toHaveBeenCalledWith(
    '/app/com.ictrek.mcphub/api/auth/vos',
    expect.objectContaining({ headers: { Authorization: 'Bearer platform-token' } }),
  );
});
it('rejects mismatched state before exchanging the authorization code', async () => {
  authorize.mockResolvedValue({ code: 'bad-code', state: 'wrong-state' });
  const { getVosSession } = await import('../../frontend/src/services/vosAuthService');
  await expect(getVosSession()).rejects.toThrow('state mismatch');
  expect(token).not.toHaveBeenCalled();
});
it('rejects a disabled user or unavailable verifier', async () => {
  login.mockResolvedValue({ ok: false });
  const { getVosSession } = await import('../../frontend/src/services/vosAuthService');
  await expect(getVosSession()).rejects.toThrow('rejected');
});
it('clears the previous page before using a switched platform identity', async () => {
  const { getVosSession } = await import('../../frontend/src/services/vosAuthService');
  await getVosSession();
  getUser.mockResolvedValue({ sub: 'subject-b' });
  await expect(getVosSession()).rejects.toThrow('session changed');
  expect(window.location.reload).toHaveBeenCalledTimes(1);
  expect(login).toHaveBeenCalledTimes(1);
});
it('never finishes a stale login after logout', async () => {
  const { getVosSession, clearVosSession } = await import(
    '../../frontend/src/services/vosAuthService'
  );
  let finish!: (value: unknown) => void;
  login.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = getVosSession();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  clearVosSession();
  finish({ ok: true, json: async () => ({ success: true, user: { username: 'old-user' } }) });
  await expect(pending).rejects.toThrow('session changed');
});
