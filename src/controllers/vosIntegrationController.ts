import type { Request, Response } from 'express';
import config from '../config/index.js';
import { getServerDao } from '../dao/DaoFactory.js';
import { getServersInfo } from '../services/mcpService.js';
import { authorizationService } from '../services/authorizationService.js';
import { isVosAuthEnabled, type VosPrincipal } from '../services/vosAuthService.js';

function principal(req: Request, res: Response): VosPrincipal | null {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!isVosAuthEnabled()) {
    res.sendStatus(404);
    return null;
  }
  const user = (req as Request & { user?: VosPrincipal }).user;
  if (!user) {
    res.sendStatus(401);
    return null;
  }
  return user;
}

export function vosWhoami(req: Request, res: Response): void {
  const user = principal(req, res);
  if (!user) return;
  res.json({
    success: true,
    data: {
      kind: user.applicationId ? 'application' : 'user',
      sub: user.vosSubject ?? user.applicationId,
      username: user.username,
      is_admin: user.isAdmin === true,
      application_id: user.applicationId,
      scope: user.applicationId ? 'public' : 'user-visible',
    },
  });
}

export async function vosDiscovery(req: Request, res: Response): Promise<void> {
  const user = principal(req, res);
  if (!user) return;
  const [records, runtime] = await Promise.all([getServerDao().findAll(), getServersInfo()]);
  const status = new Map(runtime.map((server) => [server.name, server]));
  // Explicit metadata allowlist: never serialize configuration, URLs, keys or env.
  const servers = records
    .filter(
      (server) =>
        server.enabled !== false && authorizationService.can('server.discover', server, user),
    )
    .map((server) => ({
      name: server.name,
      description: server.description ?? '',
      visibility: server.visibility ?? 'private',
      status: status.get(server.name)?.status ?? 'disconnected',
      mcp_path: `${config.basePath}/mcp/${encodeURIComponent(server.name)}`,
    }));
  res.json({
    success: true,
    data: {
      protocol: 'mcp',
      transport: 'streamable-http',
      auth: 'VOS Bearer token',
      mcp_path: `${config.basePath}/mcp`,
      servers,
    },
  });
}
