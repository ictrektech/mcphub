import { getGroupDao, getServerDao } from '../dao/index.js';
import { RemoteNodeError, getRemoteNodeInternal } from './remoteNodeService.js';
import {
  checkRemoteServerAddress,
  getRemoteServerBinding,
  updateRemoteServerBinding,
} from './remoteServerBindingService.js';
import type { IGroup, RemoteNodeConfig, RemoteServerBinding } from '../types/index.js';

// mcpService pulls in OAuth/SDK modules; load it only when a node service is actually registered.
const loadMcpService = () => import('./mcpService.js');

export interface RegistrationResult {
  serverName: string;
  groupName: string;
  created: boolean;
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';

export const remoteServerLocalName = (serverName: string, nodeName: string): string =>
  `${serverName}@${slug(nodeName)}`;

export const remoteGroupName = (nodeName: string): string => `远程节点 · ${nodeName}`;

const upstreamNameOf = (binding: RemoteServerBinding, node: RemoteNodeConfig): string =>
  binding.upstreamName ?? remoteServerLocalName(binding.serverName, node.name);

const ensureGroupName = async (binding: RemoteServerBinding, node: RemoteNodeConfig): Promise<string> => {
  const groupName = remoteGroupName(node.name);
  const upstreamName = upstreamNameOf(binding, node);
  const groupDao = getGroupDao();
  const existing = await groupDao.findByName(groupName);
  if (existing) {
    const names = (Array.isArray(existing.servers) ? existing.servers : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry.name));
    if (!names.includes(upstreamName)) await groupDao.updateServers(existing.id, [...names, upstreamName]);
    return groupName;
  }
  await groupDao.create({
    name: groupName,
    description: `自动归集远程节点的 MCP 服务`,
    servers: [upstreamName],
    owner: 'admin',
    visibility: 'private',
  } as Omit<IGroup, 'id'>);
  return groupName;
};

/** Register (or re-enable) a bound node service as a streamable-http upstream. */
export const connectRemoteServer = async (
  schedulerNodeId: string,
  serverName: string,
): Promise<RegistrationResult> => {
  const node = getRemoteNodeInternal(schedulerNodeId);
  const binding = getRemoteServerBinding(schedulerNodeId, serverName);
  const checked = await checkRemoteServerAddress(binding);
  if (checked.reachable === false) {
    throw new RemoteNodeError(`MCP server address is unreachable: ${binding.address}`, 502);
  }
  const mcp = await loadMcpService();
  const upstreamName = upstreamNameOf(binding, node);
  const serverDao = getServerDao();
  const existing = await serverDao.findById(upstreamName);
  const config = {
    type: 'streamable-http' as const,
    url: binding.address,
    enabled: true,
    owner: 'admin',
    visibility: 'public' as const,
    nodeId: node.id,
    nodeName: node.name,
    nodeProfile: node.profile,
    description: `远程节点 ${node.name}${node.profile ? ` (${node.profile})` : ''} 的 ${binding.serverName}`,
  };
  let created = false;
  if (existing) {
    await serverDao.update(upstreamName, config);
    const toggled = await mcp.toggleServerStatus(upstreamName, true);
    if (!toggled.success) throw new RemoteNodeError(toggled.message || 'Failed to enable upstream', 500);
  } else {
    const added = await mcp.addServer(upstreamName, config);
    if (!added.success) throw new RemoteNodeError(added.message || 'Failed to register upstream', 500);
    // addServer only persists the definition; without a toggle the new upstream
    // stays disconnected forever (the update branch already did this).
    const toggled = await mcp.toggleServerStatus(upstreamName, true);
    if (!toggled.success) throw new RemoteNodeError(toggled.message || 'Failed to enable upstream', 500);
    created = true;
  }
  if (!binding.upstreamName) updateRemoteServerBinding(binding.id, { upstreamName });
  const groupName = await ensureGroupName(updateRemoteServerBinding(binding.id, { lastError: undefined }), node);
  // Wait for tools to load so the caller sees an immediately usable upstream.
  await mcp.notifyToolChanged(upstreamName, { reportEmbeddingProgress: true });
  return { serverName: upstreamName, groupName, created };
};

/** Center-side stop: keep the service on the node, remove it from aggregation. */
export const disconnectRemoteServer = async (schedulerNodeId: string, serverName: string): Promise<void> => {
  const node = getRemoteNodeInternal(schedulerNodeId);
  const binding = getRemoteServerBinding(schedulerNodeId, serverName);
  const mcp = await loadMcpService();
  const upstreamName = upstreamNameOf(binding, node);
  const result = await mcp.toggleServerStatus(upstreamName, false);
  if (!result.success) throw new RemoteNodeError(result.message || 'Failed to disable upstream', 500);
  // toggleServerStatus only flips status; the last tool list would otherwise
  // stay in getServersInfo() and look callable until someone reloads the hub.
  mcp.clearServerCapabilitiesCache(upstreamName);
  mcp.broadcastToolListChanged();
  mcp.broadcastPromptListChanged();
  mcp.broadcastResourceListChanged();
};

/** Remove the binding and its local upstream registration. */
export const removeRemoteServer = async (schedulerNodeId: string, serverName: string): Promise<void> => {
  const node = getRemoteNodeInternal(schedulerNodeId);
  const binding = getRemoteServerBinding(schedulerNodeId, serverName);
  const upstreamName = upstreamNameOf(binding, node);
  const group = await getGroupDao().findByName(remoteGroupName(node.name));
  if (group) {
    const names = (Array.isArray(group.servers) ? group.servers : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry.name))
      .filter((name) => name !== upstreamName);
    await getGroupDao().updateServers(group.id, names);
  }
  const existing = await getServerDao().findById(upstreamName);
  if (existing) {
    const mcp = await loadMcpService();
    await mcp.removeServer(upstreamName);
    mcp.broadcastToolListChanged();
    mcp.broadcastPromptListChanged();
    mcp.broadcastResourceListChanged();
  }
};
