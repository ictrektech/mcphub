// Set before importing the service: scheduler config is read at module load.
process.env.MCPHUB_VSCHEDULER_URL = 'http://scheduler:38120/';
process.env.MCPHUB_VSCHEDULER_TOKEN = 'admin-token';
process.env.MCPHUB_REMOTE_PORT = '31888';

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
  discoverNodesFromScheduler,
  importDiscoveredNodes,
  type DiscoveredNodeView,
} from '../../src/services/remoteNodeService.js';

const schedulerPayload = {
  code: 'OK',
  data: {
    items: [
      {
        id: '01M83P7ATQBYZPPRQ3EDE6CHSA',
        name: '192 orin nx',
        host: '10.144.144.192',
        arch: 'aarch64',
        profile: 'jetson-orin',
        detected_profile: 'jetson-orin',
        status: 'online',
        gpu_model: 'Orin (nvgpu)',
      },
      { id: 'no-host', name: 'invalid', status: 'offline' },
    ],
  },
};

describe('V-Scheduler node discovery', () => {
  const originalUrl = process.env.MCPHUB_VSCHEDULER_URL;
  const originalToken = process.env.MCPHUB_VSCHEDULER_TOKEN;

  beforeAll(() => {
    process.env.MCPHUB_VSCHEDULER_URL = 'http://scheduler:38120/';
    process.env.MCPHUB_VSCHEDULER_TOKEN = 'admin-token';
  });
  afterAll(() => {
    if (originalUrl === undefined) delete process.env.MCPHUB_VSCHEDULER_URL;
    else process.env.MCPHUB_VSCHEDULER_URL = originalUrl;
    if (originalToken === undefined) delete process.env.MCPHUB_VSCHEDULER_TOKEN;
    else process.env.MCPHUB_VSCHEDULER_TOKEN = originalToken;
  });
  beforeEach(() => {
    mockSettings.value = { mcpServers: {} };
    mockFetch.mockReset();
  });

  it('surfaces scheduler HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(discoverNodesFromScheduler()).rejects.toThrow(/HTTP 401/);
  });

  it('maps host + profile into a ready-to-import node and skips hostless rows', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(schedulerPayload),
    });
    const nodes = await discoverNodesFromScheduler();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: '01M83P7ATQBYZPPRQ3EDE6CHSA',
      name: '192 orin nx',
      host: '10.144.144.192',
      profile: 'jetson-orin',
      status: 'online',
      baseUrl: 'http://10.144.144.192:31888/app/com.ictrek.mcphub',
      alreadyManaged: false,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://scheduler:38120/api/v1/managed-nodes');
    expect(init.headers.authorization).toBe('Bearer admin-token');
  });

  it('imports selected discovered nodes with the integration token and auto profile', () => {
    const discovered: DiscoveredNodeView[] = [{
      id: 'node-1', name: 'Orin', host: '10.144.144.192',
      baseUrl: 'http://10.144.144.192:31888/app/com.ictrek.mcphub',
      profile: 'jetson-orin', status: 'online', alreadyManaged: false,
    }];
    const views = importDiscoveredNodes(['node-1'], discovered, 'integration-token');
    expect(views).toHaveLength(1);
    expect(views[0].profile).toBe('jetson-orin');
    expect(views[0].hasToken).toBe(true);
    expect(views[0]).not.toHaveProperty('token');
    expect(mockSettings.value.remoteNodes[0]).toMatchObject({
      id: 'node-1',
      baseUrl: 'http://10.144.144.192:31888/app/com.ictrek.mcphub',
      profile: 'jetson-orin',
      token: 'integration-token',
      enabled: true,
    });
  });

  it('marks already-managed nodes on a second discovery', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve(schedulerPayload),
    });
    importDiscoveredNodes(
      ['01M83P7ATQBYZPPRQ3EDE6CHSA'],
      [{ id: '01M83P7ATQBYZPPRQ3EDE6CHSA', name: '192 orin nx', host: '10.144.144.192',
         baseUrl: 'http://10.144.144.192:31888/app/com.ictrek.mcphub', alreadyManaged: false }],
      'tok',
    );
    const nodes = await discoverNodesFromScheduler();
    expect(nodes[0].alreadyManaged).toBe(true);
  });
});
