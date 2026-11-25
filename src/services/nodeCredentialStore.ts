import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type CredentialSource = 'store' | 'env' | null;

export interface CredentialStatus {
  configured: boolean;
  source: CredentialSource;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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

export const getStoredCredential = async (nodeId: string): Promise<string | undefined> => {
  const secrets = await readStore();
  return secrets[validateNodeId(nodeId)];
};

export const setCredential = async (nodeId: string, token: string): Promise<void> => {
  const id = validateNodeId(nodeId);
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Credential token is required');
  }
  const secrets = await readStore();
  secrets[id] = token.trim();
  await writeStore(secrets);
};

export const deleteCredential = async (nodeId: string): Promise<void> => {
  const id = validateNodeId(nodeId);
  const secrets = await readStore();
  delete secrets[id];
  await writeStore(secrets);
};

/** Only the UI-managed private file is a credential source. No env fallback. */
export const resolveDataPlaneToken = async (nodeId: string): Promise<string | undefined> => {
  const stored = await getStoredCredential(nodeId);
  if (stored?.trim()) return stored.trim();
  // Deployment-time fallback: containers may inject the key instead of using the UI.
  return process.env[dataPlaneEnvNameOf(nodeId)]?.trim() || undefined;
};

export const credentialStatus = async (nodeId: string): Promise<CredentialStatus> => {
  const stored = await getStoredCredential(nodeId);
  if (stored?.trim()) return { configured: true, source: 'store' };
  if (process.env[dataPlaneEnvNameOf(nodeId)]?.trim()) return { configured: true, source: 'env' };
  return { configured: false, source: null };
};
