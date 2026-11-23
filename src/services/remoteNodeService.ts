import { logger } from '../utils/logger.js';
import { loadOriginalSettings, saveSettings } from '../config/index.js';
import type { RemoteNodeConfig } from '../types/index.js';

const TIMEOUT_MS = 10_000;

export class RemoteNodeError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = 'RemoteNodeError';
  }
}

export interface DiscoveredNodeView {
  id: string;
  schedulerNodeId: string;
  name: string;
  address?: string;
  hostname?: string;
  profile?: string;
  status?: string;
  arch?: string;
  gpuModel?: string;
  compatibleProfiles?: string[];
  lastCheckedAt?: string;
  alreadyManaged: boolean;
}

export type RemoteNodeView = RemoteNodeConfig;

// V-Scheduler discovery configuration (server-side only).
// The unified container exposes the controller at 38120 and the gateway at 8080;
// /scheduler/api/v1 works on both, so use one path for every deployment.
const SCHEDULER_URL = (
  process.env.V_SCHEDULER_URL
  || process.env.MCPHUB_VSCHEDULER_URL
  || 'http://v-scheduler:8080'
).replace(/\/+$/, '');

const readNodes = (): RemoteNodeConfig[] => {
  const nodes = loadOriginalSettings().remoteNodes ?? [];
  return Array.isArray(nodes) ? nodes : [];
};

const writeNodes = (nodes: RemoteNodeConfig[]): void => {
  const settings = loadOriginalSettings();
  if (!saveSettings({ ...settings, remoteNodes: nodes })) {
    throw new RemoteNodeError('Failed to persist remote node configuration', 500);
  }
};

const findNode = (id: string): RemoteNodeConfig | undefined =>
  readNodes().find((node) => node.id === id);

const validateId = (id: string): string => {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    throw new RemoteNodeError('id must be 1-128 letters, digits, dots, underscores, colons or hyphens', 400);
  }
  return trimmed;
};

export const listRemoteNodes = (): RemoteNodeView[] => readNodes();

export const createRemoteNode = (input: Omit<RemoteNodeConfig, 'createdAt'>): RemoteNodeView => {
  const id = validateId(input.id);
  if (!input.name?.trim()) throw new RemoteNodeError('name is required', 400);
  const nodes = readNodes();
  if (nodes.some((node) => node.id === id)) {
    throw new RemoteNodeError(`Remote node '${id}' already exists`, 409);
  }
  const node: RemoteNodeConfig = {
    ...input,
    id,
    name: input.name.trim(),
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  writeNodes([...nodes, node]);
  return node;
};

export const updateRemoteNode = (id: string, patch: Partial<RemoteNodeConfig>): RemoteNodeView => {
  const nodes = readNodes();
  const index = nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  const existing = nodes[index];
  const next: RemoteNodeConfig = { ...existing, ...patch, id };
  if (!next.name?.trim()) throw new RemoteNodeError('name is required', 400);
  next.name = next.name.trim();
  nodes[index] = next;
  writeNodes(nodes);
  return next;
};

export const deleteRemoteNode = (id: string): void => {
  const nodes = readNodes();
  if (!nodes.some((node) => node.id === id)) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  writeNodes(nodes.filter((node) => node.id !== id));
};

export const getRemoteNodeInternal = (id: string): RemoteNodeConfig => {
  const node = findNode(id);
  if (!node) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  return node;
};

/** Pull the SSH compute node inventory with the current user's VOS token. */
export const discoverNodesFromScheduler = async (userToken: string): Promise<DiscoveredNodeView[]> => {
  const token = userToken?.trim();
  if (!token) {
    throw new RemoteNodeError('VOS user token is required for V-Scheduler discovery', 401);
  }
  let response: Response;
  try {
    response = await fetch(`${SCHEDULER_URL}/scheduler/api/v1/managed-nodes`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn('V-Scheduler discovery failed', { error: String(error) });
    throw new RemoteNodeError('V-Scheduler unreachable', 502);
  }
  if (!response.ok) {
    throw new RemoteNodeError(`V-Scheduler returned HTTP ${response.status}`, 502);
  }
  const payload: any = await response.json().catch(() => null);
  const items: any[] = payload?.data?.items ?? [];
  const managed = new Set(readNodes().map((node) => node.id));
  return items
    .map((item): DiscoveredNodeView | null => {
      // Submitter credentials receive `address`/`hostname`; admin tokens also carry `host`.
      const address = [item?.address, item?.hostname, item?.host]
        .find((value) => typeof value === 'string' && value.trim())
        ?.trim();
      if (!address) return null;
      const schedulerNodeId = String(item.id ?? address);
      const id = schedulerNodeId.replace(/[^a-zA-Z0-9._:-]/g, '-');
      const compatibleProfiles = Array.isArray(item.compatible_profiles)
        ? item.compatible_profiles.filter((value: unknown) => typeof value === 'string')
        : undefined;
      return {
        id,
        schedulerNodeId,
        name: String(item.name || item.hostname || address),
        address,
        hostname: typeof item.hostname === 'string' ? item.hostname : undefined,
        profile: item.profile || item.detected_profile || undefined,
        status: item.status || undefined,
        arch: item.arch || undefined,
        gpuModel: item.gpu_model || undefined,
        compatibleProfiles,
        lastCheckedAt: item.last_checked_at || undefined,
        alreadyManaged: managed.has(id),
      };
    })
    .filter((row): row is DiscoveredNodeView => row !== null);
};

/** Import selected discovered nodes into the admin whitelist. */
export const importDiscoveredNodes = (ids: string[], discovered: DiscoveredNodeView[]): RemoteNodeView[] => {
  const selected = discovered.filter((node) => ids.includes(node.id));
  if (selected.length === 0) throw new RemoteNodeError('No nodes selected', 400);
  const nodes = readNodes();
  const imported: RemoteNodeView[] = [];
  for (const item of selected) {
    const existing = nodes.find((node) => node.id === item.id);
    if (existing) {
      Object.assign(existing, {
        name: item.name,
        address: item.address,
        hostname: item.hostname,
        profile: item.profile,
        arch: item.arch,
        gpuModel: item.gpuModel,
        status: item.status,
        compatibleProfiles: item.compatibleProfiles,
        lastCheckedAt: item.lastCheckedAt,
      });
      imported.push(existing);
    } else {
      const node: RemoteNodeConfig = {
        id: item.id,
        schedulerNodeId: item.schedulerNodeId,
        name: item.name,
        address: item.address,
        hostname: item.hostname,
        profile: item.profile,
        arch: item.arch,
        gpuModel: item.gpuModel,
        status: item.status,
        compatibleProfiles: item.compatibleProfiles,
        lastCheckedAt: item.lastCheckedAt,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      nodes.push(node);
      imported.push(node);
    }
  }
  writeNodes(nodes);
  return imported;
};
