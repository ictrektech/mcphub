// Runtime registry of peers admitted through the pairing flow (§9 自动配对).
//
// Peers registered here are the dynamic counterpart of the static
// MCP_NODE_TOKENS environment table: pairing mints a dedicated bearer token
// for the peer and records only its sha256 here, so the control plane can
// authenticate a freshly paired node without a restart. The file lives on the
// persistent volume (0600, atomic replace) next to node-secrets.json.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NODE_OPS_CN_PATTERN } from './nodeOpsTls.js';

export interface PairedPeerRecord {
  name: string;
  tokenHash: string; // sha256 hex of the peer's bearer token
  actions: string[];
  scope: 'admin';
  createdAt: string;
}

const registryPath = (): string =>
  join(process.env.MCP_NODE_SECRETS_DIR || '/app/data', 'node-peers.json');

/** Actions granted to a paired peer. Pairing is an admin act; the peer gets
 * the full control-plane surface, mirroring an admin-scope env token. */
export const PAIRED_PEER_ACTIONS = [
  'read',
  'logs',
  'definition',
  'control',
  'import',
  'import-stdio',
] as const;

const isValidRecord = (record: unknown): record is PairedPeerRecord => {
  const row = record as Partial<PairedPeerRecord> | null;
  return (
    !!row &&
    typeof row.name === 'string' &&
    NODE_OPS_CN_PATTERN.test(row.name) &&
    typeof row.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(row.tokenHash) &&
    Array.isArray(row.actions) &&
    row.actions.every((action) => typeof action === 'string') &&
    row.scope === 'admin'
  );
};

const readRegistry = async (): Promise<PairedPeerRecord[]> => {
  let raw: string;
  try {
    raw = await readFile(registryPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidRecord);
};

const writeRegistry = async (records: PairedPeerRecord[]): Promise<void> => {
  const target = registryPath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const tokenHashOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Mints the peer's dedicated bearer token (kept only in the pairing response). */
export const mintPeerToken = (): string => randomBytes(48).toString('hex');

export const registerPairedPeer = async (input: {
  name: string;
  token: string;
}): Promise<PairedPeerRecord> => {
  if (!NODE_OPS_CN_PATTERN.test(input.name)) {
    throw new Error('Paired peer name must match ^[A-Za-z0-9._:-]{1,64}$');
  }
  const records = await readRegistry().then((rows) =>
    rows.filter((row) => row.name !== input.name),
  );
  const record: PairedPeerRecord = {
    name: input.name,
    tokenHash: tokenHashOf(input.token),
    actions: [...PAIRED_PEER_ACTIONS],
    scope: 'admin',
    createdAt: new Date().toISOString(),
  };
  records.push(record);
  await writeRegistry(records);
  return record;
};

export const removePairedPeer = async (name: string): Promise<void> => {
  const records = await readRegistry();
  await writeRegistry(records.filter((row) => row.name !== name));
};

export const listPairedPeers = (): Promise<PairedPeerRecord[]> => readRegistry();

/** Synchronous snapshot used by the auth middleware; cached on file mtime so a
 * pairing does not require a restart to take effect. */
let cache: { mtimeMs: number; records: PairedPeerRecord[] } | null = null;

export const pairedPeersSnapshot = (): PairedPeerRecord[] => {
  try {
    const { mtimeMs } = statSync(registryPath());
    if (!cache || cache.mtimeMs !== mtimeMs) {
      const parsed: unknown = JSON.parse(readFileSync(registryPath(), 'utf8'));
      const records: PairedPeerRecord[] = Array.isArray(parsed)
        ? parsed.filter(isValidRecord)
        : [];
      cache = { mtimeMs, records };
    }
    return cache.records;
  } catch {
    return [];
  }
};
