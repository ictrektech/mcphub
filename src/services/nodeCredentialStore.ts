import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type CredentialSource = 'store' | null;

export interface CredentialStatus {
  configured: boolean;
  source: CredentialSource;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Node id is the canonical key. Node name (the mTLS CN) is only a read
 * fallback, so no stale alias is left behind when a node is renamed. */
export interface CredentialNode {
  id: string;
  name?: string;
}

const keysOf = (node: CredentialNode | string): string[] => {
  if (typeof node === 'string') return [validateNodeId(node)];
  const keys = [validateNodeId(node.id)];
  if (node.name && node.name !== node.id && ID_PATTERN.test(node.name)) keys.push(node.name);
  return keys;
};

/** Overridable for local development and tests; container default is the persistent volume. */
const storePath = (): string => join(process.env.MCP_NODE_SECRETS_DIR || '/app/data', 'node-secrets.json');

/** Placeholder name used in upstream configs; not an environment variable source. */
export const dataPlaneEnvNameOf = (nodeId: string): string =>
  `MCP_NODE_DATA_PLANE_TOKEN_${nodeId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 64)}`;

const validateNodeId = (nodeId: string): string => {
  if (typeof nodeId !== 'string' || !ID_PATTERN.test(nodeId)) {
    throw new Error('Invalid node id for credential store');
  }
  return nodeId;
};

const readStore = async (): Promise<Record<string, string>> => {
  let raw: string;
  try {
    raw = await readFile(storePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};

const writeStore = async (secrets: Record<string, string>): Promise<void> => {
  const target = storePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const getStoredCredential = async (
  node: CredentialNode | string,
): Promise<string | undefined> => {
  const secrets = await readStore();
  for (const key of keysOf(node)) {
    if (secrets[key]?.trim()) return secrets[key].trim();
  }
  return undefined;
};

export const setCredential = async (
  node: CredentialNode | string,
  token: string,
): Promise<void> => {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Credential token is required');
  }
  const secrets = await readStore();
  // Single canonical key: renaming a node must not leave a stale alias behind.
  secrets[keysOf(node)[0]] = token.trim();
  await writeStore(secrets);
};

export const deleteCredential = async (node: CredentialNode | string): Promise<void> => {
  const secrets = await readStore();
  for (const key of keysOf(node)) delete secrets[key];
  await writeStore(secrets);
};

/** Only the UI-managed private file is a credential source. No env fallback. */
export const resolveDataPlaneToken = async (
  node: CredentialNode | string,
): Promise<string | undefined> => getStoredCredential(node);

export const credentialStatus = async (node: CredentialNode | string): Promise<CredentialStatus> =>
  (await getStoredCredential(node))
    ? { configured: true, source: 'store' }
    : { configured: false, source: null };
