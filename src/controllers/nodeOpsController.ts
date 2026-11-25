// Node-to-node operations API (see mcp-node-ops-plan.md §3.4).
//
// A soft, connection-level control plane between MCPHub peers: a peer can list
// what this node serves, read diagnostic output, export/import portable server
// definitions and enable/disable connections — never touch processes. All
// actions are gated by the node-token middleware (src/middlewares/nodeToken.ts)
// and reuse the same services the dashboard uses, so visibility and ownership
// rules stay identical.

import type { Request, Response } from 'express';
import os from 'os';
import config from '../config/index.js';
import { getServerDao } from '../dao/DaoFactory.js';
import type { ServerConfigWithName } from '../dao/ServerDao.js';
import { nodePeerOf, peerPrincipal } from '../middlewares/nodeToken.js';
import { DataService } from '../services/dataService.js';
import { authorizationService } from '../services/authorizationService.js';
import { presentServerForPrincipal } from '../services/serverConfigPresenter.js';
import { nodeCertIdentityOf } from '../services/nodeOpsTls.js';
import logService from '../services/logService.js';
import { logger } from '../utils/logger.js';
import { normalizeServerConfigForPersistence } from '../utils/serverConfigPersistence.js';
import { auditNodeAction } from '../utils/nodeAudit.js';
import type {
  NodeOpsDefinitionData,
  NodeOpsImportData,
  NodeOpsImportRequest,
  NodeOpsListData,
  NodeOpsLogsData,
  NodeOpsServerSummary,
  NodeOpsToggleData,
} from '../types/index.js';
import type { IUser, ServerVisibility } from '../types/index.js';

// Same pattern as remoteServerBindingService.NAME_PATTERN (§3.4 import rules).
const NAME_PATTERN = /^[\w.$~%-]{1,128}$/;

// mcpService pulls in the OAuth/SDK modules (openid-client is ESM-only, which
// Jest cannot parse when the route table is imported without mocks). Load it on
// first use instead, the same way remoteServerRegistrationService does.
type McpServiceModule = typeof import('../services/mcpService.js');
let mcpServiceModule: Promise<McpServiceModule> | undefined;
const loadMcpService = (): Promise<McpServiceModule> =>
  (mcpServiceModule ??= import('../services/mcpService.js'));

// Portable definition whitelist (§3.4 export). Everything else is stripped so
// oauth tokens, credential templates, proxy config and ownership metadata never
// leave the node.
const DEFINITION_KEYS = [
  'type',
  'url',
  'command',
  'args',
  'env',
  'headers',
  'passthroughHeaders',
  'description',
  'protocolNegotiation',
  'enableKeepAlive',
  'keepAliveInterval',
  'startOnDemand',
  'idleTimeoutMs',
  'options',
  'openapi',
  'tools',
  'prompts',
  'resources',
] as const;

// Keys whose presence in an import payload is rejected outright: they would
// forge ownership or smuggle OAuth material past the export whitelist.
const FORBIDDEN_DEFINITION_KEYS = [
  'oauth',
  'credentialTemplate',
  'proxy',
  'id',
  'owner',
  'visibility',
  'nodeId',
] as const;

const MAX_LIST_ENTRIES = 500;
const MAX_TAIL = 2000;
const MAX_DEFINITION_BYTES = 256 * 1024;

const fail = (
  res: Response,
  status: number,
  code: string,
  message = code,
): void => {
  res.status(status).json({ success: false, code, message });
};

// §A-2: every audit line carries the client-cert fingerprint (null on plain HTTP).
const certFingerprintOf = (req: Request): string | null =>
  nodeCertIdentityOf(req).fingerprint ?? null;

const pickDefinition = (
  source: Record<string, unknown>,
): Partial<ServerConfigWithName> => {
  const definition: Record<string, unknown> = {};
  for (const key of DEFINITION_KEYS) {
    if (source[key] !== undefined) definition[key] = source[key];
  }
  return definition as Partial<ServerConfigWithName>;
};

/**
 * Latest connection status for one server, straight from the live registry —
 * never hardcoded, so `connecting` / `oauth_required` are reported as-is.
 */
const statusOf = async (
  name: string,
  fallback: NonNullable<NodeOpsServerSummary['status']>,
): Promise<NonNullable<NodeOpsServerSummary['status']>> => {
  const { getServersInfo } = await loadMcpService();
  const infos = await getServersInfo();
  return infos.find((info) => info.name === name)?.status ?? fallback;
};

const statusMap = async (): Promise<Map<string, NonNullable<NodeOpsServerSummary['status']>>> => {
  const { getServersInfo } = await loadMcpService();
  const infos = await getServersInfo();
  return new Map(infos.map((info) => [info.name, info.status]));
};

// `GET /node-ops/health` — valid token only, no action required.
export const nodeOpsHealth = (req: Request, res: Response): void => {
  const peer = nodePeerOf(req);
  res.json({
    success: true,
    data: {
      name: process.env.MCPHUB_NODE_NAME || os.hostname(),
      version: config.mcpHubVersion,
      uptimeSeconds: Math.floor(process.uptime()),
      basePath: config.basePath,
      port: Number(config.port),
      capabilities: peer.actions,
    },
  });
};

// `GET /node-ops/servers` — needs `read`; visibility via dataService.filterData.
export const nodeOpsListServers = async (req: Request, res: Response): Promise<void> => {
  const peer = nodePeerOf(req);
  const principal = peerPrincipal(peer);
  const records = await getServerDao().findAll();
  const visible = new DataService().filterData(
    records,
    principal as unknown as IUser,
  );
  const statuses = await statusMap();
  const truncated = visible.length > MAX_LIST_ENTRIES;
  const servers: NodeOpsServerSummary[] = visible.slice(0, MAX_LIST_ENTRIES).map((record) => {
    const entry: NodeOpsServerSummary = {
      name: record.name,
      // Legacy/manual settings may omit `type`; derive it the same way the
      // persistence layer does instead of dropping the contract field.
      type: record.type ?? normalizeServerConfigForPersistence(record).type,
      enabled: record.enabled !== false,
      status: statuses.get(record.name) ?? 'disconnected',
      owner: record.owner,
      visibility: record.visibility,
      description: record.description,
      // Relative path: the caller supplies the host. Mirrors vosDiscovery.
      mcpPath: `${config.basePath}/mcp/${encodeURIComponent(record.name)}`,
    };
    // The upstream URL only leaves the node when the peer may read full configs.
    if (
      peer.actions.includes('definition') &&
      record.url &&
      authorizationService.can('server.config.read', record, principal)
    ) {
      entry.endpoint = record.url;
    }
    return entry;
  });
  const data: NodeOpsListData = { truncated, servers };
  res.json({ success: true, data });
};

// `GET /node-ops/servers/:name/logs` — needs `logs` + `server.discover`.
export const nodeOpsServerLogs = async (req: Request, res: Response): Promise<void> => {
  const name = req.params.name;
  const peer = nodePeerOf(req);
  const principal = peerPrincipal(peer);

  const rawTail = req.query.tail;
  const tail = rawTail === undefined ? 200 : Number(rawTail);
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
    fail(res, 400, 'invalid-tail', 'tail must be an integer between 1 and 2000');
    return;
  }

  const record = await getServerDao().findById(name);
  if (!record) {
    fail(res, 404, 'server-not-found');
    return;
  }
  if (!authorizationService.can('server.discover', record, principal)) {
    fail(res, 403, 'node-scope-forbidden');
    return;
  }

  // Reverse scan keeps the newest `tail` matches without sorting by timestamp.
  const entries = logService.getLogs();
  const matched: typeof entries = [];
  const plain = `"serverName":"${name}"`;
  const spaced = `serverName: '${name}'`;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.source === name ||
      entry.message.includes(plain) ||
      entry.message.includes(spaced)
    ) {
      matched.push(entry);
    }
  }

  const text = matched
    .slice(0, tail)
    .reverse()
    .map(
      (entry) =>
        `[${new Date(entry.timestamp).toISOString()}] [${entry.type.toUpperCase()}] [${entry.source}] ${entry.message}`,
    )
    .join('\n');

  const data: NodeOpsLogsData = {
    text,
    truncated: matched.length > tail,
    matched: matched.length,
    partial: true,
  };
  res.json({ success: true, data });
};

// `GET /node-ops/servers/:name/definition` — needs `definition` + full config view.
export const nodeOpsServerDefinition = async (req: Request, res: Response): Promise<void> => {
  const name = req.params.name;
  const peer = nodePeerOf(req);
  const principal = peerPrincipal(peer);

  const record = await getServerDao().findById(name);
  if (!record) {
    auditNodeAction({ peer: peer.name, action: 'definition', server: name, ok: false, code: 'server-not-found', certFingerprint: certFingerprintOf(req) });
    fail(res, 404, 'server-not-found');
    return;
  }

  // Exporting carries env/headers secrets out of the node, so a non-full view
  // is refused instead of silently sanitized.
  const presented = presentServerForPrincipal(record, principal);
  if (presented.view !== 'full') {
    auditNodeAction({ peer: peer.name, action: 'definition', server: name, ok: false, code: 'node-scope-forbidden', certFingerprint: certFingerprintOf(req) });
    fail(res, 403, 'node-scope-forbidden');
    return;
  }

  const data: NodeOpsDefinitionData = {
    name,
    definition: pickDefinition(presented.data as unknown as Record<string, unknown>),
  };
  auditNodeAction({ peer: peer.name, action: 'definition', server: name, ok: true, certFingerprint: certFingerprintOf(req) });
  res.json({ success: true, data });
};

// `POST /node-ops/servers/:name/enable` — needs `control` + `server.manage`.
export const nodeOpsEnableServer = async (req: Request, res: Response): Promise<void> => {
  await toggleConnection(req, res, true);
};

// `POST /node-ops/servers/:name/disable` — needs `control` + `server.manage`.
export const nodeOpsDisableServer = async (req: Request, res: Response): Promise<void> => {
  await toggleConnection(req, res, false);
};

const toggleConnection = async (
  req: Request,
  res: Response,
  enabled: boolean,
): Promise<void> => {
  const name = req.params.name;
  const peer = nodePeerOf(req);
  const principal = peerPrincipal(peer);
  const action = enabled ? 'enable' : 'disable';

  const record = await getServerDao().findById(name);
  if (!record) {
    auditNodeAction({ peer: peer.name, action, server: name, ok: false, code: 'server-not-found', certFingerprint: certFingerprintOf(req) });
    fail(res, 404, 'server-not-found');
    return;
  }
  if (!authorizationService.can('server.manage', record, principal)) {
    auditNodeAction({ peer: peer.name, action, server: name, ok: false, code: 'node-scope-forbidden', certFingerprint: certFingerprintOf(req) });
    fail(res, 403, 'node-scope-forbidden');
    return;
  }

  const mcp = await loadMcpService();
  const result = await mcp.toggleServerStatus(name, enabled);
  if (!result.success) {
    // Contract error table has no toggle-specific code; fold into invalid-body
    // with the original message preserved.
    auditNodeAction({ peer: peer.name, action, server: name, ok: false, code: 'invalid-body', certFingerprint: certFingerprintOf(req) });
    fail(res, 400, 'invalid-body', result.message || 'Failed to toggle server connection');
    return;
  }

  // Disabling must remove the server from every connected agent's view at once
  // (same trio as serverController.toggleServer); enabling broadcasts through
  // initializeClientsFromSettings internally.
  if (!enabled) {
    mcp.broadcastToolListChanged();
    mcp.broadcastPromptListChanged();
    mcp.broadcastResourceListChanged();
  }

  // oauth_required is a business state: 200 here, the caller decides next steps.
  const status = await statusOf(name, enabled ? 'connecting' : 'disconnected');
  const data: NodeOpsToggleData = { name, enabled, status };
  auditNodeAction({ peer: peer.name, action, server: name, ok: true, certFingerprint: certFingerprintOf(req) });
  res.json({ success: true, data });
};

// `POST /node-ops/servers` — needs `import` (+ `import-stdio` for stdio definitions).
export const nodeOpsImportServer = async (req: Request, res: Response): Promise<void> => {
  const peer = nodePeerOf(req);
  const body = req.body as Partial<NodeOpsImportRequest>;
  const audit = (ok: boolean, code?: string) =>
    auditNodeAction({
      peer: peer.name,
      action: 'import',
      server: typeof body?.name === 'string' ? body.name : '-',
      ok,
      code: code ?? null,
      certFingerprint: certFingerprintOf(req),
    });
  // Every rejection from a write action leaves one audit line (§3.6).
  const failAudited = (status: number, code: string, message?: string) => {
    audit(false, code);
    fail(res, status, code, message);
  };

  const name = body?.name;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    failAudited(400, 'invalid-name', 'name must match ^[\\w.$~%-]{1,128}$');
    return;
  }

  const definition = body?.definition;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    failAudited(400, 'invalid-body', 'definition object is required');
    return;
  }
  if (Buffer.byteLength(JSON.stringify(definition)) > MAX_DEFINITION_BYTES) {
    failAudited(400, 'definition-too-large', 'definition exceeds 256 KB');
    return;
  }
  const def = definition as Record<string, unknown>;
  if (FORBIDDEN_DEFINITION_KEYS.some((key) => key in def)) {
    failAudited(400, 'invalid-definition', 'definition contains forbidden keys');
    return;
  }

  const type = def.type;
  if (type === 'stdio' && !peer.actions.includes('import-stdio')) {
    failAudited(403, 'stdio-import-forbidden', 'importing stdio definitions requires the import-stdio action');
    return;
  }
  if (!['stdio', 'sse', 'streamable-http', 'openapi'].includes(String(type))) {
    failAudited(400, 'invalid-definition', 'definition.type must be stdio, sse, streamable-http or openapi');
    return;
  }
  if (type !== 'stdio' && type !== 'openapi' && typeof def.url !== 'string') {
    failAudited(400, 'invalid-definition', `url is required for ${String(type)} definitions`);
    return;
  }
  if (type === 'stdio') {
    if (typeof def.command !== 'string') {
      failAudited(400, 'invalid-definition', 'command is required for stdio definitions');
      return;
    }
    if ('headers' in def) {
      failAudited(400, 'invalid-definition', 'headers are not supported for stdio definitions');
      return;
    }
  }
  if (type === 'openapi') {
    const openapi = def.openapi as { url?: unknown; schema?: unknown } | undefined;
    if (!openapi || (typeof openapi.url !== 'string' && typeof openapi.schema !== 'string')) {
      failAudited(400, 'invalid-definition', 'openapi.url or openapi.schema is required for openapi definitions');
      return;
    }
  }

  const visibility = (body?.visibility ?? 'public') as ServerVisibility;
  if (!['public', 'private', 'group'].includes(visibility)) {
    failAudited(400, 'invalid-definition', 'visibility must be public, private or group');
    return;
  }

  // Duplicate pre-check; a concurrent insert between this and addServer still
  // lands in the addServer failure branch below.
  const existing = await getServerDao().findById(name);
  if (existing) {
    failAudited(409, 'server-duplicate', 'a server with this name already exists');
    return;
  }

  // Env vars stay as-is (`${VAR}` travels unexpanded; the importing node
  // resolves them locally so secrets never move between machines).
  const configToPersist = normalizeServerConfigForPersistence(
    pickDefinition(def) as ServerConfigWithName,
  );
  configToPersist.enabled = body?.enable !== false;
  // Only an admin-scope peer may reassign ownership; a node-scope peer always
  // owns what it imports, otherwise it could forge ownership (or hand its own
  // import to someone else and lose manage rights over it).
  configToPersist.owner =
    peer.scope === 'admin' && typeof body?.owner === 'string' ? body.owner : peer.name;
  configToPersist.visibility = visibility;

  const mcp = await loadMcpService();
  const result = await mcp.addServer(name, configToPersist);
  if (!result.success) {
    failAudited(400, 'invalid-definition', result.message || 'Failed to add server');
    return;
  }

  if (configToPersist.enabled) {
    await mcp.toggleServerStatus(name, true);
  }
  mcp.notifyToolChanged(name, { reportEmbeddingProgress: true }).catch((error) => {
    logger.error('[node-ops] failed to refresh tools for imported server:', error);
  });

  const status = configToPersist.enabled
    ? await statusOf(name, 'connecting')
    : 'disconnected';
  const data: NodeOpsImportData = {
    name,
    created: true,
    enabled: configToPersist.enabled,
    status,
  };
  audit(true);
  res.json({ success: true, data });
};

// Catch-all so unknown `/node-ops/*` paths answer with JSON (never the SPA
// index) — see §5 step 0 acceptance item (d).
export const nodeOpsNotFound = (_req: Request, res: Response): void => {
  fail(res, 404, 'not-found', 'Unknown node-ops endpoint');
};
