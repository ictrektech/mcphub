// Node pairing + PKI bootstrap (§9 自动配对).
//
// Goal: a hub becomes pairable with zero manual steps. On first start the hub
// generates its own control-plane PKI (CA + server cert + self client cert)
// into the persistent volume, so the mTLS listeners can start without any
// environment variables. An admin on THIS hub can then mint a one-time
// pairing code; a remote hub presents the code plus a public key and receives
// a client certificate signed by our CA together with a dedicated bearer
// token. Everything after the pairing (mTLS handshake, action checks) keeps
// the §A-2 model untouched.

import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import forge from 'node-forge';
import { logger } from '../utils/logger.js';
import {
  NODE_OPS_CN_PATTERN,
  certsDir,
  type NodeOpsTlsMaterials,
} from './nodeOpsTls.js';
import { mintPeerToken, registerPairedPeer } from './nodePeerRegistry.js';

const CERT_TTL_DAYS = 365;
const KEY_SIZE_BITS = 2048;
const CODE_TTL_MS = 5 * 60 * 1000;

export { certsDir };

const nodeDisplayName = (): string =>
  (process.env.MCPHUB_NODE_NAME || os.hostname()).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64)
  || 'mcphub-node';

const pkiFilePaths = (): {
  ca: string; caKey: string; serverCert: string; serverKey: string; clientCert: string; clientKey: string;
} => {
  const dir = certsDir();
  return {
    ca: join(dir, 'ca.pem'),
    caKey: join(dir, 'ca.key'),
    serverCert: join(dir, 'server.crt'),
    serverKey: join(dir, 'server.key'),
    clientCert: join(dir, 'client.crt'),
    clientKey: join(dir, 'client.key'),
  };
};

const toPem = (cert: forge.pki.Certificate): string => forge.pki.certificateToPem(cert);

const SANsFor = (commonName: string): string[] => {
  const names = new Set<string>(['localhost', commonName]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) names.add(entry.address);
    }
  }
  return [...names];
};

/** RSA keygen via Node's native crypto: millisecond-scale C++ instead of the
 * multi-second pure-JS forge keygen, which would block the event loop and
 * stall the whole server during first-boot bootstrap. */
const generateRsaKeys = (): { publicKeyPem: string; privateKeyPem: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: KEY_SIZE_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
};

const keyPairFromPems = (publicKeyPem: string, privateKeyPem: string): forge.pki.KeyPair => ({
  publicKey: forge.pki.publicKeyFromPem(publicKeyPem),
  privateKey: forge.pki.privateKeyFromPem(privateKeyPem),
});

const generateCertificate = (input: {
  commonName: string;
  publicKey: forge.pki.PublicKey;
  issuerCertificate?: forge.pki.Certificate;
  issuerKeys?: forge.pki.KeyPair;
  sans?: string[];
  clientAuth?: boolean;
}): forge.pki.Certificate => {
  const cert = forge.pki.createCertificate();
  cert.publicKey = input.publicKey;
  cert.serialNumber = randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CERT_TTL_DAYS * 24 * 3600 * 1000);
  const subject = [{ name: 'commonName', value: input.commonName }];
  cert.setSubject(subject);
  const issuerCert = input.issuerCertificate;
  if (issuerCert && input.issuerKeys) {
    cert.setIssuer(issuerCert.subject.attributes);
  } else {
    cert.setIssuer(subject);
  }
  const extensions: Parameters<forge.pki.Certificate['setExtensions']>[0] = [
    { name: 'basicConstraints', cA: !issuerCert, critical: true },
  ];
  if (issuerCert) {
    extensions.push({
      name: 'extKeyUsage',
      clientAuth: input.clientAuth !== false,
      serverAuth: !input.clientAuth,
    });
  } else {
    extensions.push(
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    );
  }
  if (input.sans?.length) {
    extensions.push({
      name: 'subjectAltName',
      altNames: input.sans.map((value) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(value)
          ? { type: 7, value } // IP
          : { type: 2, value }), // DNS
    });
  }
  cert.setExtensions(extensions);
  if (!issuerCert || !input.issuerKeys) {
    throw new Error('generateCertificate requires an issuer certificate and key');
  }
  cert.sign(input.issuerKeys.privateKey, forge.md.sha256.create());
  return cert;
};

export interface BootstrapResult extends NodeOpsTlsMaterials {
  generated: boolean;
  clientCertPem: string;
  clientKeyPem: string;
}

const readExistingPki = async (): Promise<BootstrapResult | null> => {
  const paths = pkiFilePaths();
  try {
    const [ca, cert, key, clientCert, clientKey] = await Promise.all([
      readFile(paths.ca), readFile(paths.serverCert), readFile(paths.serverKey),
      readFile(paths.clientCert), readFile(paths.clientKey),
    ]);
    return { ca, cert, key, clientCertPem: clientCert.toString(), clientKeyPem: clientKey.toString(), generated: false };
  } catch {
    return null;
  }
};

/**
 * Ensures the control-plane PKI exists, generating it on first start.
 * Environment-provided paths still win (resolveNodeOpsTlsMaterials keeps its
 * precedence); this bootstrap only removes the manual provisioning step.
 */
export const ensureNodePki = async (): Promise<BootstrapResult> => {
  const existing = await readExistingPki();
  if (existing) return existing;

  const dir = certsDir();
  const paths = pkiFilePaths();
  const name = nodeDisplayName();
  logger.info('[node-ops] no control-plane PKI found; generating one', { dir, name });

  // CA (self-signed, keyCertSign). Native keygen: fast and non-blocking.
  const caKeyPems = generateRsaKeys();
  const caKeys = keyPairFromPems(caKeyPems.publicKeyPem, caKeyPems.privateKeyPem);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = randomBytes(8).toString('hex');
  caCert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  caCert.validity.notAfter = new Date(Date.now() + CERT_TTL_DAYS * 24 * 3600 * 1000);
  const caSubject = [{ name: 'commonName', value: 'node-ops-ca' }];
  caCert.setSubject(caSubject);
  caCert.setIssuer(caSubject);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // Server certificate: CN + SANs so peers can dial by IP or hostname.
  const serverKeyPems = generateRsaKeys();
  const serverKeys = keyPairFromPems(serverKeyPems.publicKeyPem, serverKeyPems.privateKeyPem);
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = randomBytes(8).toString('hex');
  serverCert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  serverCert.validity.notAfter = new Date(Date.now() + CERT_TTL_DAYS * 24 * 3600 * 1000);
  const serverSubject = [{ name: 'commonName', value: name }];
  serverCert.setSubject(serverSubject);
  serverCert.setIssuer(caCert.subject.attributes);
  serverCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: SANsFor(name).map((value) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(value) ? { type: 7, value } : { type: 2, value }),
    },
  ]);
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // Self client certificate: lets this hub pair OUT to peers by presenting a
  // credential signed with our own CA when the peer trusts us reciprocally.
  const clientKeyPems = generateRsaKeys();
  const clientKeys = keyPairFromPems(clientKeyPems.publicKeyPem, clientKeyPems.privateKeyPem);
  const clientCert = forge.pki.createCertificate();
  clientCert.publicKey = clientKeys.publicKey;
  clientCert.serialNumber = randomBytes(8).toString('hex');
  clientCert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  clientCert.validity.notAfter = new Date(Date.now() + CERT_TTL_DAYS * 24 * 3600 * 1000);
  clientCert.setSubject(serverSubject);
  clientCert.setIssuer(caCert.subject.attributes);
  clientCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, critical: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  clientCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const serverKeyPem = forge.pki.privateKeyToPem(serverKeys.privateKey);
  const clientKeyPem = forge.pki.privateKeyToPem(clientKeys.privateKey);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(paths.ca, toPem(caCert), { mode: 0o644 });
  await writeFile(paths.caKey, forge.pki.privateKeyToPem(caKeys.privateKey), { mode: 0o600 });
  await writeFile(paths.serverCert, toPem(serverCert), { mode: 0o644 });
  await writeFile(paths.serverKey, serverKeyPem, { mode: 0o600 });
  await writeFile(paths.clientCert, toPem(clientCert), { mode: 0o644 });
  await writeFile(paths.clientKey, clientKeyPem, { mode: 0o600 });
  logger.log(`[node-ops] control-plane PKI generated in ${dir} (CN=${name})`);

  return {
    ca: Buffer.from(toPem(caCert)),
    cert: Buffer.from(toPem(serverCert)),
    key: Buffer.from(serverKeyPem),
    clientCertPem: toPem(clientCert),
    clientKeyPem,
    generated: true,
  };
};

// --- pairing codes -----------------------------------------------------------

interface ActiveCode { code: string; expiresAt: number }
let activeCode: ActiveCode | null = null;

export const createPairingCode = (): { code: string; expiresAt: string } => {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  activeCode = { code, expiresAt: Date.now() + CODE_TTL_MS };
  logger.info('[node-ops] pairing code minted (valid 5 minutes)');
  return { code, expiresAt: new Date(activeCode.expiresAt).toISOString() };
};

export const consumePairingCode = (code: string): boolean => {
  if (!activeCode) return false;
  if (Date.now() > activeCode.expiresAt) { activeCode = null; return false; }
  if (activeCode.code !== code) return false;
  activeCode = null; // one-time
  return true;
};

// --- pair issuance -----------------------------------------------------------

export interface PairIssuance { ca: string; cert: string; token: string }

/** Validates the one-time code and issues a client certificate + bearer token
 * for the remote peer. The peer's public key arrives in the request; we never
 * see its private key. */
export const pairPeer = async (input: { code: string; cn: string; publicKeyPem: string }): Promise<PairIssuance> => {
  if (!NODE_OPS_CN_PATTERN.test(input.cn)) {
    throw Object.assign(new Error('cn must match ^[A-Za-z0-9._:-]{1,64}$'), { status: 400 });
  }
  let publicKey: forge.pki.PublicKey;
  try {
    publicKey = forge.pki.publicKeyFromPem(input.publicKeyPem);
  } catch {
    throw Object.assign(new Error('publicKeyPem is not a valid PEM public key'), { status: 400 });
  }
  if (!consumePairingCode(input.code)) {
    throw Object.assign(new Error('pairing code is invalid or expired'), { status: 403, code: 'pairing-code-invalid' });
  }

  const caCert = forge.pki.certificateFromPem((await readFile(pkiFilePaths().ca)).toString());
  let caPrivateKey: forge.pki.PrivateKey;
  try {
    caPrivateKey = forge.pki.privateKeyFromPem(await readFile(join(certsDir(), 'ca.key'), 'utf8'));
  } catch {
    throw Object.assign(
      new Error('CA private key not found next to ca.pem; pairing cannot sign client certificates'),
      { status: 503 },
    );
  }
  const cert = generateCertificate({
    commonName: input.cn,
    publicKey,
    issuerCertificate: caCert,
    issuerKeys: { publicKey: caCert.publicKey, privateKey: caPrivateKey },
    clientAuth: true,
  });
  const token = mintPeerToken();
  await registerPairedPeer({ name: input.cn, token });
  logger.info('[node-ops] peer paired', { peer: input.cn });
  return { ca: toPem(caCert), cert: toPem(cert), token };
};
