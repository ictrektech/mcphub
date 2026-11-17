import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindAll = jest.fn<() => Promise<any[]>>();
const mockCreate = jest.fn<(server: any) => Promise<any>>();
const mockUserFindAll = jest.fn<() => Promise<any[]>>();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: jest.fn(() => ({ findAll: mockFindAll, create: mockCreate })),
}));

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: jest.fn(() => ({ findAll: mockUserFindAll })),
}));

jest.mock('../../src/utils/logger.js', () => ({
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  BUILTIN_GITEA_SERVER_NAME,
  ensureBuiltinGiteaServer,
  isForwardingServerAvailable,
  isUpstreamReachable,
} from '../../src/services/builtinServerProvisioning.js';

const originalFetch = globalThis.fetch;

const respondWith = (status: number) =>
  jest.fn(async () => ({
    status,
    body: { cancel: jest.fn(async () => undefined) },
  })) as unknown as typeof fetch;

describe('built-in server provisioning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindAll.mockResolvedValue([]);
    mockCreate.mockImplementation(async (server: any) => server);
    mockUserFindAll.mockResolvedValue([{ username: 'owner-user', isAdmin: true }]);
    delete process.env.MCPHUB_BUILTIN_GITEA;
    delete process.env.MCPHUB_GITEA_MCP_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MCPHUB_BUILTIN_GITEA;
    delete process.env.MCPHUB_GITEA_MCP_URL;
  });

  it('treats any HTTP answer as reachable and only network failures as absent', async () => {
    globalThis.fetch = respondWith(401);
    await expect(isUpstreamReachable('http://gitea-mcp:8080/mcp')).resolves.toBe(true);

    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(isUpstreamReachable('http://gitea-mcp:8080/mcp')).resolves.toBe(false);
  });

  it('provisions a public forwarding server when Gitea answers', async () => {
    globalThis.fetch = respondWith(405);

    await expect(ensureBuiltinGiteaServer()).resolves.toBe(true);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const created = mockCreate.mock.calls[0][0] as any;
    expect(created).toMatchObject({
      name: BUILTIN_GITEA_SERVER_NAME,
      type: 'streamable-http',
      url: 'http://gitea-mcp:8080/mcp',
      forwardVosToken: true,
      enabled: true,
      visibility: 'public',
      owner: 'owner-user',
    });
    // No shared credential: the caller's token authenticates every request.
    expect(created.headers).toBeUndefined();
    expect(created.credentialTemplate).toBeUndefined();
  });

  it('honours MCPHUB_GITEA_MCP_URL', async () => {
    process.env.MCPHUB_GITEA_MCP_URL = 'http://custom-gitea:9000/app/mcp';
    globalThis.fetch = respondWith(401);

    await ensureBuiltinGiteaServer();

    expect((mockCreate.mock.calls[0][0] as any).url).toBe(
      'http://custom-gitea:9000/app/mcp',
    );
  });

  it('stays silent when the Gitea app is not deployed', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('getaddrinfo EAI_AGAIN gitea-mcp');
    }) as unknown as typeof fetch;

    await expect(ensureBuiltinGiteaServer()).resolves.toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('never overwrites an existing entry', async () => {
    mockFindAll.mockResolvedValue([{ name: BUILTIN_GITEA_SERVER_NAME }]);
    globalThis.fetch = respondWith(200);

    await expect(ensureBuiltinGiteaServer()).resolves.toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('can be switched off for a deployment', async () => {
    process.env.MCPHUB_BUILTIN_GITEA = 'false';
    globalThis.fetch = respondWith(200);

    await expect(ensureBuiltinGiteaServer()).resolves.toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('hides a forwarding server whose upstream disappeared', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(isForwardingServerAvailable('gitea', 'http://gitea-mcp:8080/mcp')).resolves.toBe(
      false,
    );

    globalThis.fetch = respondWith(401);
    await expect(isForwardingServerAvailable('gitea', 'http://gitea-mcp:8080/mcp')).resolves.toBe(
      true,
    );
    await expect(isForwardingServerAvailable('gitea', undefined)).resolves.toBe(false);
  });
});
