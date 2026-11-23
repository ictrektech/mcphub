import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  RemoteNodeError,
  createRemoteNode,
  deleteRemoteNode,
  discoverNodesFromScheduler,
  getRemoteNodeInternal,
  importDiscoveredNodes,
  listRemoteNodes,
  updateRemoteNode,
} from '../services/remoteNodeService.js';
import {
  createRemoteServerBinding,
  deleteRemoteServerBinding,
  getRemoteServerBinding,
  listRemoteServerBindings,
} from '../services/remoteServerBindingService.js';
import {
  connectRemoteServer,
  disconnectRemoteServer,
  remoteServerLocalName,
  removeRemoteServer,
} from '../services/remoteServerRegistrationService.js';

const fail = (res: Response, error: unknown): void => {
  if (error instanceof RemoteNodeError) {
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  logger.error('Remote node operation failed', { error });
  res.status(500).json({ success: false, message: 'Internal server error' });
};

export const getRemoteNodes = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: listRemoteNodes() });
  } catch (error) {
    fail(res, error);
  }
};

export const addRemoteNode = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      id, name, schedulerNodeId, address, hostname, arch, gpuModel,
      profile, status, detectedProfile, compatibleProfiles, lastCheckedAt, enabled,
    } = req.body ?? {};
    const view = createRemoteNode({
      id, name, schedulerNodeId, address, hostname, arch, gpuModel,
      profile, status, detectedProfile, compatibleProfiles, lastCheckedAt, enabled,
    });
    res.json({ success: true, data: view });
  } catch (error) {
    fail(res, error);
  }
};

export const editRemoteNode = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      name, schedulerNodeId, address, hostname, arch, gpuModel,
      profile, status, detectedProfile, compatibleProfiles, lastCheckedAt, enabled,
    } = req.body ?? {};
    const view = updateRemoteNode(req.params.id, {
      name, schedulerNodeId, address, hostname, arch, gpuModel,
      profile, status, detectedProfile, compatibleProfiles, lastCheckedAt, enabled,
    });
    res.json({ success: true, data: view });
  } catch (error) {
    fail(res, error);
  }
};

export const removeRemoteNode = async (req: Request, res: Response): Promise<void> => {
  try {
    deleteRemoteNode(req.params.id);
    res.json({ success: true, message: 'Remote node removed' });
  } catch (error) {
    fail(res, error);
  }
};

export const discoverFromScheduler = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await discoverNodesFromScheduler() });
  } catch (error) {
    fail(res, error);
  }
};

export const importFromScheduler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      res.status(400).json({ success: false, message: 'ids must be an array of node ids' });
      return;
    }
    // Re-query the scheduler so clients cannot inject node metadata at import time.
    const discovered = await discoverNodesFromScheduler();
    const imported = importDiscoveredNodes(ids, discovered);
    res.json({ success: true, data: imported });
  } catch (error) {
    fail(res, error);
  }
};

const audit = (req: Request, action: string, details: Record<string, unknown>): void => {
  logger.info('[remote-nodes] audit', {
    action,
    user: (req as any).user?.username,
    isAdmin: (req as any).user?.isAdmin === true,
    ...details,
  });
};

export const getRemoteServers = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.id);
    const { getServersInfo } = await import('../services/mcpService.js');
    const infos = await getServersInfo();
    const rows = listRemoteServerBindings(node.id).map((binding) => {
      const upstreamName = binding.upstreamName ?? remoteServerLocalName(binding.serverName, node.name);
      const info = infos.find((item) => item.name === upstreamName);
      return {
        ...binding,
        upstreamName,
        enabled: info?.enabled,
        status: info?.status,
        lastError: info ? info.error ?? undefined : binding.lastError,
      };
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    fail(res, error);
  }
};

export const addRemoteServer = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, address } = req.body ?? {};
    const binding = await createRemoteServerBinding({
      schedulerNodeId: req.params.id,
      serverName: name,
      address,
    });
    audit(req, 'remote-server.register', { nodeId: req.params.id, serverName: binding.serverName });
    res.json({ success: true, data: binding });
  } catch (error) {
    fail(res, error);
  }
};

export const toggleRemoteServerAccess = async (req: Request, res: Response): Promise<void> => {
  try {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, message: 'enabled must be a boolean' });
      return;
    }
    getRemoteServerBinding(req.params.id, req.params.name);
    if (enabled) {
      const result = await connectRemoteServer(req.params.id, req.params.name);
      audit(req, 'remote-server.connect', {
        nodeId: req.params.id, serverName: req.params.name, upstreamName: result.serverName,
      });
      res.json({ success: true, data: result });
    } else {
      await disconnectRemoteServer(req.params.id, req.params.name);
      audit(req, 'remote-server.disconnect', { nodeId: req.params.id, serverName: req.params.name });
      res.json({ success: true, message: 'Remote server disconnected from the hub' });
    }
  } catch (error) {
    fail(res, error);
  }
};

export const removeRemoteServerBindingForNode = async (req: Request, res: Response): Promise<void> => {
  try {
    await removeRemoteServer(req.params.id, req.params.name);
    deleteRemoteServerBinding(req.params.id, req.params.name);
    audit(req, 'remote-server.remove', { nodeId: req.params.id, serverName: req.params.name });
    res.json({ success: true, message: 'Remote server registration removed' });
  } catch (error) {
    fail(res, error);
  }
};
