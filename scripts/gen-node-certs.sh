#!/usr/bin/env bash
# gen-node-certs.sh — one command to mint a node-ops control-plane PKI (§A-2).
#
# Produces in --out (default ./node-certs):
#   ca.pem                    CA used by every node (distribute once)
#   server.crt / server.key   per-node TLS server cert (CN=<node>, SAN IP/DNS)
#   client.crt / client.key   per-node mTLS client cert (CN=<node>)
#
# Usage:
#   scripts/gen-node-certs.sh --node node-a [--address 10.0.0.21] \
#     [--hostname node-a.local] [--out ./node-certs] [--days 365]
#
# The script prints the environment variables and container mount paths that
# the generated files map to. Rotation = re-run and replace the files, then
# restart MCPHub; revocation = drop the peer from MCP_NODE_TOKENS (cert-only
# trust never exists: the CN must still match a registered peer).

set -euo pipefail

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

NODE_NAME=""
ADDRESS=""
HOSTNAME_DNS=""
OUT_DIR="./node-certs"
DAYS="365"
CA_KEY_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) NODE_NAME="${2:?}"; shift 2 ;;
    --address) ADDRESS="${2:?}"; shift 2 ;;
    --hostname) HOSTNAME_DNS="${2:?}"; shift 2 ;;
    --out) OUT_DIR="${2:?}"; shift 2 ;;
    --days) DAYS="${2:?}"; shift 2 ;;
    --ca-key) CA_KEY_ARG="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$NODE_NAME" ]] || usage
[[ "$NODE_NAME" =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || {
  echo "error: --node must match ^[A-Za-z0-9._:-]{1,64}\$" >&2; exit 1; }

command -v openssl >/dev/null || { echo "error: openssl is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- CA (shared by all nodes; skip if one already exists in --out) ----------
# The CA key is kept next to the CA cert (600) so further nodes can be signed;
# store it wherever the PKI is administered, it never belongs on MCPHub nodes.
if [[ ! -f "$OUT_DIR/ca.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$OUT_DIR/ca.key" -out "$OUT_DIR/ca.pem" \
    -days "$DAYS" -subj "/CN=node-ops-ca" >/dev/null 2>&1
  chmod 600 "$OUT_DIR/ca.key"
  echo "generated CA: $OUT_DIR/ca.pem (key: $OUT_DIR/ca.key — keep it off MCPHub nodes)"
  CA_KEY="$OUT_DIR/ca.key"
else
  echo "reusing existing CA: $OUT_DIR/ca.pem"
  # Signing an extra node needs the existing CA key: --ca-key for scripts,
  # interactive prompt as a fallback for humans.
  if [[ -n "$CA_KEY_ARG" ]]; then
    [[ -f "$CA_KEY_ARG" ]] || { echo "error: --ca-key file not found" >&2; exit 1; }
    CA_KEY="$CA_KEY_ARG"
  else
    read -r -p "path to existing CA key (for signing): " CA_KEY_ARG
    [[ -f "$CA_KEY_ARG" ]] || { echo "error: CA key not found" >&2; exit 1; }
    CA_KEY="$CA_KEY_ARG"
  fi
fi

# --- server certificate (SAN carries the addresses peers will dial) ---------
SAN="DNS:localhost,DNS:$NODE_NAME"
[[ -n "$ADDRESS" ]] && SAN="IP:$ADDRESS,$SAN"
[[ -n "$HOSTNAME_DNS" ]] && SAN="DNS:$HOSTNAME_DNS,$SAN"

openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/server.key" -out "$WORK/server.csr" \
  -subj "/CN=$NODE_NAME" >/dev/null 2>&1
openssl x509 -req -in "$WORK/server.csr" -CA "$OUT_DIR/ca.pem" -CAkey "$CA_KEY" \
  -CAcreateserial -out "$OUT_DIR/server.crt" -days "$DAYS" \
  -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN") \
  >/dev/null 2>&1

# --- client certificate (CN = node name = MCP_NODE_TOKENS entry name) ------
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/client.key" -out "$WORK/client.csr" \
  -subj "/CN=$NODE_NAME" >/dev/null 2>&1
openssl x509 -req -in "$WORK/client.csr" -CA "$OUT_DIR/ca.pem" -CAkey "$CA_KEY" \
  -CAcreateserial -out "$OUT_DIR/client.crt" -days "$DAYS" \
  -extfile <(printf "extendedKeyUsage=clientAuth\n") \
  >/dev/null 2>&1

chmod 600 "$OUT_DIR/server.key" "$OUT_DIR/client.key"
rm -f "$OUT_DIR/ca.srl"

echo
echo "generated for node '$NODE_NAME' in $OUT_DIR:"
ls -1 "$OUT_DIR" | sed 's/^/  /'
echo
echo "environment variables (MCPHub on this node):"
cat <<ENV

  MCP_NODE_OPS_TLS_CERT=$OUT_DIR/server.crt
  MCP_NODE_OPS_TLS_KEY=$OUT_DIR/server.key
  MCP_NODE_OPS_TLS_CA=$OUT_DIR/ca.pem
  MCP_NODE_OPS_PORT=31890            # control-plane port, publish/firewall as needed
  MCPHUB_NODE_NAME=$NODE_NAME        # health self-identification
  MCP_NODE_TOKENS=[...]              # must contain {"name":"$NODE_NAME", ...}

ENV
echo "container mount (persistent volume, §A-2):"
echo "  /app/data/certs/{ca.pem,server.crt,server.key,client.crt,client.key}"
echo
echo "verify from a peer node:"
echo "  curl --cert client.crt --key client.key --cacert ca.pem \\"
echo "    https://<this-node>:31890/<BASE_PATH>/node-ops/health"
