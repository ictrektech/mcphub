import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { getServerDao, getGroupDao } from '../dao/index.js';
import { registerAllTools } from './mcpService.js';
import type { IGroup, ServerConfig } from '../types/index.js';

const REMOTE_MCPHUB_PATH = process.env.MCPHUB_REMOTE_PATH || '/app/com.ictrek.mcphub';
const REMOTE_MCPHUB_PORT = process.env.MCPHUB_REMOTE_PORT || '31888';

export interface RegisterableRemoteServer {
  name: string; // server name on the remote node
  nodeId: string;
  nodeName: string;
  host: string;
  profile?: string;
  token: string; // integration token for the remote MCPHub
}

export interface RegistrationResult {
  serverName: string; // local name (with node suffix)
  groupName: string;
  created: boolean;
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';

export const remoteServerLocalName = (serverName: string, nodeName: string): string =>
  `${serverName}@${slug(nodeName)}`;

export const remoteGroupName = (nodeName: string): string => `远程节点 · ${nodeName}`;

/**
 * Register a discovered remote MCP server into this hub so admin can invoke its
 * tools. The remote server is reachable at the node's published MCPHub port via
 * streamable-http, authenticated with the shared integration token.
 *
 * Servers are named `<server>@<node>` and grouped under a per-node group so
 * local and remote services stay clearly separated.
 */
export const registerRemoteServer = async (
  input: RegisterableRemoteServer,
): Promise<RegistrationResult> => {
  const localName = remoteServerLocalName(input.name, input.nodeName);
  const groupName = remoteGroupName(input.nodeName);
  const serverDao = getServerDao();

  const existing = await serverDao.findAll();
  let created = false;
  if (!existing.some((server) => server.name === localName)) {
    const baseUrl = `http://${input.host}:${REMOTE_MCPHUB_PORT}${REMOTE_MCPHUB_PATH}`;
    const config: ServerConfig = {
      id: randomUUID(),
      type: 'streamable-http',
      url: `${baseUrl}/mcp/${encodeURIComponent(input.name)}`,
      headers: { authorization: `Bearer ${input.token}` },
      enabled: true,
      visibility: 'public',
      owner: 'admin',
      nodeId: input.nodeId,
      nodeName: input.nodeName,
      nodeProfile: input.profile,
      description: `远端节点 ${input.nodeName}${input.profile ? ` (${input.profile})` : ''} 的 ${input.name}`,
    };
    const ok = await serverDao.create({ name: localName, ...config });
    if (!ok) throw new Error(`Failed to register remote server ${localName}`);
    created = true;
    try {
      await registerAllTools(false, localName);
    } catch (error) {
      logger.warn('Failed to register tools for remote server', {
        localName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await ensureRemoteGroup(groupName, localName);
  return { serverName: localName, groupName, created };
};

const ensureRemoteGroup = async (groupName: string, serverName: string): Promise<void> => {
  const groupDao = getGroupDao();
  const existing = await groupDao.findByName(groupName);
  if (existing) {
    const names = (Array.isArray(existing.servers) ? existing.servers : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry.name));
    if (!names.includes(serverName)) {
      await groupDao.updateServers(existing.id, [...names, serverName]);
    }
    return;
  }
  await groupDao.create({
    name: groupName,
    description: `自动归集远程节点的 MCP 服务`,
    servers: [serverName],
    owner: 'admin',
    visibility: 'private',
  } as Omit<IGroup, 'id'>);
};

/** Remove all registered servers for a remote node (group is left in place). */
export const unregisterRemoteNode = async (nodeName: string): Promise<void> => {
  const groupDao = getGroupDao();
  const group = await groupDao.findByName(remoteGroupName(nodeName));
  const servers = group && Array.isArray(group.servers) ? group.servers : [];
  for (const entry of servers) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (name && name.includes('@')) {
      try {
        await getServerDao().delete(name);
      } catch {
        // best effort
      }
    }
  }
};
