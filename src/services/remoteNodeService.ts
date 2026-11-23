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

export interface RemoteNodeView extends Omit<RemoteNodeConfig, 'token'> {
  hasToken: boolean;
}

export interface RemoteServerView {
  name: string;
  description?: string;
  visibility?: string;
  status?: string;
  enabled?: boolean;
  mcpPath?: string;
}

export interface DiscoveredNodeView {
  id: string;
  name: string;
  host: string;
  baseUrl: string;
  profile?: string;
  status?: string;
  arch?: string;
  gpuModel?: string;
  alreadyManaged: boolean;
}

// V-Scheduler discovery configuration (server-side only).
const SCHEDULER_URL = (process.env.MCPHUB_VSCHEDULER_URL || 'http://localhost:38120').replace(/\/+$/, '');
const SCHEDULER_TOKEN = process.env.MCPHUB_VSCHEDULER_TOKEN || '';
// Path/port of a remote MCPHub behind the VOS gateway / direct port.
// MCPHUB_REMOTE_PORT must match the remote node's MCPHUB_HOST_PORT.
const REMOTE_MCPHUB_PATH = process.env.MCPHUB_REMOTE_PATH || '/app/com.ictrek.mcphub';
const REMOTE_MCPHUB_PORT = process.env.MCPHUB_REMOTE_PORT || '3000';

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

const toView = (node: RemoteNodeConfig): RemoteNodeView => {
  const { token, ...rest } = node;
  return { ...rest, hasToken: Boolean(token && token.trim()) };
};

const findNode = (id: string): RemoteNodeConfig | undefined =>
  readNodes().find((node) => node.id === id);

const validateBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RemoteNodeError('baseUrl must be a valid URL', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteNodeError('baseUrl must use http or https', 400);
  }
  return trimmed;
};

const request = async <T>(
  node: RemoteNodeConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> => {
  if (node.enabled === false) {
    throw new RemoteNodeError('Remote node is disabled', 409);
  }
  const url = `${validateBaseUrl(node.baseUrl)}${path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (node.token?.trim()) {
    headers.authorization = `Bearer ${node.token.trim()}`;
  }
  if (init?.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn('Remote node request failed', { nodeId: node.id, path, error: String(error) });
    throw new RemoteNodeError(`Remote node unreachable: ${node.name}`, 502);
  }

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // keep payload null; handled below
  }

  if (!response.ok) {
    const message = payload?.message ?? payload?.msg ?? `Remote node returned HTTP ${response.status}`;
    throw new RemoteNodeError(String(message), response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  if (payload?.success === false) {
    throw new RemoteNodeError(String(payload.message ?? 'Remote node request failed'), 502);
  }
  return (payload?.data ?? payload) as T;
};

export const listRemoteNodes = (): RemoteNodeView[] => readNodes().map(toView);

export const createRemoteNode = (input: Omit<RemoteNodeConfig, 'createdAt'>): RemoteNodeView => {
  const id = input.id?.trim();
  if (!id) throw new RemoteNodeError('id is required', 400);
  if (!input.name?.trim()) throw new RemoteNodeError('name is required', 400);
  const baseUrl = validateBaseUrl(input.baseUrl);
  const nodes = readNodes();
  if (nodes.some((node) => node.id === id)) {
    throw new RemoteNodeError(`Remote node '${id}' already exists`, 409);
  }
  const node: RemoteNodeConfig = {
    ...input,
    id,
    name: input.name.trim(),
    baseUrl,
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  writeNodes([...nodes, node]);
  return toView(node);
};

export const updateRemoteNode = (id: string, patch: Partial<RemoteNodeConfig>): RemoteNodeView => {
  const nodes = readNodes();
  const index = nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  const existing = nodes[index];
  const next: RemoteNodeConfig = {
    ...existing,
    ...patch,
    id,
    baseUrl: patch.baseUrl !== undefined ? validateBaseUrl(patch.baseUrl) : existing.baseUrl,
    // Empty token in a patch means "keep the stored credential".
    token: patch.token !== undefined && patch.token.trim() === '' ? existing.token : patch.token ?? existing.token,
  };
  if (!next.name?.trim()) throw new RemoteNodeError('name is required', 400);
  nodes[index] = next;
  writeNodes(nodes);
  return toView(next);
};

export const deleteRemoteNode = (id: string): void => {
  const nodes = readNodes();
  if (!nodes.some((node) => node.id === id)) {
    throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  }
  writeNodes(nodes.filter((node) => node.id !== id));
};

/** Pull the node inventory from V-Scheduler (managed-nodes API). */
export const discoverNodesFromScheduler = async (): Promise<DiscoveredNodeView[]> => {
  if (!SCHEDULER_TOKEN) {
    throw new RemoteNodeError('MCPHUB_VSCHEDULER_TOKEN is not configured', 503);
  }
  let response: Response;
  try {
    response = await fetch(`${SCHEDULER_URL}/api/v1/managed-nodes`, {
      headers: { authorization: `Bearer ${SCHEDULER_TOKEN}` },
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
    .filter((item) => typeof item?.host === 'string' && item.host.trim())
    .map((item) => {
      const host = item.host.trim();
      const id = String(item.id ?? host).replace(/[^a-zA-Z0-9._-]/g, '-');
      return {
        id,
        name: String(item.name || item.hostname || host),
        host,
        baseUrl: `http://${host}:${REMOTE_MCPHUB_PORT}${REMOTE_MCPHUB_PATH}`,
        profile: item.profile || item.detected_profile || undefined,
        status: item.status || undefined,
        arch: item.arch || undefined,
        gpuModel: item.gpu_model || undefined,
        alreadyManaged: managed.has(id),
      };
    });
};

/** Import selected discovered nodes into the admin whitelist. */
export const importDiscoveredNodes = (
  ids: string[],
  discovered: DiscoveredNodeView[],
  token: string,
): RemoteNodeView[] => {
  if (!token?.trim()) throw new RemoteNodeError('Integration token is required', 400);
  const selected = discovered.filter((node) => ids.includes(node.id));
  if (selected.length === 0) throw new RemoteNodeError('No nodes selected', 400);
  const nodes = readNodes();
  const imported: RemoteNodeView[] = [];
  for (const item of selected) {
    const existing = nodes.find((node) => node.id === item.id);
    if (existing) {
      existing.baseUrl = item.baseUrl;
      existing.profile = item.profile;
      existing.name = item.name;
      imported.push(toView(existing));
    } else {
      const node: RemoteNodeConfig = {
        id: item.id,
        name: item.name,
        baseUrl: item.baseUrl,
        token,
        profile: item.profile,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      nodes.push(node);
      imported.push(toView(node));
    }
  }
  writeNodes(nodes);
  return imported;
};

export const discoverRemoteServers = async (id: string): Promise<RemoteServerView[]> => {
  const node = findNode(id);
  if (!node) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  const data = await request<any>(node, '/api/integration/discovery');
  const rows = Array.isArray(data?.servers) ? data.servers : Array.isArray(data) ? data : [];
  return rows.map((row: any) => ({
    name: String(row.name ?? ''),
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    enabled: row.enabled,
    mcpPath: row.mcp_path,
  })).filter((row: RemoteServerView) => row.name);
};

export const toggleRemoteServer = async (id: string, name: string, enabled: boolean): Promise<void> => {
  const node = findNode(id);
  if (!node) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  if (!/^[\w.$~%-]{1,128}$/.test(name)) throw new RemoteNodeError('Invalid server name', 400);
  await request(node, `/api/servers/${encodeURIComponent(name)}/toggle`, { method: 'POST', body: { enabled } });
};

export const deleteRemoteServer = async (id: string, name: string): Promise<void> => {
  const node = findNode(id);
  if (!node) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  if (!/^[\w.$~%-]{1,128}$/.test(name)) throw new RemoteNodeError('Invalid server name', 400);
  await request(node, `/api/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
};

/** Server-side only: full node record including the stored integration token. */
export const getRemoteNodeInternal = (id: string): RemoteNodeConfig => {
  const node = findNode(id);
  if (!node) throw new RemoteNodeError(`Remote node '${id}' not found`, 404);
  return node;
};
