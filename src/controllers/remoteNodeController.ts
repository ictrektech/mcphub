import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  RemoteNodeError,
  createRemoteNode,
  deleteRemoteNode,
  deleteRemoteServer,
  discoverNodesFromScheduler,
  discoverRemoteServers,
  importDiscoveredNodes,
  listRemoteNodes,
  toggleRemoteServer,
  updateRemoteNode,
  getRemoteNodeInternal,
} from '../services/remoteNodeService.js';
import { registerRemoteServer } from '../services/remoteServerRegistrationService.js';

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
    const { id, name, baseUrl, token, profile, enabled } = req.body ?? {};
    const view = createRemoteNode({ id, name, baseUrl, token, profile, enabled });
    res.json({ success: true, data: view });
  } catch (error) {
    fail(res, error);
  }
};

export const editRemoteNode = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, baseUrl, token, profile, enabled } = req.body ?? {};
    const view = updateRemoteNode(id, { name, baseUrl, token, profile, enabled });
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
    const nodes = await discoverNodesFromScheduler();
    res.json({ success: true, data: nodes });
  } catch (error) {
    fail(res, error);
  }
};

export const importFromScheduler = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ids, nodes, token } = req.body ?? {};
    if (!Array.isArray(ids) || !Array.isArray(nodes) || typeof token !== 'string') {
      res.status(400).json({ success: false, message: 'ids, nodes and token are required' });
      return;
    }
    const imported = importDiscoveredNodes(ids, nodes, token);
    res.json({ success: true, data: imported });
  } catch (error) {
    fail(res, error);
  }
};

export const getRemoteServers = async (req: Request, res: Response): Promise<void> => {
  logger.info('[remote-nodes] discover request', {
    id: req.params.id,
    user: (req as any).user?.username,
    isAdmin: (req as any).user?.isAdmin,
  });
  try {
    const servers = await discoverRemoteServers(req.params.id);
    logger.info('[remote-nodes] discover result', { id: req.params.id, count: servers.length });
    res.json({ success: true, data: servers });
  } catch (error) {
    logger.warn('[remote-nodes] discover failed', {
      id: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    fail(res, error);
  }
};

export const registerNodeServers = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.id);
    const servers = await discoverRemoteServers(node.id);
    const token = node.token?.trim();
    if (!token) {
      res.status(400).json({ success: false, message: 'Remote node has no integration token' });
      return;
    }
    const registered = [];
    for (const server of servers) {
      const result = await registerRemoteServer({
        name: server.name,
        nodeId: node.id,
        nodeName: node.name,
        host: new URL(node.baseUrl).hostname,
        profile: node.profile,
        token,
      });
      registered.push(result);
    }
    res.json({ success: true, data: registered });
  } catch (error) {
    fail(res, error);
  }
};

export const toggleRemoteServerStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, name } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, message: 'enabled must be a boolean' });
      return;
    }
    await toggleRemoteServer(id, name, enabled);
    res.json({ success: true, message: enabled ? 'Server enabled' : 'Server disabled' });
  } catch (error) {
    fail(res, error);
  }
};

export const removeRemoteServer = async (req: Request, res: Response): Promise<void> => {
  try {
    await deleteRemoteServer(req.params.id, req.params.name);
    res.json({ success: true, message: 'Remote server deleted' });
  } catch (error) {
    fail(res, error);
  }
};
