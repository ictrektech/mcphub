// VOS adaptation: PKCE fastpath tokens stay in memory, never in browser storage or URLs.
import type { AuthResponse } from '../types';
import { getApiUrl, getRuntimeConfig } from '../utils/runtime';

interface TokenSet {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}
interface PlatformUser {
  sub: string;
}
interface VosBridge {
  api?: {
    v1000?: {
      oauth2?: {
        authorize(params: Record<string, string>): Promise<{ code: string; state: string }>;
        token(params: Record<string, string>): Promise<TokenSet>;
      };
    };
  };
  platform?: { getUser?(): Promise<PlatformUser | null> };
  getState?(): Promise<{ locale?: unknown }>;
  broadcast?: {
    on(
      event: 'user-change' | 'locale-change',
      handler: (data: { locale?: unknown }) => void,
    ): void | (() => void);
    off?(
      event: 'user-change' | 'locale-change',
      handler: (data: { locale?: unknown }) => void,
    ): void;
  };
}
declare global {
  interface Window {
    vos_platform?: VosBridge;
  }
}

const CLIENT_ID = 'com.ictrek.mcphub';
interface VosSession {
  token: TokenSet;
  expiresAt: number;
  subject?: string;
  user: NonNullable<AuthResponse['user']>;
}
let session: VosSession | null = null;
let pending: Promise<VosSession | null> | null = null;
let epoch = 0;

export const isVosMode = (): boolean => getRuntimeConfig().vosAuthEnabled === true;
export function clearVosSession(): void {
  epoch++;
  session = null;
  pending = null;
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function waitForBridge(): Promise<VosBridge> {
  const deadline = Date.now() + 3000;
  do {
    const bridge = window.vos_platform;
    if (
      typeof bridge?.api?.v1000?.oauth2?.authorize === 'function' &&
      typeof bridge.api.v1000.oauth2.token === 'function'
    )
      return bridge;
    if (window.parent === window) break;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('VOS sign-in unavailable');
}

export async function getVosSession(): Promise<VosSession | null> {
  if (!isVosMode()) return null;
  if (pending) return pending;
  const generation = epoch;
  pending = (async () => {
    const bridge = await waitForBridge();
    const platformUser = await bridge.platform?.getUser?.();
    if (session && (platformUser === null || session.subject !== platformUser?.sub)) {
      clearVosSession();
      window.location.reload();
      throw new Error('VOS session changed');
    }
    if (platformUser === null) throw new Error('VOS signed out');
    if (session && session.subject === platformUser?.sub && Date.now() < session.expiresAt)
      return session;
    const oauth = bridge.api!.v1000!.oauth2!;
    let token: TokenSet;
    if (session?.token.refresh_token && session.subject === platformUser?.sub) {
      try {
        token = await oauth.token({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: session.token.refresh_token,
        });
      } catch {
        session = null;
        token = await authorize();
      }
    } else {
      token = await authorize();
    }
    async function authorize(): Promise<TokenSet> {
      const verifier = random(),
        state = random();
      const challenge = base64url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      );
      const grant = await oauth.authorize({
        client_id: CLIENT_ID,
        response_type: 'code',
        scope: 'openid profile email',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        nonce: random(),
      });
      if (grant.state !== state || !grant.code) throw new Error('VOS OIDC state mismatch');
      return oauth.token({
        grant_type: 'authorization_code',
        code: grant.code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
      });
    }
    if (!token.access_token) throw new Error('VOS token missing');
    // Raw fetch avoids recursively invoking the authenticated request interceptor.
    const response = await fetch(getApiUrl('/auth/vos'), {
      method: 'POST',
      // Safari drops the user's device-certificate exception for credentialless
      // requests. Keep the normal same-origin transport; the backend still
      // authenticates exclusively with the verified Bearer token.
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('VOS sign-in rejected');
    const result: AuthResponse = await response.json();
    if (!result.success || !result.user || generation !== epoch)
      throw new Error('VOS session changed');
    session = {
      token,
      subject: platformUser?.sub,
      user: result.user,
      expiresAt: Date.now() + Math.max(1, Math.min(token.expires_in ?? 300, 300) - 30) * 1000,
    };
    return session;
  })().finally(() => {
    if (generation === epoch) pending = null;
  });
  try {
    return await pending;
  } catch (error) {
    if (generation === epoch) session = null;
    throw error;
  }
}

export function watchVosUser(): () => void {
  const bridge = window.vos_platform;
  const changed = () => {
    clearVosSession();
    // Remove every previous user's page and pending UI state on account switching.
    window.location.reload();
  };
  const unsubscribe = bridge?.broadcast?.on('user-change', changed);
  return () => {
    if (typeof unsubscribe === 'function') unsubscribe();
    else bridge?.broadcast?.off?.('user-change', changed);
  };
}
