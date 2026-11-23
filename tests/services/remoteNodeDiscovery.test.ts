// Set before importing the service: scheduler URL is read at module load.
process.env.V_SCHEDULER_URL = 'http://scheduler:8080/';
delete process.env.MCPHUB_VSCHEDULER_TOKEN;

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

const USER_TOKEN = 'vos-user-token';

describe('V-Scheduler compute node discovery (P0)', () => {
  const originalUrl = process.env.V_SCHEDULER_URL;

  beforeAll(() => {
    process.env.V_SCHEDULER_URL = 'http://scheduler:8080/';
  });
  afterAll(() => {
    if (originalUrl === undefined) delete process.env.V_SCHEDULER_URL;
    else process.env.V_SCHEDULER_URL = originalUrl;
  });
  beforeEach(() => {
    mockSettings.value = { mcpServers: {} };
    mockFetch.mockReset();
  });

  it('requires the current user VOS token', async () => {
    await expect(discoverNodesFromScheduler('')).rejects.toThrow(/VOS user token is required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces scheduler HTTP errors', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(discoverNodesFromScheduler(USER_TOKEN)).rejects.toThrow(/HTTP 401/);
  });

  it('maps submitter address/hostname and forwards the user token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(schedulerPayload),
    });
    const nodes = await discoverNodesFromScheduler(USER_TOKEN);
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
    expect(url).toBe('http://scheduler:8080/scheduler/api/v1/managed-nodes');
    expect(init.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
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
    const nodes = await discoverNodesFromScheduler(USER_TOKEN);
    expect(nodes[0].alreadyManaged).toBe(true);
  });
});
