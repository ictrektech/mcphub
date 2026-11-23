// Set before import: the service reads the remote port at module load.
process.env.MCPHUB_REMOTE_PORT = '31888';

const mockServers: any[] = [];
const mockGroups: any[] = [];

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => ({
    findAll: async () => [...mockServers],
    create: async (server: any) => { mockServers.push(server); return server; },
    delete: async (name: string) => {
      const i = mockServers.findIndex((s) => s.name === name);
      if (i >= 0) mockServers.splice(i, 1);
      return true;
    },
  }),
  getGroupDao: () => ({
    findByName: async (name: string) => mockGroups.find((g) => g.name === name) ?? null,
    create: async (group: any) => { const g = { ...group, id: 'g-' + mockGroups.length }; mockGroups.push(g); return g; },
    updateServers: async (id: string, servers: string[]) => {
      const g = mockGroups.find((x) => x.id === id);
      if (g) g.servers = servers;
      return true;
    },
  }),
}));

const mockRegisterAllTools = jest.fn();
jest.mock('../../src/services/mcpService.js', () => ({
  registerAllTools: (...args: any[]) => mockRegisterAllTools(...args),
}));

import {
  remoteServerLocalName,
  remoteGroupName,
  registerRemoteServer,
} from '../../src/services/remoteServerRegistrationService.js';

describe('remote server registration', () => {
  beforeEach(() => {
    mockServers.length = 0;
    mockGroups.length = 0;
    mockRegisterAllTools.mockReset();
    process.env.MCPHUB_REMOTE_PORT = '31888';
  });

  it('names servers by node and groups by node', () => {
    expect(remoteServerLocalName('amap', '192 orin nx')).toBe('amap@192-orin-nx');
    expect(remoteGroupName('192 orin nx')).toBe('远程节点 · 192 orin nx');
  });

  it('registers a streamable-http upstream with the integration token and a group', async () => {
    const result = await registerRemoteServer({
      name: 'amap', nodeId: 'n1', nodeName: '192 orin nx',
      host: '10.144.144.192', profile: 'jetson-orin', token: 'int-token',
    });
    expect(result).toMatchObject({ serverName: 'amap@192-orin-nx', created: true });
    expect(mockServers[0]).toMatchObject({
      name: 'amap@192-orin-nx',
      type: 'streamable-http',
      url: 'http://10.144.144.192:31888/app/com.ictrek.mcphub/mcp/amap',
      headers: { authorization: 'Bearer int-token' },
      visibility: 'public',
    });
    expect(mockGroups[0].name).toBe('远程节点 · 192 orin nx');
    expect(mockGroups[0].servers).toContain('amap@192-orin-nx');
    expect(mockRegisterAllTools).toHaveBeenCalledWith(false, 'amap@192-orin-nx');
  });

  it('does not duplicate an already-registered server but adds it to the group', async () => {
    await registerRemoteServer({
      name: 'amap', nodeId: 'n1', nodeName: '192 orin nx', host: '10.144.144.192', token: 't',
    });
    const second = await registerRemoteServer({
      name: 'amap', nodeId: 'n1', nodeName: '192 orin nx', host: '10.144.144.192', token: 't',
    });
    expect(second.created).toBe(false);
    expect(mockServers).toHaveLength(1);
    expect(mockGroups[0].servers.filter((s: string) => s === 'amap@192-orin-nx')).toHaveLength(1);
  });
});
