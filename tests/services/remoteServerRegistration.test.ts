const mockSettings: { value: any } = {
  value: {
    mcpServers: {},
    remoteNodes: [{ id: 'node-1', name: '192 orin nx', profile: 'jetson-orin' }],
  },
};

jest.mock('../../src/config/index.js', () => ({
  loadOriginalSettings: jest.fn(() => mockSettings.value),
  saveSettings: jest.fn((next: any) => {
    mockSettings.value = next;
    return true;
  }),
}));

const mockReachable = jest.fn(async () => true);
jest.mock('../../src/services/builtinServerProvisioning.js', () => ({
  isUpstreamReachable: (...args: any[]) => mockReachable(...args),
}));

const mockServers: any[] = [];
const mockGroups: any[] = [];

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => ({
    findById: async (name: string) => mockServers.find((server) => server.name === name) ?? null,
    findAll: async () => [...mockServers],
    update: async (name: string, updates: any) => {
      const server = mockServers.find((item) => item.name === name);
      if (server) Object.assign(server, updates);
      return server ?? null;
    },
    delete: async (name: string) => {
      const index = mockServers.findIndex((server) => server.name === name);
      if (index >= 0) mockServers.splice(index, 1);
      return true;
    },
  }),
  getGroupDao: () => ({
    findByName: async (name: string) => mockGroups.find((group) => group.name === name) ?? null,
    create: async (group: any) => {
      const created = { ...group, id: `g-${mockGroups.length}` };
      mockGroups.push(created);
      return created;
    },
    updateServers: async (id: string, servers: string[]) => {
      const group = mockGroups.find((item) => item.id === id);
      if (group) group.servers = servers;
      return true;
    },
  }),
}));

const mockNotifyToolChanged = jest.fn(async () => undefined);
const mockToggleServerStatus = jest.fn(async (name: string, enabled: boolean) => {
  const server = mockServers.find((item) => item.name === name);
  if (server) server.enabled = enabled;
  return { success: true, message: 'ok' };
});
const mockRemoveServer = jest.fn(async (name: string) => {
  const index = mockServers.findIndex((server) => server.name === name);
  if (index >= 0) mockServers.splice(index, 1);
  return { success: true };
});
const mockBroadcastTool = jest.fn();
const mockBroadcastPrompt = jest.fn();
const mockBroadcastResource = jest.fn();

jest.mock('../../src/services/mcpService.js', () => ({
  addServer: async (name: string, config: any) => {
    mockServers.push({ name, ...config });
    return { success: true };
  },
  notifyToolChanged: (...args: any[]) => mockNotifyToolChanged(...args),
  toggleServerStatus: (...args: any[]) => mockToggleServerStatus(...args),
  removeServer: (...args: any[]) => mockRemoveServer(...args),
  broadcastToolListChanged: () => mockBroadcastTool(),
  broadcastPromptListChanged: () => mockBroadcastPrompt(),
  broadcastResourceListChanged: () => mockBroadcastResource(),
}));

import {
  checkRemoteServerAddress,
  createRemoteServerBinding,
  listRemoteServerBindings,
} from '../../src/services/remoteServerBindingService.js';
import {
  connectRemoteServer,
  disconnectRemoteServer,
  remoteGroupName,
  remoteServerLocalName,
  removeRemoteServer,
} from '../../src/services/remoteServerRegistrationService.js';

describe('remote node MCP service registration (P1)', () => {
  beforeEach(() => {
    mockSettings.value = {
      mcpServers: {},
      remoteNodes: [{ id: 'node-1', name: '192 orin nx', profile: 'jetson-orin' }],
    };
    mockServers.length = 0;
    mockGroups.length = 0;
    mockReachable.mockReset();
    mockReachable.mockResolvedValue(true);
    mockNotifyToolChanged.mockReset();
    mockToggleServerStatus.mockReset();
    mockToggleServerStatus.mockImplementation(async (name: string, enabled: boolean) => {
      const server = mockServers.find((item) => item.name === name);
      if (server) server.enabled = enabled;
      return { success: true, message: 'ok' };
    });
    mockRemoveServer.mockReset();
    mockBroadcastTool.mockReset();
    mockBroadcastPrompt.mockReset();
    mockBroadcastResource.mockReset();
  });

  it('names upstreams by service and node, and groups by node', () => {
    expect(remoteServerLocalName('amap', '192 orin nx')).toBe('amap@192-orin-nx');
    expect(remoteGroupName('192 orin nx')).toBe('远程节点 · 192 orin nx');
  });

  it('registers a binding with reachability state and no credentials', async () => {
    const binding = await createRemoteServerBinding({
      schedulerNodeId: 'node-1',
      serverName: 'amap',
      address: 'http://10.144.144.192:8080/mcp/',
    });
    expect(binding).toMatchObject({
      serverName: 'amap',
      schedulerNodeId: 'node-1',
      address: 'http://10.144.144.192:8080/mcp',
      profile: 'jetson-orin',
      reachable: true,
    });
    expect(binding).not.toHaveProperty('token');
    expect(listRemoteServerBindings('node-1')).toHaveLength(1);
  });

  it('rejects duplicate service names on the same node', async () => {
    await createRemoteServerBinding({ schedulerNodeId: 'node-1', serverName: 'amap', address: 'http://10.0.0.1:8080/mcp' });
    await expect(createRemoteServerBinding({
      schedulerNodeId: 'node-1', serverName: 'amap', address: 'http://10.0.0.2:8080/mcp',
    })).rejects.toThrow(/already exists/);
  });

  it('connects a registered service as a streamable-http upstream and loads tools', async () => {
    await createRemoteServerBinding({
      schedulerNodeId: 'node-1', serverName: 'amap', address: 'http://10.144.144.192:8080/mcp',
    });
    const result = await connectRemoteServer('node-1', 'amap');
    expect(result).toMatchObject({
      serverName: 'amap@192-orin-nx',
      groupName: '远程节点 · 192 orin nx',
      created: true,
    });
    expect(mockServers[0]).toMatchObject({
      name: 'amap@192-orin-nx',
      type: 'streamable-http',
      url: 'http://10.144.144.192:8080/mcp',
      enabled: true,
      owner: 'admin',
      visibility: 'public',
      nodeId: 'node-1',
      nodeName: '192 orin nx',
      nodeProfile: 'jetson-orin',
    });
    expect(mockGroups[0].servers).toContain('amap@192-orin-nx');
    expect(mockNotifyToolChanged).toHaveBeenCalledWith('amap@192-orin-nx', { reportEmbeddingProgress: true });
  });

  it('blocks connection when the registered address is unreachable', async () => {
    await createRemoteServerBinding({
      schedulerNodeId: 'node-1', serverName: 'amap', address: 'http://10.144.144.192:8080/mcp',
    });
    mockReachable.mockResolvedValue(false);
    await expect(connectRemoteServer('node-1', 'amap')).rejects.toThrow(/unreachable/);
    expect(mockServers).toHaveLength(0);
  });

  it('disconnects and removes the upstream without touching the node', async () => {
    await createRemoteServerBinding({
      schedulerNodeId: 'node-1', serverName: 'amap', address: 'http://10.144.144.192:8080/mcp',
    });
    await connectRemoteServer('node-1', 'amap');
    await disconnectRemoteServer('node-1', 'amap');
    expect(mockToggleServerStatus).toHaveBeenCalledWith('amap@192-orin-nx', false);
    expect(mockBroadcastTool).toHaveBeenCalled();
    await removeRemoteServer('node-1', 'amap');
    expect(mockRemoveServer).toHaveBeenCalledWith('amap@192-orin-nx');
    expect(mockGroups[0].servers).not.toContain('amap@192-orin-nx');
  });

  it('updates reachability when probed again', async () => {
    await createRemoteServerBinding({
      schedulerNodeId: 'node-1', serverName: 'amap', address: 'http://10.144.144.192:8080/mcp',
    });
    mockReachable.mockResolvedValue(false);
    const binding = listRemoteServerBindings('node-1')[0];
    const checked = await checkRemoteServerAddress(binding);
    expect(checked.reachable).toBe(false);
    expect(checked.lastError).toMatch(/unreachable/);
  });
});
