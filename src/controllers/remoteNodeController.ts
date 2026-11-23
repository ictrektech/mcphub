import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  RemoteNodeError,
  createRemoteNode,
  deleteRemoteNode,
  discoverNodesFromScheduler,
  importDiscoveredNodes,
  listRemoteNodes,
  updateRemoteNode,
} from '../services/remoteNodeService.js';

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
