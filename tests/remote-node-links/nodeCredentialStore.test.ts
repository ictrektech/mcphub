import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  credentialStatus,
  dataPlaneEnvNameOf,
  deleteCredential,
  resolveDataPlaneToken,
  setCredential,
} from '../../src/services/nodeCredentialStore.js';

const originalDir = process.env.MCP_NODE_SECRETS_DIR;
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcphub-node-secrets-'));
  file = join(dir, 'node-secrets.json');
  process.env.MCP_NODE_SECRETS_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.MCP_NODE_SECRETS_DIR;
  else process.env.MCP_NODE_SECRETS_DIR = originalDir;
});

describe('node credential store', () => {
  it('writes a 0600 file keyed by node id', async () => {
    await setCredential('node-b', '  mcphub_from_store  ');

    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed).toEqual({ 'node-b': 'mcphub_from_store' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('reads the token only from the store', async () => {
    await setCredential('node-b', 'mcphub_from_store');

    expect(await resolveDataPlaneToken('node-b')).toBe('mcphub_from_store');
    expect(await credentialStatus('node-b')).toEqual({ configured: true, source: 'store' });
  });

  it('falls back to the deployment environment variable', async () => {
    process.env[dataPlaneEnvNameOf('node-b')] = 'mcphub_from_env';
    try {
      expect(await resolveDataPlaneToken('node-b')).toBe('mcphub_from_env');
      expect(await credentialStatus('node-b')).toEqual({ configured: true, source: 'env' });
    } finally {
      delete process.env[dataPlaneEnvNameOf('node-b')];
    }
  });

  it('prefers the stored credential over the environment variable', async () => {
    process.env[dataPlaneEnvNameOf('node-c')] = 'mcphub_from_env';
    try {
      await setCredential('node-c', 'mcphub_from_store');
      expect(await resolveDataPlaneToken('node-c')).toBe('mcphub_from_store');
      expect(await credentialStatus('node-c')).toEqual({ configured: true, source: 'store' });
    } finally {
      delete process.env[dataPlaneEnvNameOf('node-c')];
    }
  });

  it('reports unconfigured and refuses invalid node ids or blank tokens', async () => {
    expect(await credentialStatus('node-b')).toEqual({ configured: false, source: null });
    await expect(setCredential('node-b', '  ')).rejects.toThrow();
    await expect(setCredential('bad id', 'token')).rejects.toThrow();
  });

  it('deletes only the requested node credential', async () => {
    await setCredential('node-b', 'mcphub_b');
    await setCredential('node-c', 'mcphub_c');
    await deleteCredential('node-b');

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'node-c': 'mcphub_c' });
  });
});
