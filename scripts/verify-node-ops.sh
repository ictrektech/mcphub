#!/bin/sh
# Verifies the /node-ops contract against a running MCPHub. Requires curl and node.
# Env: BASE_URL, NODE_OPS_ADMIN_TOKEN, NODE_OPS_NODE_TOKEN, NODE_OPS_READ_TOKEN, NODE_OPS_BAD_TOKEN
set -u

# BASE_URL is the deployment prefix INCLUDING BASE_PATH; /node-ops is appended below.
BASE_URL=${BASE_URL:-http://127.0.0.1:3000/app/com.ictrek.mcphub}
BASE_URL=${BASE_URL%/}
ADMIN_TOKEN=${NODE_OPS_ADMIN_TOKEN:-}
NODE_TOKEN=${NODE_OPS_NODE_TOKEN:-}
READ_TOKEN=${NODE_OPS_READ_TOKEN:-}
BAD_TOKEN=${NODE_OPS_BAD_TOKEN:-invalid-token-with-no-matching-peer-0001}

if [ -z "$ADMIN_TOKEN" ] || [ -z "$NODE_TOKEN" ] || [ -z "$READ_TOKEN" ]; then
  echo 'FAIL setup: set NODE_OPS_ADMIN_TOKEN, NODE_OPS_NODE_TOKEN and NODE_OPS_READ_TOKEN' >&2
  echo '  admin: all actions, scope=admin' >&2
  echo '  node:  read/logs/definition/control/import, scope=node (no import-stdio)' >&2
  echo '  read:  read only, scope=node' >&2
  exit 2
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
BODY="$TMP_DIR/body.json"
STATUS=000

call() {
  _method=$1
  _path=$2
  _token=${3-}
  _payload=${4-}
  set -- -sS --max-time 10 -o "$BODY" -w '%{http_code}' -X "$_method"
  [ -n "$_token" ] && set -- "$@" -H "Authorization: Bearer $_token"
  if [ -n "$_payload" ]; then
    set -- "$@" -H 'Content-Type: application/json' --data "$_payload"
  fi
  set -- "$@" "$BASE_URL/node-ops$_path"
  STATUS=$(curl "$@" 2>"$TMP_DIR/curl.err") || STATUS=000
}

json_field() {
  node -e '
    const fs = require("fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let value = doc;
    for (const key of process.argv.slice(2)) value = value?.[key];
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  ' "$BODY" "$@" 2>/dev/null
}

json_has_name() {
  node -e '
    const fs = require("fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const names = (doc.data?.servers ?? []).map((server) => server.name);
    process.stdout.write(names.includes(process.argv[2]) ? "yes" : "no");
  ' "$BODY" "$1" 2>/dev/null
}

json_server_field() {
  node -e '
    const fs = require("fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const server = (doc.data?.servers ?? []).find((item) => item.name === process.argv[2]);
    if (!server || server[process.argv[3]] === undefined) process.exit(1);
    process.stdout.write(String(server[process.argv[3]]));
  ' "$BODY" "$1" "$2" 2>/dev/null
}

PASS_COUNT=0
FAIL_COUNT=0

report() {
  if [ "$2" -eq 0 ]; then
    printf 'PASS %s\n' "$1"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf 'FAIL %s (%s)\n' "$1" "$3"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

setup_failure() {
  echo "FAIL setup: $1 (HTTP $STATUS: $(cat "$BODY"))" >&2
  if [ "$STATUS" = 404 ]; then
    echo '  Hint: BASE_URL must include BASE_PATH, e.g. http://127.0.0.1:3000/app/com.ictrek.mcphub' >&2
  fi
  exit 2
}

PREFIX="verify-$(date +%s)-$$"
PUBLIC_NAME="${PREFIX}-public"
PRIVATE_NAME="${PREFIX}-private"
ROUNDTRIP_NAME="${PREFIX}-roundtrip"
printf 'Fixtures (no delete endpoint exists, clean them up manually): %s, %s, %s\n' \
  "$PUBLIC_NAME" "$PRIVATE_NAME" "$ROUNDTRIP_NAME"

call POST /servers "$ADMIN_TOKEN" \
  "{\"name\":\"$PUBLIC_NAME\",\"definition\":{\"type\":\"streamable-http\",\"url\":\"http://127.0.0.1:9/mcp\",\"description\":\"node-ops verification\"},\"visibility\":\"public\"}"
if [ "$STATUS" != 200 ]; then
  setup_failure "cannot create $PUBLIC_NAME"
fi

call POST /servers "$ADMIN_TOKEN" \
  "{\"name\":\"$PRIVATE_NAME\",\"definition\":{\"type\":\"streamable-http\",\"url\":\"http://127.0.0.1:9/private\"},\"owner\":\"fixture-owner\",\"visibility\":\"private\"}"
if [ "$STATUS" != 200 ]; then
  setup_failure "cannot create $PRIVATE_NAME"
fi

call GET /servers ''
CODE=$(json_field code)
[ "$STATUS" = 401 ] && [ "$CODE" = node-token-missing ]
report 'missing token -> 401 node-token-missing' $? "HTTP $STATUS code=$CODE"

call GET /servers "$BAD_TOKEN"
CODE=$(json_field code)
[ "$STATUS" = 401 ] && [ "$CODE" = node-token-invalid ]
report 'wrong token -> 401 node-token-invalid' $? "HTTP $STATUS code=$CODE"

call POST "/servers/$PUBLIC_NAME/enable" "$READ_TOKEN"
CODE=$(json_field code)
[ "$STATUS" = 403 ] && [ "$CODE" = node-action-forbidden ]
report 'action gap -> 403 node-action-forbidden' $? "HTTP $STATUS code=$CODE"

call GET /servers "$NODE_TOKEN"
[ "$(json_has_name "$PRIVATE_NAME")" = no ]
report 'scope:node cannot see another owner private server' $? "HTTP $STATUS"

call GET /servers "$ADMIN_TOKEN"
[ "$(json_has_name "$PRIVATE_NAME")" = yes ]
report 'scope:admin sees another owner private server' $? "HTTP $STATUS"

call GET "/servers/$PRIVATE_NAME/definition" "$NODE_TOKEN"
CODE=$(json_field code)
[ "$STATUS" = 403 ] && [ "$CODE" = node-scope-forbidden ]
report 'non-owner export -> 403 node-scope-forbidden' $? "HTTP $STATUS code=$CODE"

call POST /servers "$NODE_TOKEN" \
  "{\"name\":\"${PREFIX}-stdio\",\"definition\":{\"type\":\"stdio\",\"command\":\"true\"}}"
CODE=$(json_field code)
[ "$STATUS" = 403 ] && [ "$CODE" = stdio-import-forbidden ]
report 'stdio import without import-stdio -> 403' $? "HTTP $STATUS code=$CODE"

call POST /servers "$ADMIN_TOKEN" \
  "{\"name\":\"${PREFIX}-oauth\",\"definition\":{\"type\":\"streamable-http\",\"url\":\"http://127.0.0.1:9/mcp\",\"oauth\":{\"accessToken\":\"leak\"}}}"
CODE=$(json_field code)
[ "$STATUS" = 400 ] && [ "$CODE" = invalid-definition ]
report 'definition with oauth -> 400 invalid-definition' $? "HTTP $STATUS code=$CODE"

call POST /servers "$ADMIN_TOKEN" \
  "{\"name\":\"$PUBLIC_NAME\",\"definition\":{\"type\":\"streamable-http\",\"url\":\"http://127.0.0.1:9/mcp\"}}"
CODE=$(json_field code)
[ "$STATUS" = 409 ] && [ "$CODE" = server-duplicate ]
report 'duplicate import -> 409 server-duplicate' $? "HTTP $STATUS code=$CODE"

call POST "/servers/$PUBLIC_NAME/disable" "$ADMIN_TOKEN"
ENABLED=$(json_field data enabled)
SERVER_STATUS=$(json_field data status)
[ "$STATUS" = 200 ] && [ "$ENABLED" = false ] && [ "$SERVER_STATUS" = disconnected ]
report 'disable -> enabled:false / disconnected' $? "HTTP $STATUS enabled=$ENABLED status=$SERVER_STATUS"

call GET /servers "$ADMIN_TOKEN"
ENABLED=$(json_server_field "$PUBLIC_NAME" enabled)
SERVER_STATUS=$(json_server_field "$PUBLIC_NAME" status)
[ "$ENABLED" = false ] && [ "$SERVER_STATUS" = disconnected ]
report 'disabled server stays disabled in list' $? "enabled=$ENABLED status=$SERVER_STATUS"

call GET "/servers/$PUBLIC_NAME/logs?tail=20" "$ADMIN_TOKEN"
MATCHED=$(json_field data matched)
TEXT=$(json_field data text)
[ "$STATUS" = 200 ] && [ "$MATCHED" = 0 ] && [ -z "$TEXT" ]
report 'logs with no match -> 200 matched:0' $? "HTTP $STATUS matched=$MATCHED text=$TEXT"

call GET "/servers/$PUBLIC_NAME/definition" "$ADMIN_TOKEN"
cp "$BODY" "$TMP_DIR/definition-a.json"
node -e '
  const fs = require("fs");
  const definition = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).data?.definition;
  if (!definition) process.exit(1);
  process.stdout.write(JSON.stringify({ name: process.argv[2], definition, enable: false }));
' "$TMP_DIR/definition-a.json" "$ROUNDTRIP_NAME" >"$TMP_DIR/import-body.json" || {
  report 'definition -> import roundtrip' 1 'cannot build import body'
}
IMPORT_BODY=$(cat "$TMP_DIR/import-body.json")
call POST /servers "$ADMIN_TOKEN" "$IMPORT_BODY"
[ "$STATUS" = 200 ] && [ "$(json_field data created)" = true ]
ROUNDTRIP_OK=$?
call GET "/servers/$ROUNDTRIP_NAME/definition" "$ADMIN_TOKEN"
cp "$BODY" "$TMP_DIR/definition-b.json"
[ "$ROUNDTRIP_OK" = 0 ] && node -e '
  const fs = require("fs");
  const read = (path) => JSON.parse(fs.readFileSync(path, "utf8")).data?.definition;
  const keys = ["type", "url", "command", "args", "env", "headers", "passthroughHeaders",
    "description", "protocolNegotiation", "enableKeepAlive", "keepAliveInterval",
    "startOnDemand", "idleTimeoutMs", "options", "openapi", "tools", "prompts", "resources"];
  const pick = (definition) => JSON.stringify(Object.entries(
    Object.fromEntries(keys.filter((key) => definition?.[key] !== undefined).map((key) => [key, definition[key]]))
  ).sort(([a], [b]) => a.localeCompare(b)));
  process.exit(pick(read(process.argv[1])) === pick(read(process.argv[2])) ? 0 : 1);
' "$TMP_DIR/definition-a.json" "$TMP_DIR/definition-b.json"
report 'definition -> import roundtrip whitelist fields' $? "HTTP $STATUS"

call GET /health "$ADMIN_TOKEN"
CAPABILITIES=$(json_field data capabilities)
[ "$STATUS" = 200 ] && [ -n "$CAPABILITIES" ]
report 'health returns token capabilities' $? "HTTP $STATUS capabilities=$CAPABILITIES"

call GET /nope "$ADMIN_TOKEN"
CODE=$(json_field code)
[ "$STATUS" = 404 ] && { [ "$CODE" = not-found ] || [ "$CODE" = server-not-found ]; }
report 'unknown node-ops path -> 404 JSON' $? "HTTP $STATUS code=$CODE"

printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
printf 'Cleanup: /node-ops has no DELETE endpoint. Delete these keys from mcpServers in mcp_settings.json (data/mcp_settings.dev.json for local dev):\n'
printf '  %s\n  %s\n  %s\n' "$PUBLIC_NAME" "$PRIVATE_NAME" "$ROUNDTRIP_NAME"
[ "$FAIL_COUNT" -eq 0 ]
