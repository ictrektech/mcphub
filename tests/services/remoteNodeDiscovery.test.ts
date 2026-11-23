// Set before importing the service: scheduler config is read at module load.
process.env.MCPHUB_VSCHEDULER_URL = 'http://scheduler:38120/';
process.env.MCPHUB_VSCHEDULER_TOKEN = 'submitter-token';

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
  createRemoteNode,
  deleteRemoteNode,
  discoverNodesFromScheduler,
  importDiscoveredNodes,
  listRemoteNodes,
  updateRemoteNode,
  type DiscoveredNodeView,
} from '../../src/services/remoteNodeService.js';

const schedulerPayload = {
  code: 'OK',
  data: {
    items: [
      {
        id: 'node-orin',
        name: '192 orin nx',
        address: '10.144.144.192',
        hostname: 'orin.local',
        arch: 'aarch64',
        profile: 'jetson-orin',
        compatible_profiles: ['jetson-orin'],
        status: 'online',
        gpu_model: 'Orin (nvgpu)',
        last_checked_at: '2026-11-23T10:00:00Z',
      },
      { id: 'no-address', name: 'invalid', status: 'offline' },
    ],
  },
};

describe('V-Scheduler compute node discovery (P0)', () => {
  const originalUrl = process.env.MCPHUB_VSCHEDULER_URL;
  const originalToken = process.env.MCPHUB_VSCHEDULER_TOKEN;

  beforeAll(() => {
    process.env.MCPHUB_VSCHEDULER_URL = 'http://scheduler:38120/';
    process.env.MCPHUB_VSCHEDULER_TOKEN = 'submitter-token';
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

  it('maps submitter address/hostname and skips addressless rows', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(schedulerPayload),
    });
    const nodes = await discoverNodesFromScheduler();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: 'node-orin',
      schedulerNodeId: 'node-orin',
      name: '192 orin nx',
      address: '10.144.144.192',
      hostname: 'orin.local',
      profile: 'jetson-orin',
      compatibleProfiles: ['jetson-orin'],
      status: 'online',
      gpuModel: 'Orin (nvgpu)',
      alreadyManaged: false,
    });
    expect(nodes[0]).not.toHaveProperty('baseUrl');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://scheduler:38120/api/v1/managed-nodes');
    expect(init.headers.authorization).toBe('Bearer submitter-token');
  });

  it('imports selected nodes into the whitelist without credentials', () => {
    const discovered: DiscoveredNodeView[] = [{
      id: 'node-orin',
      schedulerNodeId: 'node-orin',
      name: 'Orin',
      address: '10.144.144.192',
      profile: 'jetson-orin',
      alreadyManaged: false,
    }];
    const imported = importDiscoveredNodes(['node-orin'], discovered);
    expect(imported).toHaveLength(1);
    expect(mockSettings.value.remoteNodes[0]).toMatchObject({
      id: 'node-orin',
      address: '10.144.144.192',
      profile: 'jetson-orin',
      enabled: true,
    });
    expect(mockSettings.value.remoteNodes[0]).not.toHaveProperty('token');
    expect(mockSettings.value.remoteNodes[0]).not.toHaveProperty('baseUrl');
  });

  it('supports manual whitelist CRUD', () => {
    createRemoteNode({ id: 'node-1', name: 'Orin', address: '10.0.0.1', profile: 'jetson-orin' });
    updateRemoteNode('node-1', { name: 'Orin NX', profile: 'jetson-orin' });
    expect(listRemoteNodes()).toMatchObject([{ id: 'node-1', name: 'Orin NX' }]);
    deleteRemoteNode('node-1');
    expect(listRemoteNodes()).toEqual([]);
  });

  it('marks already-managed nodes on a second discovery', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: () => Promise.resolve(schedulerPayload),
    });
    importDiscoveredNodes(['node-orin'], [{
      id: 'node-orin', schedulerNodeId: 'node-orin', name: 'Orin', address: '10.144.144.192', alreadyManaged: false,
    }]);
    const nodes = await discoverNodesFromScheduler();
    expect(nodes[0].alreadyManaged).toBe(true);
  });
});
