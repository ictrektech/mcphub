// §9 自动配对 self-test: PKI bootstrap → pairing code → certificate issue →
// peer registry → mTLS materials resolve from the bootstrap directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import {
  beforeEach, describe, expect, it,
} from '@jest/globals';

const pemCert = (pem: string): forge.pki.Certificate => forge.pki.certificateFromPem(pem);

describe('node pairing bootstrap', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pairing-'));
    process.env.MCP_NODE_OPS_CERT_DIR = dir;
    process.env.MCP_NODE_SECRETS_DIR = dir;
    // Reset the in-memory pairing code between tests.
    jest.resetModules();
  });

  it('bootstraps a complete PKI on first start and reuses it afterwards', async () => {
    const pairing = await import('../../src/services/nodePairingService.js');
    const first = await pairing.ensureNodePki();
    expect(first.generated).toBe(true);
    for (const file of ['ca.pem', 'ca.key', 'server.crt', 'server.key', 'client.crt', 'client.key']) {
      expect(fs.existsSync(path.join(dir, file))).toBe(true);
    }
    // Server cert CN + SAN and CA linkage.
    const server = pemCert(first.cert.toString('utf8'));
    expect(server.subject.getField('CN')).toBe(server.subject.getField('CN')); // shape check
    expect(server.issuer.getField('CN').value).toBe('node-ops-ca');
    expect(server.getExtension('subjectAltName')).toBeDefined();

    const second = await pairing.ensureNodePki();
    expect(second.generated).toBe(false);
    expect(second.cert.equals(first.cert)).toBe(true);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it('pairs a peer: one-time code → signed client cert + token → registry', async () => {
    const pairing = await import('../../src/services/nodePairingService.js');
    await pairing.ensureNodePki();

    // No code minted yet → pairing must fail.
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const publicKeyPem = forge.pki.publicKeyToPem(keys.publicKey);
    await expect(pairing.pairPeer({ code: '000000', cn: 'hub-a', publicKeyPem }))
      .rejects.toMatchObject({ code: 'pairing-code-invalid' });

    const { code } = pairing.createPairingCode();
    expect(code).toMatch(/^\d{6}$/);

    const issuance = await pairing.pairPeer({ code, cn: 'hub-a', publicKeyPem });
    const client = pemCert(issuance.cert);
    expect(client.issuer.getField('CN').value).toBe('node-ops-ca');
    expect(client.subject.getField('CN').value).toBe('hub-a');
    expect(client.getExtension('extKeyUsage')).toBeDefined();
    expect(issuance.token).toMatch(/^[0-9a-f]{96}$/);

    // The code is one-time: a second redemption must fail.
    await expect(pairing.pairPeer({ code, cn: 'hub-a', publicKeyPem }))
      .rejects.toMatchObject({ code: 'pairing-code-invalid' });

    // The paired peer is registered (hash only) and visible synchronously.
    const { pairedPeersSnapshot, tokenHashOf } = await import('../../src/services/nodePeerRegistry.js');
    const snapshot = pairedPeersSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].name).toBe('hub-a');
    expect(snapshot[0].tokenHash).toBe(tokenHashOf(issuance.token));
    expect(snapshot[0].actions).toContain('read');
    expect(snapshot[0].scope).toBe('admin');
  });

  it('mTLS materials resolve from the bootstrap directory without env config', async () => {
    delete process.env.MCP_NODE_OPS_TLS_CERT;
    delete process.env.MCP_NODE_OPS_TLS_KEY;
    delete process.env.MCP_NODE_OPS_TLS_CA;
    const tls = await import('../../src/services/nodeOpsTls.js');
    expect(tls.resolveNodeOpsTlsMaterials()).toBeNull(); // nothing bootstrapped yet

    const pairing = await import('../../src/services/nodePairingService.js');
    await pairing.ensureNodePki();
    const materials = tls.resolveNodeOpsTlsMaterials();
    expect(materials).not.toBeNull();
    expect(materials!.ca.toString('utf8')).toContain('BEGIN CERTIFICATE');
    expect(materials!.cert.toString('utf8')).toContain('BEGIN CERTIFICATE');
  });
});
