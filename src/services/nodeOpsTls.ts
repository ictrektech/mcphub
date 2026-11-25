// Control-plane TLS for the node-ops API (mcp-node-ops-plan.md §4 A-2).
//
// The same express app is served over a second, mTLS-only listener so node
// peers authenticate with a client certificate (identity) while the bearer
// token keeps answering "which actions" (authorization). No business routes
// are duplicated here.

import fs from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import express, { type Application, type Request } from 'express';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

export const NODE_OPS_CN_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Persistent volume directory holding the control-plane PKI. This is where
 * the §9 bootstrap writes ca.pem / server.crt / server.key / ca.key on first
 * start; explicit env vars (MCP_NODE_OPS_TLS_*) still take precedence. */
export const certsDir = (): string =>
  process.env.MCP_NODE_OPS_CERT_DIR
  || join(process.env.MCP_NODE_SECRETS_DIR || '/app/data', 'certs');

export interface NodeOpsTlsMaterials {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
}

const envFile = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
};

/**
 * Loads the three certificate files. Env-provided paths win; without them the
 * §9 bootstrap directory (/app/data/certs by default) is used, so a
 * self-bootstrapped hub needs zero configuration. Any missing/unreadable file
 * means the control plane does not start (no automatic downgrade); callers
 * must leave the HTTP-port behaviour to the REQUIRE_TLS gate in nodeToken.ts.
 */
export const resolveNodeOpsTlsMaterials = (): NodeOpsTlsMaterials | null => {
  const certPath = envFile('MCP_NODE_OPS_TLS_CERT') ?? join(certsDir(), 'server.crt');
  const keyPath = envFile('MCP_NODE_OPS_TLS_KEY') ?? join(certsDir(), 'server.key');
  const caPath = envFile('MCP_NODE_OPS_TLS_CA') ?? join(certsDir(), 'ca.pem');

  try {
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      ca: fs.readFileSync(caPath),
    };
  } catch (error) {
    logger.warn(
      '[node-ops] TLS materials not available; control plane will not start.',
      {
        reason: error instanceof Error ? error.message : String(error),
        certPath, keyPath, caPath,
      },
    );
    return null;
  }
};

/**
 * Starts the mTLS listener for the shared express app. Returns null when the
 * certificate files are absent — the HTTP listener is the only one then.
 */
export const startNodeOpsTlsServer = (app: Application): https.Server | null => {
  const materials = resolveNodeOpsTlsMaterials();
  if (!materials) {
    if (envFile('MCP_NODE_OPS_TLS_CERT') || envFile('MCP_NODE_OPS_TLS_KEY') || envFile('MCP_NODE_OPS_TLS_CA')) {
      logger.warn(
        '[node-ops] MCP_NODE_OPS_TLS_CERT/KEY/CA are not all set; no mTLS control plane. ' +
          'With MCP_NODE_OPS_REQUIRE_TLS=true (default) every /node-ops request on the HTTP port answers 403 tls-required.',
      );
    }
    return null;
  }

  const port = Number(process.env.MCP_NODE_OPS_PORT || 31890);

  // The mTLS listener exposes only the node-ops control plane: the dashboard
  // and /api stay on the VOS-governed HTTP entry points, so a leaked client
  // certificate cannot reach them. Both the basePath-qualified and the bare
  // /node-ops prefix are accepted (the latter keeps direct deployments and
  // tests simple).
  const basePathPrefix = `${config.basePath}/node-ops`;
  const isNodeOpsPath = (p: string): boolean =>
    p === '/node-ops' ||
    p.startsWith('/node-ops/') ||
    p === basePathPrefix ||
    p.startsWith(`${basePathPrefix}/`);
  const controlPlane = express();
  controlPlane.use((req, res, next) => {
    if (isNodeOpsPath(req.path)) {
      next();
      return;
    }
    res.status(404).json({
      success: false,
      code: 'not-found',
      message: 'Only /node-ops is served on the mTLS control plane',
    });
  });
  controlPlane.use(app);

  const server = https.createServer(
    {
      key: materials.key,
      cert: materials.cert,
      ca: materials.ca,
      // Mutual TLS: the client must present a certificate signed by our CA,
      // otherwise the handshake fails before any handler runs.
      requestCert: true,
      rejectUnauthorized: true,
    },
    controlPlane,
  );
  // A busy/invalid port must not escalate to an uncaughtException (and the
  // misleading [FATAL]/[RECOVERY] pair): log once and shut the listener down.
  server.on('error', (error: Error) => {
    logger.error('[node-ops] control plane listener failed; mTLS control plane is down.', {
      reason: error.message,
    });
    server.close();
  });
  server.listen(port, () => {
    logger.log(`node-ops control plane listening on :${port} (mTLS)`);
  });
  return server;
};

/** Server-only HTTPS listener for the /mcp data plane. The MCP SDK cannot
 * present a client certificate, so this port encrypts traffic and relies on
 * the peer Bearer key for authentication. Same cert as the control plane. */
export const startNodeDataTlsServer = (app: Application): https.Server | null => {
  const materials = resolveNodeOpsTlsMaterials();
  if (!materials) return null;
  const port = Number(process.env.MCP_NODE_DATA_TLS_PORT || 31891);
  const mcpBase = `${config.basePath}/mcp`;

  const dataPlane = express();
  dataPlane.use((req, res, next) => {
    const p = req.path;
    const isMcp =
      p === mcpBase ||
      p.startsWith(`${mcpBase}/`) ||
      p === '/mcp' ||
      p.startsWith('/mcp/') ||
      /^\/[^/]+\/mcp(\/|$)/.test(p);
    if (isMcp) {
      next();
      return;
    }
    res.status(404).json({
      success: false,
      code: 'not-found',
      message: 'Only /mcp is served on the data-plane TLS port',
    });
  });
  dataPlane.use(app);

  const server = https.createServer(
    { key: materials.key, cert: materials.cert },
    dataPlane,
  );
  server.on('error', (error: Error) => {
    logger.error('[node-ops] data-plane TLS listener failed.', { reason: error.message });
    server.close();
  });
  server.listen(port, () => {
    logger.log(`node MCP data plane listening on :${port} (TLS)`);
  });
  return server;
};

export interface NodeCertIdentity {
  cn?: string;
  fingerprint?: string;
}

/**
 * Client-certificate identity of the request's TLS socket. Empty for plain
 * HTTP sockets or handshakes without a client certificate.
 */
export const nodeCertIdentityOf = (req: Request): NodeCertIdentity => {
  const socket = req.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== 'function') return {};
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return {};
  const cn = cert.subject?.CN;
  // fingerprint256 is colon-separated uppercase hex; keep 16 hex chars only.
  const fingerprint = cert.fingerprint256
    ? cert.fingerprint256.replace(/:/g, '').toLowerCase().slice(0, 16)
    : undefined;
  return { cn: typeof cn === 'string' ? cn : undefined, fingerprint };
};

/** True when the request arrived over the TLS listener. */
export const isTlsRequest = (req: Request): boolean =>
  (req.socket as TLSSocket).encrypted === true;
