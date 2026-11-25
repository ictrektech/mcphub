import type { Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import config from '../config/index.js';
import type { RequestPrincipal } from '../services/authorizationService.js';
import { NODE_OPS_CN_PATTERN, isTlsRequest, nodeCertIdentityOf } from '../services/nodeOpsTls.js';
import { pairedPeersSnapshot } from '../services/nodePeerRegistry.js';
import { hashBearerToken } from '../utils/bearerKeyToken.js';
import { logger } from '../utils/logger.js';
import { safeCompare } from '../utils/safeCompare.js';

export type NodeAction = 'read' | 'logs' | 'definition' | 'control' | 'import' | 'import-stdio';

export interface NodePeer {
  name: string;
  actions: NodeAction[];
  scope: 'node' | 'admin';
}

const NODE_ACTIONS = new Set<string>([
  'read',
  'logs',
  'definition',
  'control',
  'import',
  'import-stdio',
]);
const NAME_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const WRITE_ACTIONS = new Set<NodeAction>(['control', 'import', 'import-stdio']);

type TokenPeer = NodePeer & { token: string };

/** Validates one peer entry. Throws a fixed reason code; never echoes token values. */
const validateEntry = (entry: unknown, index: number): TokenPeer => {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`entry-${index}-not-object`);
  }

  const { name, token, actions, scope } = entry as Record<string, unknown>;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(`entry-${index}-invalid-name`);
  }
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) {
    throw new Error(`entry-${index}-invalid-token`);
  }
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.some((action) => typeof action !== 'string' || !NODE_ACTIONS.has(action))
  ) {
    throw new Error(`entry-${index}-invalid-actions`);
  }
  if (scope !== undefined && scope !== 'node' && scope !== 'admin') {
    throw new Error(`entry-${index}-invalid-scope`);
  }

  return {
    name,
    token,
    actions: [...new Set(actions as NodeAction[])],
    scope: (scope as 'node' | 'admin' | undefined) ?? 'node',
  };
};

/**
 * Parses the whole table once at startup. Any validation failure discards the
 * table (never a partial allow-list) and logs a fixed reason: JSON.parse errors
 * can quote the offending input, which would leak a token into the log.
 */
const parseNodePeers = (raw: string | undefined): Map<string, NodePeer> => {
  const empty = () => {
    logger.warn('[node-ops] MCP_NODE_TOKENS is not configured; /node-ops is disabled (all 401).');
    return new Map<string, NodePeer>();
  };

  if (raw === undefined || raw.trim() === '') return empty();

  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    logger.error('[node-ops] MCP_NODE_TOKENS is not valid JSON; token table discarded.', {
      reason: 'invalid-json',
    });
    return new Map();
  }

  if (!Array.isArray(entries)) {
    logger.error('[node-ops] MCP_NODE_TOKENS must be a JSON array; token table discarded.', {
      reason: 'not-an-array',
    });
    return new Map();
  }

  try {
    const peers = new Map<string, NodePeer>();
    const names = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const peer = validateEntry(entry, index);
      if (names.has(peer.name)) throw new Error('duplicate-name');
      names.add(peer.name);
      // Only the digest is retained; the plaintext token is never stored.
      peers.set(hashBearerToken(peer.token), {
        name: peer.name,
        actions: peer.actions,
        scope: peer.scope,
      });
    }
    return peers;
  } catch (error) {
    logger.error('[node-ops] MCP_NODE_TOKENS validation failed; token table discarded.', {
      reason: error instanceof Error ? error.message : 'validation-failed',
    });
    return new Map();
  }
};

const peersByTokenHash = parseNodePeers(process.env.MCP_NODE_TOKENS);

/** Peers admitted through the pairing flow (§9): persisted, mtime-cached,
 * effective without a restart. They always carry the full action set. */
const pairedPeersByName = (): Map<string, NodePeer> => {
  const map = new Map<string, NodePeer>();
  for (const record of pairedPeersSnapshot()) {
    map.set(record.name, {
      name: record.name,
      actions: record.actions as NodeAction[],
      scope: 'admin',
    });
  }
  return map;
};

const bearerTokenOf = (req: Request): string | undefined => {
  const header = req.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] || undefined;
};

const findPeer = (presented: string): NodePeer | undefined => {
  const presentedHash = hashBearerToken(presented);
  for (const [storedHash, peer] of peersByTokenHash) {
    // safeCompare uses timingSafeEqual and keeps the comparison length-stable.
    if (safeCompare(storedHash, presentedHash)) return peer;
  }
  // Paired peers are keyed by name; hash-compare their stored digest.
  for (const record of pairedPeersSnapshot()) {
    if (safeCompare(record.tokenHash, presentedHash)) {
      return { name: record.name, actions: record.actions as NodeAction[], scope: 'admin' };
    }
  }
  return undefined;
};

const nodePeerKey = Symbol('nodePeer');
type RequestWithNodePeer = Request & { [nodePeerKey]?: NodePeer };

// Peers indexed by certificate CN: the client certificate proves *who* the
// caller is, the token decides *what* it may do (§A-2). Static env peers and
// dynamically paired peers are merged per lookup so pairing needs no restart.
const peersByName = (): Map<string, NodePeer> => {
  const map = new Map<string, NodePeer>(
    [...peersByTokenHash.values()].map((peer) => [peer.name, peer]),
  );
  for (const [name, peer] of pairedPeersByName()) map.set(name, peer);
  return map;
};

/** true unless explicitly disabled: plain-HTTP /node-ops answers 403 tls-required. */
const tlsRequired = (): boolean => process.env.MCP_NODE_OPS_REQUIRE_TLS !== 'false';

/** mTLS-only mode: the certificate alone identifies the peer, no Bearer token. */
const mTlsOnly = (): boolean => process.env.MCP_NODE_MTLS_ONLY === 'true';

const deny = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ success: false, code, message });
};

/** Client-cert CN, undefined for plain HTTP, missing certs or malformed CNs. */
const certCnOf = (req: Request): string | undefined => {
  const { cn } = nodeCertIdentityOf(req);
  return cn && NODE_OPS_CN_PATTERN.test(cn) ? cn : undefined;
};

export const nodePeerOf = (req: Request): NodePeer => {
  const peer = (req as RequestWithNodePeer)[nodePeerKey];
  // Only a request that passed requireNodeToken has a peer. Never re-derive it
  // from the header here: that would silently bypass the action check.
  if (!peer) throw new Error('[node-ops] node peer was not resolved by requireNodeToken');
  return peer;
};

export const peerPrincipal = (peer: NodePeer): RequestPrincipal => ({
  username: peer.name,
  userGroups: [],
  isAdmin: peer.scope === 'admin',
});

export const requireNodeToken = (action: NodeAction | null): RequestHandler => (req, res, next) => {
  // Control-plane gate first: with MCP_NODE_OPS_REQUIRE_TLS=true (default) the
  // node-ops API never answers on a plain HTTP socket, so bearer tokens cannot
  // leak by cleartext replay (§A-2, no automatic downgrade).
  if (tlsRequired() && !isTlsRequest(req)) {
    deny(res, 403, 'tls-required', 'node-ops requires the mTLS control plane');
    return;
  }

  const certCn = certCnOf(req);

  let peer: NodePeer | undefined;
  if (mTlsOnly()) {
    // Certificate alone: the CN must be a registered peer name.
    const byCert = certCn ? peersByName().get(certCn) : undefined;
    if (!byCert) {
      deny(res, 403, 'node-peer-unknown', 'Client certificate CN is not a registered node peer');
      return;
    }
    peer = byCert;
  } else {
    const presented = bearerTokenOf(req);
    if (!presented) {
      deny(res, 401, 'node-token-missing', 'Node token is required');
      return;
    }

    peer = findPeer(presented);
    if (!peer) {
      deny(res, 401, 'node-token-invalid', 'Node token is not valid');
      return;
    }

    // Second factor on the TLS listener: the certificate CN must identify the
    // same peer as the bearer token. On plain HTTP (REQUIRE_TLS=false, the
    // explicit downgrade) there is no certificate and the A-1 token-only
    // behaviour applies.
    if (isTlsRequest(req)) {
      if (!certCn || !peersByName().has(certCn)) {
        deny(res, 403, 'node-peer-unknown', 'Client certificate CN is not a registered node peer');
        return;
      }
      if (certCn !== peer.name) {
        deny(res, 403, 'node-peer-mismatch', 'Client certificate CN does not match the node token');
        return;
      }
    }
  }

  if (action !== null && !peer.actions.includes(action)) {
    deny(res, 403, 'node-action-forbidden', `Node token is not authorized for "${action}"`);
    return;
  }

  if (action !== null && WRITE_ACTIONS.has(action) && config.readonly) {
    deny(res, 403, 'readonly', 'MCPHub is running in read-only mode');
    return;
  }

  (req as RequestWithNodePeer)[nodePeerKey] = peer;
  next();
};

const parseRateLimitMax = (): number => {
  const raw = process.env.MCPHUB_NODE_OPS_RATE_LIMIT_MAX;
  if (raw === undefined || raw.trim() === '') return 600;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `Ignoring invalid MCPHUB_NODE_OPS_RATE_LIMIT_MAX="${raw}"; expected a positive integer. Using 600.`,
    );
    return 600;
  }
  return parsed;
};

const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  process.env.JEST_WORKER_ID !== undefined ||
  process.env.VITEST_WORKER_ID !== undefined;

// Built directly instead of through createStandardRateLimiter: the shared
// helper's option type has no `handler`, and the 429 body must carry the
// `code` required by the node-ops contract.
export const nodeOpsRateLimiter: RequestHandler = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: parseRateLimitMax(),
  standardHeaders: true,
  legacyHeaders: false,
  // Same test-env behavior as the shared helper so contract tests do not
  // consume a real rate-limit budget.
  skip: () => isTestEnv,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      code: 'rate-limited',
      message: 'Too many requests, please try again later.',
    });
  },
});
