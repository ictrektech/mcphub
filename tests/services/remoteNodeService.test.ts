const mockSettings: { value: any } = { value: { mcpServers: {} } };

jest.mock('../../src/config/index.js', () => ({
  loadOriginalSettings: jest.fn(() => mockSettings.value),
  saveSettings: jest.fn((next: any) => {
    mockSettings.value = next;
    return true;
  }),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  RemoteNodeError,
  createRemoteNode,
  deleteRemoteNode,
  discoverRemoteServers,
  listRemoteNodes,
  toggleRemoteServer,
  updateRemoteNode,
} from '../../src/services/remoteNodeService.js';

const okJson = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ success: true, data })),
  } as Response);

describe('remoteNodeService', () => {
  beforeEach(() => {
    mockSettings.value = { mcpServers: {} };
    mockFetch.mockReset();
  });

  it('creates a node, persists the token, and hides it in views', () => {
    const view = createRemoteNode({
      id: 'node-a',
      name: 'Node A',
      baseUrl: 'http://host:3000/app/com.ictrek.mcphub/',
      token: 'secret-token',
      profile: 'amd-cuda',
      enabled: true,
    });
    expect(view.hasToken).toBe(true);
    expect(view).not.toHaveProperty('token');
    expect(view.baseUrl).toBe('http://host:3000/app/com.ictrek.mcphub');
    expect(mockSettings.value.remoteNodes[0].token).toBe('secret-token');
  });

  it('rejects invalid URLs and duplicate ids', () => {
    expect(() => createRemoteNode({ id: 'x', name: 'X', baseUrl: 'ftp://bad' })).toThrow(RemoteNodeError);
    createRemoteNode({ id: 'x', name: 'X', baseUrl: 'http://a:3000' });
    expect(() => createRemoteNode({ id: 'x', name: 'X', baseUrl: 'http://b:3000' })).toThrow(/already exists/);
  });

  it('keeps the stored token when an update leaves it blank', () => {
    createRemoteNode({ id: 'n', name: 'N', baseUrl: 'http://a:3000', token: 'keep-me' });
    const view = updateRemoteNode('n', { name: 'Renamed', token: '' });
    expect(view.name).toBe('Renamed');
    expect(view.hasToken).toBe(true);
    expect(mockSettings.value.remoteNodes[0].token).toBe('keep-me');
  });

  it('discovers servers with bearer auth and maps mcp_path', async () => {
    createRemoteNode({ id: 'n', name: 'N', baseUrl: 'http://a:3000/base', token: 'tok' });
    mockFetch.mockImplementation(() =>
      okJson({ servers: [{ name: 'amap', description: 'map', visibility: 'public', status: 'connected', mcp_path: '/base/mcp/amap' }] }),
    );
    const servers = await discoverRemoteServers('n');
    expect(servers).toHaveLength(1);
    expect(servers[0].mcpPath).toBe('/base/mcp/amap');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://a:3000/base/api/integration/discovery');
    expect(init.headers.authorization).toBe('Bearer tok');
  });

  it('toggles a remote server with the expected method and body', async () => {
    createRemoteNode({ id: 'n', name: 'N', baseUrl: 'http://a:3000' });
    mockFetch.mockImplementation(() => okJson({}));
    await toggleRemoteServer('n', 'amap', false);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://a:3000/api/servers/amap/toggle');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('removes nodes and never returns them in listings', () => {
    createRemoteNode({ id: 'n1', name: 'One', baseUrl: 'http://a:3000' });
    createRemoteNode({ id: 'n2', name: 'Two', baseUrl: 'http://b:3000' });
    deleteRemoteNode('n1');
    expect(listRemoteNodes().map((n) => n.id)).toEqual(['n2']);
    expect(() => deleteRemoteNode('missing')).toThrow(/not found/);
  });
});
