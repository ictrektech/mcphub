import { randomUUID } from 'node:crypto';
import { loadOriginalSettings, saveSettings } from '../config/index.js';
import { isUpstreamReachable } from './builtinServerProvisioning.js';
import { RemoteNodeError, getRemoteNodeInternal } from './remoteNodeService.js';
import type { RemoteServerBinding, RemoteServerBindingView } from '../types/index.js';

const NAME_PATTERN = /^[\w.$~%-]{1,128}$/;

const readBindings = (): RemoteServerBinding[] => {
  const bindings = loadOriginalSettings().remoteServerBindings ?? [];
  return Array.isArray(bindings) ? bindings : [];
};

const writeBindings = (bindings: RemoteServerBinding[]): void => {
  const settings = loadOriginalSettings();
  if (!saveSettings({ ...settings, remoteServerBindings: bindings })) {
    throw new RemoteNodeError('Failed to persist remote server bindings', 500);
  }
};

const validateServerName = (name: string): string => {
  const trimmed = name?.trim();
  if (!trimmed || !NAME_PATTERN.test(trimmed)) {
    throw new RemoteNodeError('Service name must be 1-128 letters, digits, dots, underscores, %, ~, $ or -', 400);
  }
  return trimmed;
};

export const validateServerAddress = (address: string): string => {
  let url: URL;
  try {
    url = new URL(address?.trim());
  } catch {
    throw new RemoteNodeError('Service address must be a valid URL', 400);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new RemoteNodeError('Service address must be an http(s) URL without credentials', 400);
  }
  return url.toString().replace(/\/$/, '') || url.toString();
};

export const listRemoteServerBindings = (schedulerNodeId?: string): RemoteServerBindingView[] => {
  const rows = readBindings();
  return schedulerNodeId ? rows.filter((row) => row.schedulerNodeId === schedulerNodeId) : rows;
};

export const getRemoteServerBinding = (schedulerNodeId: string, serverName: string): RemoteServerBinding => {
  const binding = readBindings().find(
    (row) => row.schedulerNodeId === schedulerNodeId && row.serverName === serverName,
  );
  if (!binding) throw new RemoteNodeError(`Remote server '${serverName}' not found on node '${schedulerNodeId}'`, 404);
  return binding;
};

/** Probe the admin-registered address. Any HTTP response counts as reachable. */
export const checkRemoteServerAddress = async (binding: RemoteServerBinding): Promise<RemoteServerBinding> => {
  const reachable = await isUpstreamReachable(binding.address);
  return updateRemoteServerBinding(binding.id, {
    reachable,
    lastCheckedAt: new Date().toISOString(),
    lastError: reachable ? undefined : 'Address unreachable from the hub',
  });
};

export const createRemoteServerBinding = async (input: {
  schedulerNodeId: string;
  serverName: string;
  address: string;
}): Promise<RemoteServerBinding> => {
  const node = getRemoteNodeInternal(input.schedulerNodeId);
  const serverName = validateServerName(input.serverName);
  const address = validateServerAddress(input.address);
  const bindings = readBindings();
  if (bindings.some((row) => row.schedulerNodeId === node.id && row.serverName === serverName)) {
    throw new RemoteNodeError(`Remote server '${serverName}' already exists on node '${node.id}'`, 409);
  }
  const binding: RemoteServerBinding = {
    id: randomUUID(),
    serverName,
    schedulerNodeId: node.id,
    address,
    profile: node.profile,
    createdAt: new Date().toISOString(),
  };
  bindings.push(binding);
  writeBindings(bindings);
  return checkRemoteServerAddress(binding);
};

export const updateRemoteServerBinding = (
  id: string,
  patch: Partial<Omit<RemoteServerBinding, 'id' | 'createdAt' | 'schedulerNodeId'>>,
): RemoteServerBinding => {
  const bindings = readBindings();
  const index = bindings.findIndex((row) => row.id === id);
  if (index < 0) throw new RemoteNodeError(`Remote server binding '${id}' not found`, 404);
  const next: RemoteServerBinding = { ...bindings[index], ...patch };
  if (patch.serverName !== undefined) next.serverName = validateServerName(patch.serverName);
  if (patch.address !== undefined) next.address = validateServerAddress(patch.address);
  for (const key of ['profile', 'upstreamName', 'lastError'] as const) {
    if (next[key] === undefined) delete next[key];
  }
  bindings[index] = next;
  writeBindings(bindings);
  return next;
};

export const deleteRemoteServerBinding = (schedulerNodeId: string, serverName: string): RemoteServerBinding => {
  const bindings = readBindings();
  const binding = bindings.find((row) => row.schedulerNodeId === schedulerNodeId && row.serverName === serverName);
  if (!binding) throw new RemoteNodeError(`Remote server '${serverName}' not found on node '${schedulerNodeId}'`, 404);
  writeBindings(bindings.filter((row) => row.id !== binding.id));
  return binding;
};
