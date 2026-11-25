import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const TOKEN = 'peer-bearer-key-0123456789abcdef';

const getRemoteNodeInternal = jest.fn();
const listRemoteNodes = jest.fn();
const updateRemoteNode = jest.fn();
const connectRemoteServer = jest.fn();
const disconnectRemoteServer = jest.fn();
const listBindings = jest.fn();
const createBinding = jest.fn();
const httpsRequest = jest.fn();
const resolveDataPlaneToken = jest.fn();
const setCredential = jest.fn();
const deleteCredential = jest.fn();
const credentialStatus = jest.fn();

jest.mock('../../src/config/index.js', () => ({
  __esModule: true,
  default: { basePath: '/app/com.ictrek.mcphub' },
}));

jest.mock('../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('node:https', () => ({
  __esModule: true,
  default: { request: (...args: unknown[]) => httpsRequest(...args) },
}));

jest.mock('node:fs', () => ({ readFileSync: () => Buffer.from('cert') }));

jest.mock('../../src/services/nodeCredentialStore.js', () => ({
  resolveDataPlaneToken: (...args: unknown[]) => resolveDataPlaneToken(...args),
  setCredential: (...args: unknown[]) => setCredential(...args),
  deleteCredential: (...args: unknown[]) => deleteCredential(...args),
  credentialStatus: (...args: unknown[]) => credentialStatus(...args),
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
    listRemoteNodes: (...args: unknown[]) => listRemoteNodes(...args),
    updateRemoteNode: (...args: unknown[]) => updateRemoteNode(...args),
    createRemoteNode: jest.fn(),
    deleteRemoteNode: jest.fn(),
    discoverNodesFromScheduler: jest.fn(),
    importDiscoveredNodes: jest.fn(),
  };
});

jest.mock('../../src/services/remoteServerBindingService.js', () => ({
  checkRemoteServerAddress: async () => ({ reachable: true }),
  getRemoteServerBinding: () => ({ id: 'b1', serverName: 'demo' }),
  updateRemoteServerBinding: jest.fn(),
  listRemoteServerBindings: (...args: unknown[]) => listBindings(...args),
  createRemoteServerBinding: (...args: unknown[]) => createBinding(...args),
}));

jest.mock('../../src/services/remoteServerRegistrationService.js', () => ({
  connectRemoteServer: (...args: unknown[]) => connectRemoteServer(...args),
  disconnectRemoteServer: (...args: unknown[]) => disconnectRemoteServer(...args),
  remoteServerLocalName: (name: string, node: string) => `${name}@${node}`,
  removeRemoteServer: jest.fn(),
}));

import {
  attachNodeLinkServer,
  deleteNodeCredential,
  editRemoteNode,
  getNodeCredential,
  getRemoteNodes,
  putNodeCredential,
} from '../../src/controllers/remoteNodeController.js';

const node = () => ({ id: 'node-b', name: 'peer-b', address: '10.0.0.2' });

const resMock = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
};

const reqMock = (params: Record<string, string>, body: Record<string, unknown> = {}) =>
  ({ params, body, header: () => undefined, user: { username: 'admin', isAdmin: true } }) as unknown as Request;

const mockPeerResponse = () => {
  httpsRequest.mockImplementation((_options: unknown, callback: (stream: EventEmitter) => void) => {
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;
    callback(response);
    process.nextTick(() => {
      response.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            success: true,
            data: {
              servers: [
                {
                  name: 'demo',
                  type: 'stdio',
                  status: 'connected',
                  mcpPath: '/app/com.ictrek.mcphub/mcp/demo',
                },
              ],
            },
          }),
        ),
      );
      response.emit('end');
    });
    const outgoing = new EventEmitter() as EventEmitter & { end: jest.Mock };
    outgoing.end = jest.fn();
    return outgoing;
  });
};

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MCP_NODE_OPS_CLIENT_CERT = '/tmp/client.crt';
  process.env.MCP_NODE_OPS_CLIENT_KEY = '/tmp/client.key';
  process.env.MCP_NODE_OPS_CLIENT_CA = '/tmp/ca.pem';
  process.env.MCP_NODE_OPS_TOKEN = 'control-plane-token';
  delete process.env.MCP_NODE_DATA_SCHEME;
  delete process.env.MCP_NODE_DATA_PORT;
  getRemoteNodeInternal.mockImplementation(() => node());
  listRemoteNodes.mockReturnValue([node()]);
  listBindings.mockReturnValue([]);
  createBinding.mockResolvedValue({ id: 'b1', serverName: 'demo' });
  updateRemoteNode.mockImplementation((_id: string, patch: Record<string, unknown>) => ({
    ...node(),
    ...patch,
  }));
  resolveDataPlaneToken.mockResolvedValue(TOKEN);
  credentialStatus.mockResolvedValue({ configured: true, source: 'store' });
  setCredential.mockResolvedValue(undefined);
  deleteCredential.mockResolvedValue(undefined);
  connectRemoteServer.mockResolvedValue({ serverName: 'demo@peer-b', groupName: 'g', created: true });
  disconnectRemoteServer.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('node link attach', () => {
  it('returns 400 data-plane-token-required before touching the peer', async () => {
    resolveDataPlaneToken.mockResolvedValue(undefined);
    const res = resMock();

    await attachNodeLinkServer(reqMock({ nodeId: 'node-b', name: 'demo' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      success: false,
      code: 'data-plane-token-required',
    });
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(connectRemoteServer).not.toHaveBeenCalled();
  });

  it('builds an HTTPS data-plane URL by default', async () => {
    mockPeerResponse();
    const res = resMock();

    await attachNodeLinkServer(reqMock({ nodeId: 'node-b', name: 'demo' }), res);

    expect(createBinding).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'https://10.0.0.2:31891/app/com.ictrek.mcphub/mcp/demo' }),
    );
    expect(connectRemoteServer).toHaveBeenCalledWith('node-b', 'demo');
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('uses plain HTTP only when explicitly opted out', async () => {
    process.env.MCP_NODE_DATA_SCHEME = 'http';
    process.env.MCP_NODE_DATA_PORT = '31889';
    mockPeerResponse();

    await attachNodeLinkServer(reqMock({ nodeId: 'node-b', name: 'demo' }), resMock());

    expect(createBinding).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'http://10.0.0.2:31889/app/com.ictrek.mcphub/mcp/demo' }),
    );
  });
});

describe('runtime credential management', () => {
  it('stores the token by id and name and refreshes attached upstreams', async () => {
    listBindings.mockReturnValue([{ id: 'b1', serverName: 'demo', upstreamName: 'demo@peer-b' }]);
    const res = resMock();

    await putNodeCredential(reqMock({ nodeId: 'node-b' }, { token: TOKEN }), res);

    expect(setCredential).toHaveBeenCalledWith(node(), TOKEN);
    expect(disconnectRemoteServer).toHaveBeenCalledWith('node-b', 'demo');
    expect(connectRemoteServer).toHaveBeenCalledWith('node-b', 'demo');
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
      success: true,
      data: { configured: true, source: 'store' },
    });
  });

  it('rejects an empty token', async () => {
    const res = resMock();

    await putNodeCredential(reqMock({ nodeId: 'node-b' }, { token: '  ' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it('reports only configured/source and never the token', async () => {
    const res = resMock();

    await getNodeCredential(reqMock({ nodeId: 'node-b' }), res);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload).toEqual({ success: true, data: { configured: true, source: 'store' } });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it('deletes the stored token and detaches existing upstreams', async () => {
    listBindings.mockReturnValue([{ id: 'b1', serverName: 'demo', upstreamName: 'demo@peer-b' }]);
    credentialStatus.mockResolvedValue({ configured: false, source: null });
    const res = resMock();

    await deleteNodeCredential(reqMock({ nodeId: 'node-b' }), res);

    expect(deleteCredential).toHaveBeenCalledWith(node());
    expect(disconnectRemoteServer).toHaveBeenCalledWith('node-b', 'demo');
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
      success: true,
      data: { configured: false, source: null },
    });
  });

  it('never emits the key in node API responses or accepts it via node edit', async () => {
    const res = resMock();
    await getRemoteNodes(reqMock({}), res);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls[0][0])).not.toContain(TOKEN);

    await editRemoteNode(reqMock({ id: 'node-b' }, { name: 'node-b', dataPlaneToken: TOKEN }), resMock());
    expect(updateRemoteNode.mock.calls[0][1]).not.toHaveProperty('dataPlaneToken');
  });
});
