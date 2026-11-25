import { replaceEnvVars } from '../config/index.js';
import { getUserDao } from '../dao/index.js';
import { resolveDataPlaneToken } from './nodeCredentialStore.js';
import { hasCredentialTemplate } from '../utils/credentialTemplate.js';
import type { ServerConfig } from '../types/index.js';

/** Machine credentials are resolved at connect time, never stored in config. */
const dataPlaneSecretEnv = async (
  config: ServerConfig,
): Promise<Record<string, string>> => {
  if (!config.dataPlaneTokenEnv || !config.dataPlaneNodeId) return {};
  const token = await resolveDataPlaneToken(config.dataPlaneNodeId);
  return token ? { [config.dataPlaneTokenEnv]: token } : {};
};

/** Ownerless operator configuration is trusted; missing owners fail closed. */
export const getServerEnvironment = async (
  config: ServerConfig,
): Promise<Record<string, string>> => {
  const trusted =
    !config.owner || (await getUserDao().findByUsername(config.owner))?.isAdmin === true;
  const source = trusted ? process.env : {};
  return {
    ...(source as Record<string, string>),
    ...(trusted ? await dataPlaneSecretEnv(config) : {}),
    ...(hasCredentialTemplate(config) ? config.env : replaceEnvVars(config.env || {}, source)),
  };
};

export const expandServerConfig = async <T extends ServerConfig>(config: T): Promise<T> => {
  const { owner, visibility, sharedWithUsers, sharedWithUserGroups, ...transportConfig } = config;
  const expanded = replaceEnvVars(transportConfig, await getServerEnvironment(config)) as T;
  // Keep the env reference in config copies exposed by /api/servers. The
  // transport resolves the placeholder from getServerEnvironment() at connect
  // time; expanding it here would put the Bearer key into a presented config.
  const auth = config.headers?.Authorization;
  if (config.dataPlaneTokenEnv && typeof auth === 'string') {
    expanded.headers = { ...(expanded.headers ?? {}), Authorization: auth };
  }
  // Authorization metadata is literal and must never be controlled by expansion values.
  return {
    ...expanded,
    owner,
    visibility,
    sharedWithUsers,
    sharedWithUserGroups,
  } as T;
};
