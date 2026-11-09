// VOS adaptation: identities come only from the configured platform userinfo endpoint.
import { createHash, randomBytes } from 'node:crypto';
import { getUserDao } from '../dao/DaoFactory.js';
import type { IUser } from '../types/index.js';
import { decodeJwt } from 'jose';

export const isVosAuthEnabled = (): boolean => process.env.VOS_AUTH_ENABLED === 'true';

export type VosPrincipal = IUser & {
  applicationId?: string;
  vosSubject?: string;
  credentialEligible?: boolean;
};

// This only selects the verifier; it never authenticates or grants a role.
export function isVosBearerToken(token: string): boolean {
  try {
    const payload = decodeJwt(token);
    return typeof payload.application === 'string' && typeof payload.user_id === 'string';
  } catch {
    return false;
  }
}

export async function authenticateVosToken(
  token: string | undefined,
  options: { allowApplication?: boolean } = {},
): Promise<VosPrincipal> {
  if (!isVosAuthEnabled() || !token || token.length > 16384 || /[\r\n]/.test(token)) {
    throw new Error('VOS sign-in required');
  }
  // Never derive the verifier URL from request headers or a browser-supplied URL.
  const endpoint = new URL(process.env.VOS_USERINFO_URL || '');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Invalid VOS userinfo configuration');
  }
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('VOS sign-in rejected');
  const claims: Record<string, unknown> = await response.json();
  if (
    typeof claims.sub !== 'string' ||
    !claims.sub.trim() ||
    claims.sub.length > 512 ||
    claims.enable !== 1
  ) {
    throw new Error('Invalid or disabled VOS identity');
  }
  // Read the token kind only AFTER the platform has verified this exact token.
  // VOS currently gives app-context tokens an admin role. Never inherit it.
  let application: unknown;
  try {
    application = decodeJwt(token).application;
  } catch {
    /* Opaque tokens are verified by userinfo. */
  }
  if (application === 'app') {
    if (!options.allowApplication) throw new Error('A VOS user account is required');
    return {
      username: `vos-app:${claims.sub}`,
      password: '',
      isAdmin: false,
      applicationId: claims.sub,
      credentialEligible: false,
    };
  }
  // Userinfo provides the current role from the platform database, not a browser claim.
  const isAdmin = claims.role_code === 'system_admin' || claims.role_code === 'platform_admin';
  // The VOS user ID survives gateway address/port changes and account renames.
  const digest = createHash('sha256').update(claims.sub).digest('hex');
  const ssoUserId = `vos:${digest}`;
  const dao = getUserDao();
  let user = await dao.findBySsoUserId(ssoUserId);
  if (!user) {
    const preferred =
      typeof claims.preferred_username === 'string'
        ? claims.preferred_username.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80)
        : 'user';
    // Always namespace local usernames: matching names/emails never link accounts.
    const username = `vos-${preferred || 'user'}-${digest.slice(0, 12)}`;
    try {
      user = await dao.createWithHashedPassword(
        username,
        randomBytes(32).toString('hex'),
        isAdmin,
        undefined,
        ssoUserId,
      );
    } catch {
      // The DAO serializes JSON writes and the DB has a unique SSO identity constraint.
      user = await dao.findBySsoUserId(ssoUserId);
      if (!user) throw new Error('Could not provision VOS identity');
    }
  }
  if (user.isAdmin !== isAdmin) {
    user = await dao.update(user.username, { isAdmin });
    if (!user) throw new Error('Could not update VOS role');
  }
  return { ...user, vosSubject: claims.sub };
}
