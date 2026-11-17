/**
 * Built-in, pre-configured upstream servers.
 *
 * MCPHub is deployed inside VOS next to services such as Gitea. Those pairings
 * are part of the deployment, not something every user should have to configure
 * by hand, so the hub provisions them on first boot.
 *
 * Two rules keep that from turning into noise on deployments where the sibling
 * service is absent:
 *  - Only provision when the upstream answers. A missing app means no entry at
 *    all, not a red error on the dashboard.
 *  - Never overwrite an existing entry: once provisioned (or hand-edited) the
 *    stored configuration is the source of truth.
 */
import { randomUUID } from 'node:crypto';
import { getServerDao } from '../dao/DaoFactory.js';
import { getUserDao, type ServerConfigWithName } from '../dao/index.js';
import { logger } from '../utils/logger.js';

/** Config name of the provisioned Gitea MCP server. */
export const BUILTIN_GITEA_SERVER_NAME = 'gitea';

const DEFAULT_GITEA_MCP_URL = 'http://gitea-mcp:8080/mcp';
const PROBE_TIMEOUT_MS = 2500;

/** Interval between availability probes while the built-in server is absent. */
export const BUILTIN_PROBE_INTERVAL_MS = 60_000;

/** A deployment can opt out entirely (`MCPHUB_BUILTIN_GITEA=false`). */
export const builtinServersEnabled = (): boolean => process.env.MCPHUB_BUILTIN_GITEA !== 'false';

export const resolveBuiltinGiteaUrl = (): string =>
  (process.env.MCPHUB_GITEA_MCP_URL || DEFAULT_GITEA_MCP_URL).trim();

/**
 * Any HTTP answer proves the upstream is deployed and reachable; an MCP
 * endpoint legitimately replies 401/405 to a bare GET. Only DNS and connection
 * failures mean "not installed".
 */
export const isUpstreamReachable = async (
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const resolveOwner = async (): Promise<string | undefined> => {
  try {
    const users = await getUserDao().findAll();
    return (users.find((user) => user.isAdmin) ?? users[0])?.username;
  } catch {
    return undefined;
  }
};

/**
 * Create the built-in Gitea server when it is missing and the upstream answers.
 * Returns true when a new entry was written.
 *
 * `forwardVosToken` makes the hub authenticate every upstream call with the
 * caller's own VOS token, so the entry carries no shared credential and each
 * user reaches Gitea as themselves.
 */
export const ensureBuiltinGiteaServer = async (): Promise<boolean> => {
  if (!builtinServersEnabled()) return false;

  const url = resolveBuiltinGiteaUrl();
  const existing = await getServerDao().findAll();
  // Existing configuration (provisioned earlier or edited by an admin) wins.
  if (existing.some((server) => server.name === BUILTIN_GITEA_SERVER_NAME)) return false;

  if (!(await isUpstreamReachable(url))) {
    logger.log(`Built-in gitea MCP endpoint is not reachable (${url}); not provisioning`);
    return false;
  }

  const owner = await resolveOwner();
  const server: ServerConfigWithName = {
    name: BUILTIN_GITEA_SERVER_NAME,
    id: randomUUID(),
    type: 'streamable-http',
    url,
    forwardVosToken: true,
    enabled: true,
    // Every signed-in VOS user may use Gitea, each with their own token.
    visibility: 'public',
    ...(owner ? { owner } : {}),
  };

  try {
    await getServerDao().create(server);
    logger.log(`Provisioned built-in gitea MCP server at ${url}`);
    return true;
  } catch (error) {
    logger.warn('Could not provision the built-in gitea MCP server:', error);
    return false;
  }
};

/**
 * True when a configured forwarding server should stay invisible because its
 * upstream is gone. Only forwarding servers are gated: they exist to proxy a
 * caller's identity to a companion app, and that app being absent is a normal
 * state rather than an error.
 */
export const isForwardingServerAvailable = async (
  name: string,
  url: string | undefined,
): Promise<boolean> => {
  if (!url) return false;
  const reachable = await isUpstreamReachable(url);
  if (!reachable) {
    logger.log(`Upstream for forwarding server '${name}' is unreachable (${url}); hiding it`);
  }
  return reachable;
};
