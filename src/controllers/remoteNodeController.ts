import type { Request, Response } from 'express';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import config from '../config/index.js';
import type { NodeLinkServerView, NodeOpsServerSummary, RemoteNodeConfig } from '../types/index.js';
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
  updateRemoteServerBinding,
} from '../services/remoteServerBindingService.js';
import {
  connectRemoteServer,
  disconnectRemoteServer,
  remoteServerLocalName,
  removeRemoteServer,
} from '../services/remoteServerRegistrationService.js';
import {
  credentialStatus,
  deleteCredential,
  resolveDataPlaneToken,
  setCredential,
} from '../services/nodeCredentialStore.js';

/** VOS dashboard requests carry the user token in x-vos-token; accept Bearer too. */
const vosTokenFromRequest = (req: Request): string => {
  const direct = req.header('x-vos-token');
  if (direct?.trim()) return direct.trim();
  const bearer = req.header('authorization');
  return bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
};

const fail = (res: Response, error: unknown): void => {
  if (error instanceof RemoteNodeError) {
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  logger.error('Remote node operation failed', { error });
  res.status(500).json({ success: false, message: 'Internal server error' });
};

// The peer Bearer key comes only from the runtime credential store, never
// from settings or the environment.
const hasDataPlaneToken = async (node: RemoteNodeConfig): Promise<boolean> =>
  Boolean(await resolveDataPlaneToken(node));

const rejectMissingDataPlaneToken = (node: RemoteNodeConfig, res: Response): void => {
  res.status(400).json({
    success: false,
    code: 'data-plane-token-required',
    message: `Node '${node.name}' has no data-plane credential; configure it in the node settings`,
  });
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

export const discoverFromScheduler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await discoverNodesFromScheduler(vosTokenFromRequest(req)) });
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
    const discovered = await discoverNodesFromScheduler(vosTokenFromRequest(req));
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
      const node = getRemoteNodeInternal(req.params.id);
      if (!hasDataPlaneToken(node)) {
        rejectMissingDataPlaneToken(node, res);
        return;
      }
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

// ---------------------------------------------------------------------------
// B-2: attach/detach a peer node's MCP service as a local upstream.
//
// Control plane (this hub -> peer /node-ops) is mTLS: the certificate proves
// which node we are, the token says what we may do. Data plane (/mcp/*) has no
// user request context during MCP handshake, so it uses the peer's dedicated
// Bearer key from a per-node environment variable. Neither plane carries the
// calling user's VOS token, and no credential value is stored in settings.
//
// Implementation note (contract §B-2.5, option 乙): the data plane stays on
// the peer's published HTTP application port. The MCP SDK transport cannot
// present a client certificate, so moving /mcp/* to the mTLS listener without
// transport-level cert support would break the upstream handshake. Restrict
// that port to the node network and use 方案甲 only once cert-aware transports
// exist. The control plane remains mTLS-only by default.
// ---------------------------------------------------------------------------

interface PeerNodeOpsCredentials {
  token: string;
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

const peerTokenOf = (node: RemoteNodeConfig): string => {
  const rawMap = process.env.MCP_NODE_OPS_PEER_TOKENS;
  if (rawMap?.trim()) {
    let map: Record<string, string>;
    try {
      map = JSON.parse(rawMap) as Record<string, string>;
    } catch {
      throw new RemoteNodeError('MCP_NODE_OPS_PEER_TOKENS is not valid JSON', 503);
    }
    const mapped = map[node.id] ?? map[node.name];
    if (typeof mapped === 'string' && mapped.trim()) return mapped.trim();
  }
  const fallback = process.env.MCP_NODE_OPS_TOKEN;
  if (!fallback?.trim()) {
    throw new RemoteNodeError(
      `No node-ops token for '${node.name}': set MCP_NODE_OPS_TOKEN or MCP_NODE_OPS_PEER_TOKENS`,
      503,
    );
  }
  return fallback.trim();
};

const credentialsFor = (node: RemoteNodeConfig): PeerNodeOpsCredentials => {
  const certPath = process.env.MCP_NODE_OPS_CLIENT_CERT;
  const keyPath = process.env.MCP_NODE_OPS_CLIENT_KEY;
  const caPath = process.env.MCP_NODE_OPS_CLIENT_CA;
  if (!certPath || !keyPath || !caPath) {
    throw new RemoteNodeError(
      'node-ops client certificate missing: set MCP_NODE_OPS_CLIENT_CERT/KEY/CA',
      503,
    );
  }
  const token = peerTokenOf(node);
  try {
    return { token, cert: readFileSync(certPath), key: readFileSync(keyPath), ca: readFileSync(caPath) };
  } catch {
    throw new RemoteNodeError('node-ops client certificate files could not be read', 503);
  }
};

/** Read the peer's service list; any transport/auth failure is surfaced, never an empty list. */
const fetchPeerServers = (node: RemoteNodeConfig): Promise<NodeOpsServerSummary[]> =>
  new Promise((resolve, reject) => {
    const host = node.address?.trim() || node.hostname?.trim();
    if (!host) {
      reject(new RemoteNodeError(`Node '${node.name}' has no address`, 400));
      return;
    }
    let credentials: PeerNodeOpsCredentials;
    try {
      credentials = credentialsFor(node);
    } catch (error) {
      reject(error);
      return;
    }

    const request = https.request(
      {
        host,
        port: Number(process.env.MCP_NODE_OPS_PORT || 31890),
        path: `${config.basePath}/node-ops/servers`,
        method: 'GET',
        cert: credentials.cert,
        key: credentials.key,
        ca: credentials.ca,
        headers: { Authorization: `Bearer ${credentials.token}`, Accept: 'application/json' },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          let parsed: {
            success?: boolean;
            data?: { servers?: NodeOpsServerSummary[] };
            code?: string;
            message?: string;
          };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new RemoteNodeError(`node-ops on '${node.name}' returned non-JSON (${status})`, 502));
            return;
          }
          if (status !== 200 || parsed.success !== true || !Array.isArray(parsed.data?.servers)) {
            const code = parsed.code ? ` (${parsed.code})` : '';
            reject(
              new RemoteNodeError(
                `node-ops on '${node.name}' failed: ${status}${code} ${parsed.message ?? ''}`.trim(),
                status >= 400 && status < 600 ? status : 502,
              ),
            );
            return;
          }
          resolve(parsed.data!.servers!);
        });
      },
    );
    request.on('timeout', () =>
      request.destroy(new RemoteNodeError(`node-ops on '${node.name}' timed out`, 504)),
    );
    request.on('error', (error) => {
      reject(
        error instanceof RemoteNodeError
          ? error
          : new RemoteNodeError(`node-ops on '${node.name}' is unreachable: ${error.message}`, 502),
      );
    });
    request.end();
  });

export const listNodeLinkServers = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.nodeId);
    const peers = await fetchPeerServers(node);
    const bound = new Set(listRemoteServerBindings(node.id).map((row) => row.serverName));
    const data: NodeLinkServerView[] = peers.map((peer) => ({
      name: peer.name,
      type: peer.type,
      status: peer.status,
      mcpPath: peer.mcpPath,
      attached: bound.has(peer.name),
    }));
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error);
  }
};

const mcpDataUrlOf = (node: RemoteNodeConfig, mcpPath: string | undefined, name: string): string => {
  const host = node.address?.trim() || node.hostname?.trim();
  if (!host) throw new RemoteNodeError(`Node '${node.name}' has no address`, 400);
  // Encrypted data plane is the default; plain HTTP is an explicit opt-out.
  const scheme = process.env.MCP_NODE_DATA_SCHEME === 'http' ? 'http' : 'https';
  const port =
    process.env.MCP_NODE_DATA_PORT ||
    (scheme === 'https' ? '31891' : process.env.VOS_MCPHUB_HOST_PORT || '31889');
  const path = mcpPath || `${config.basePath}/mcp/${encodeURIComponent(name)}`;
  return new URL(path, `${scheme}://${host}:${port}`).toString();
};

export const attachNodeLinkServer = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.nodeId);
    if (!(await hasDataPlaneToken(node))) {
      rejectMissingDataPlaneToken(node, res);
      return;
    }
    const peer = (await fetchPeerServers(node)).find((entry) => entry.name === req.params.name);
    if (!peer) {
      throw new RemoteNodeError(`Server '${req.params.name}' not found on node '${node.name}'`, 404);
    }
    const address = mcpDataUrlOf(node, peer.mcpPath, peer.name);
    const bound = listRemoteServerBindings(node.id).find((row) => row.serverName === peer.name);
    const binding = bound ?? (await createRemoteServerBinding({
      schedulerNodeId: node.id,
      serverName: peer.name,
      address,
    }));
    updateRemoteServerBinding(binding.id, { address, transport: 'streamable-http' });
    const result = await connectRemoteServer(node.id, peer.name);
    audit(req, 'node-link.attach', {
      nodeId: node.id, serverName: peer.name, upstreamName: result.serverName,
    });
    res.json({ success: true, data: { name: peer.name, attached: true, upstreamName: result.serverName } });
  } catch (error) {
    fail(res, error);
  }
};

export const detachNodeLinkServer = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.nodeId);
    getRemoteServerBinding(node.id, req.params.name);
    await disconnectRemoteServer(node.id, req.params.name);
    audit(req, 'node-link.detach', { nodeId: node.id, serverName: req.params.name });
    res.json({ success: true, data: { name: req.params.name, attached: false } });
  } catch (error) {
    fail(res, error);
  }
};

// A stored credential must take effect in this process without a restart:
// rebuild the transports of every already-attached upstream for the node.
const refreshNodeLinks = async (nodeId: string): Promise<void> => {
  const bound = listRemoteServerBindings(nodeId).filter((row) => row.upstreamName);
  for (const binding of bound) {
    try {
      await disconnectRemoteServer(nodeId, binding.serverName);
      await connectRemoteServer(nodeId, binding.serverName);
    } catch {
      logger.warn('[node-links] failed to refresh upstream after credential change', {
        nodeId,
        serverName: binding.serverName,
      });
    }
  }
};

export const putNodeCredential = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.nodeId);
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ success: false, message: 'token is required' });
      return;
    }
    await setCredential(node, token);
    await refreshNodeLinks(node.id);
    audit(req, 'node-link.credential-set', { nodeId: node.id, nodeName: node.name });
    res.json({ success: true, data: await credentialStatus(node) });
  } catch (error) {
    fail(res, error);
  }
};

export const deleteNodeCredential = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.nodeId);
    await deleteCredential(node);
    for (const binding of listRemoteServerBindings(node.id).filter((row) => row.upstreamName)) {
      try {
        await disconnectRemoteServer(node.id, binding.serverName);
      } catch {
        logger.warn('[node-links] failed to detach upstream after credential removal', {
          nodeId: node.id,
          serverName: binding.serverName,
        });
      }
    }
    audit(req, 'node-link.credential-delete', { nodeId: node.id, nodeName: node.name });
    res.json({ success: true, data: await credentialStatus(node) });
  } catch (error) {
    fail(res, error);
  }
};

export const getNodeCredential = async (req: Request, res: Response): Promise<void> => {
  try {
    const node = getRemoteNodeInternal(req.params.nodeId);
    res.json({ success: true, data: await credentialStatus(node) });
  } catch (error) {
    fail(res, error);
  }
};
