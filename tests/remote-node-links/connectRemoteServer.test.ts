import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const TOKEN = 'peer-bearer-key-0123456789abcdef';

const addServer = jest.fn();
const toggleServerStatus = jest.fn();
const findById = jest.fn();
const findByName = jest.fn();
const updateServers = jest.fn();
const getRemoteNodeInternal = jest.fn();
const resolveDataPlaneToken = jest.fn();
const clearServerCapabilitiesCache = jest.fn();

jest.mock('../../src/services/nodeCredentialStore.js', () => ({
  dataPlaneEnvNameOf: (id: string) =>
    `MCP_NODE_DATA_PLANE_TOKEN_${id.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`,
  resolveDataPlaneToken: (...args: unknown[]) => resolveDataPlaneToken(...args),
}));

jest.mock('../../src/services/remoteNodeService.js', () => {
  class RemoteNodeError extends Error {
    status: number;
    constructor(message: string, status = 502) {
      super(message);
      this.status = status;
    }
  }
  return {
    RemoteNodeError,
    getRemoteNodeInternal: (...args: unknown[]) => getRemoteNodeInternal(...args),
  };
});

jest.mock('../../src/services/remoteServerBindingService.js', () => ({
  checkRemoteServerAddress: async () => ({ reachable: true }),
  getRemoteServerBinding: () => ({
    id: 'b1',
    serverName: 'demo',
    address: 'http://10.0.0.2:31889/mcp/demo',
  }),
  updateRemoteServerBinding: jest.fn(() => ({
    id: 'b1',
    serverName: 'demo',
    address: 'http://10.0.0.2:31889/mcp/demo',
  })),
}));

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => ({ findById: (...args: unknown[]) => findById(...args), update: jest.fn() }),
  getGroupDao: () => ({
    findByName: (...args: unknown[]) => findByName(...args),
    create: jest.fn(),
    updateServers: (...args: unknown[]) => updateServers(...args),
  }),
}));

jest.mock('../../src/services/mcpService.js', () => ({
  addServer: (...args: unknown[]) => addServer(...args),
  toggleServerStatus: (...args: unknown[]) => toggleServerStatus(...args),
  notifyToolChanged: async () => undefined,
  clearServerCapabilitiesCache: (...args: unknown[]) => clearServerCapabilitiesCache(...args),
  broadcastToolListChanged: jest.fn(),
  broadcastPromptListChanged: jest.fn(),
  broadcastResourceListChanged: jest.fn(),
}));

import {
  connectRemoteServer,
  disconnectRemoteServer,
} from '../../src/services/remoteServerRegistrationService.js';

const node = () => ({ id: 'node-b', name: 'node-b', address: '10.0.0.2' });

beforeEach(() => {
  jest.clearAllMocks();
  resolveDataPlaneToken.mockResolvedValue(TOKEN);
  findById.mockResolvedValue(undefined);
  findByName.mockResolvedValue({ id: 'g1', servers: [] });
  addServer.mockResolvedValue({ success: true });
  toggleServerStatus.mockResolvedValue({ success: true });
  getRemoteNodeInternal.mockImplementation(() => node());
});

describe('connectRemoteServer data plane', () => {
  it('persists only a runtime reference for a newly created upstream', async () => {
    const result = await connectRemoteServer('node-b', 'demo');

    expect(result).toMatchObject({ serverName: 'demo@node-b', created: true });
    expect(addServer).toHaveBeenCalledTimes(1);
    const [name, config] = addServer.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('demo@node-b');
    expect(config.dataPlaneNodeId).toBe('node-b');
    expect(config.dataPlaneTokenEnv).toBe('MCP_NODE_DATA_PLANE_TOKEN_NODE_B');
    expect(config.headers).toEqual({ Authorization: 'Bearer ${MCP_NODE_DATA_PLANE_TOKEN_NODE_B}' });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(config).not.toHaveProperty('forwardVosToken');
    expect(toggleServerStatus).toHaveBeenCalledWith('demo@node-b', true);
  });

  it('fails with 500 when the new upstream cannot be enabled', async () => {
    toggleServerStatus.mockResolvedValue({ success: false, message: 'upstream exploded' });

    await expect(connectRemoteServer('node-b', 'demo')).rejects.toMatchObject({
      status: 500,
      message: 'upstream exploded',
    });
  });

  it('refuses to register an upstream without any credential source', async () => {
    resolveDataPlaneToken.mockResolvedValue(undefined);

    await expect(connectRemoteServer('node-b', 'demo')).rejects.toMatchObject({ status: 400 });
    expect(addServer).not.toHaveBeenCalled();
  });

  it('also starts an existing upstream that was only updated', async () => {
    findById.mockResolvedValue({ name: 'demo@node-b', enabled: false });

    await connectRemoteServer('node-b', 'demo');

    expect(addServer).not.toHaveBeenCalled();
    expect(toggleServerStatus).toHaveBeenCalledWith('demo@node-b', true);
  });

  it('clears cached capabilities on detach so stale tools disappear', async () => {
    findById.mockResolvedValue({ name: 'demo@node-b', enabled: true });

    await disconnectRemoteServer('node-b', 'demo');

    expect(toggleServerStatus).toHaveBeenCalledWith('demo@node-b', false);
    expect(clearServerCapabilitiesCache).toHaveBeenCalledWith('demo@node-b');
  });
});
