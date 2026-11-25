# Test fixtures — self-signed certificates

These PEM files were generated locally for the `tests/node-ops/nodeOps.tls.test.ts`
suite (CA: `CN=node-ops-test-ca`, server: `CN=node-server`, clients:
`CN=node-a|node-b|ghost|read-only`).

**Testing only. Do not copy these files into any deployment**: the keys are
public in this repository, so they provide zero security. Real deployments
must generate their own PKI with `scripts/gen-node-certs.sh` (see the main
README, "mTLS control plane").

Regenerate with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/CN=node-ops-test-ca"
# server: SAN IP:127.0.0.1,DNS:localhost + extendedKeyUsage=serverAuth
# clients: CN=<peer name> + extendedKeyUsage=clientAuth, signed by ca.pem
```
