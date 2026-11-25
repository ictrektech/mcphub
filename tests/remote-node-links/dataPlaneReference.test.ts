import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ENV_NAME = 'MCP_NODE_DATA_PLANE_TOKEN_NODE_B';
const TOKEN = 'peer-bearer-key-0123456789abcdef';
const findByUsername = jest.fn();
const resolveDataPlaneToken = jest.fn();

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({ findByUsername: (...args: unknown[]) => findByUsername(...args) }),
}));

jest.mock('../../src/services/nodeCredentialStore.js', () => ({
  resolveDataPlaneToken: (...args: unknown[]) => resolveDataPlaneToken(...args),
}));

import { replaceEnvVars } from '../../src/config/index.js';
import {
  expandServerConfig,
  getServerEnvironment,
} from '../../src/services/serverConfigEnvironment.js';

const upstream = () => ({
  type: 'streamable-http' as const,
  url: 'http://10.0.0.2:31889/mcp/demo',
  owner: 'admin',
  visibility: 'public' as const,
  enabled: true,
  dataPlaneTokenEnv: ENV_NAME,
  dataPlaneNodeId: 'node-b',
  dataPlaneNodeName: 'peer-b',
  headers: { Authorization: 'Bearer ${MCP_NODE_DATA_PLANE_TOKEN_NODE_B}' },
});

beforeEach(() => {
  jest.clearAllMocks();
  resolveDataPlaneToken.mockResolvedValue(TOKEN);
  findByUsername.mockResolvedValue({ isAdmin: true });
});

describe('runtime data-plane credential reference', () => {
  it('keeps the placeholder in presented configs', async () => {
    const expanded = await expandServerConfig(upstream());

    expect(expanded.headers?.Authorization).toBe('Bearer ${MCP_NODE_DATA_PLANE_TOKEN_NODE_B}');
    expect(JSON.stringify(expanded)).not.toContain(TOKEN);
    expect(expanded.dataPlaneNodeId).toBe('node-b');
  });

  it('resolves the key by node id and name only at transport build time', async () => {
    const expanded = await expandServerConfig(upstream());
    const env = await getServerEnvironment(upstream());

    expect(resolveDataPlaneToken).toHaveBeenCalledWith({ id: 'node-b', name: 'peer-b' });
    expect(env[ENV_NAME]).toBe(TOKEN);
    expect(replaceEnvVars(expanded.headers ?? {}, env)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('withholds machine credentials from non-admin-owned configs', async () => {
    findByUsername.mockResolvedValue({ isAdmin: false });

    const env = await getServerEnvironment(upstream());

    expect(env[ENV_NAME]).toBeUndefined();
    expect(resolveDataPlaneToken).not.toHaveBeenCalled();
  });
});
