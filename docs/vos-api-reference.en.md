# MCPHub API reference

## Addresses and quick start

Use **API Integration Guide → Complete API reference** for this offline, searchable document. The existing guide still provides the VOS OAuth/PKCE example and SDK call. The sections below cover authentication, Keys, server sharing/configuration, tool calls, errors and every statically registered HTTP operation. Source-specific dynamic MCP tools retain their upstream inputSchema/outputSchema: use tools/list rather than guessing arguments.

| Caller | Base URL |
| --- | --- |
| Same-origin VOS app | `/app/com.ictrek.mcphub` |
| Container on vos_default | `http://mcphub:3000/app/com.ictrek.mcphub` |
| External client | `https://<VOS-host>:<VOS-port>/app/com.ictrek.mcphub` |

The app publishes no separate host port. Health probes `/health`, `/livez`, `/readyz` and `/metrics` are root-level container routes, outside the application prefix. Do not expose internal hosted webhook endpoints as a public client API. A listed route can still require an administrator, ownership, database mode or an explicitly enabled optional feature.

## VOS authentication and permissions

Management requests carry `Authorization: Bearer <VOS-user-access-token>` (or the supported x-vos-token header). Obtain it through the calling application's own VOS OAuth PKCE flow, as documented in API Integration Guide. `POST /api/auth/vos` verifies the token and returns `{success,user:{username,displayName,isAdmin,permissions}}`; it does not mint another dashboard Key. VOS mode verifies current platform identity before legacy JWT/static-key branches. An MCP user Key, Scheduler Key or upstream vendor credential does not authenticate VOS management APIs. Standalone `/api/auth/login` and x-auth-token examples in the native chapter are not the VOS login method.

`GET /api/integration/whoami` returns `{success,data:{kind,sub,username,is_admin,application_id,scope}}`. `GET /api/integration/discovery` returns protocol, transport, auth, aggregate mcp_path and servers with name, description, visibility, status and mcp_path. Discovery strips commands, environment variables, upstream URLs and secrets. Application-context identities are allowed only for these integration routes and public MCP calls; they never become administrator users or access private resources.

Server visibility values are `private`, `group` (the UI’s Shared option) and `public`. Private permits owner/admin; group sharing uses `sharedWithUsers` and `sharedWithUserGroups`; public permits authenticated users and application discovery, **not anonymous access**. Tools and groups may impose additional policy. Listing a disconnected server does not prove call readiness. A 401 is an authentication failure; 403 is an access denial; 404 may hide inaccessible resources. Do not remove permissions to make discovery work.

## Create, inspect, edit, rotate and revoke client Keys

In Settings → Bearer authentication keys, create a **user-level** Key for an external MCP client. User Keys restore the owner's live user permissions on MCP transport requests and cannot call dashboard/integration REST APIs. A non-admin always creates their own user Key; an administrator creating `kind:user` must specify an existing owner. `kind:system` is an administrator/operator Key with explicit scope; do not give it to an ordinary external user. VOS REST management still requires VOS user authentication.

| Operation | Body and response |
| --- | --- |
| GET `/api/auth/keys` | Returns `{success:true,data:[...]}`; token masked, hash removed. Admin sees all; ordinary user sees own user Keys. |
| POST `/api/auth/keys` | `{name,kind:"user",owner:"<existing-user>"}` for an administrator; ordinary user can send `{name}`. Optional enabled defaults true. Returns 201 with `data.token` **once**. Save it securely. |
| PUT `/api/auth/keys/{id}` | Patch name/enabled; administrator system Keys also accept accessType and allowed/excluded groups/servers. Returns masked metadata. Cannot replace raw token or transfer ownership/kind here. Omitted fields retain their values. |
| POST `/api/auth/keys/{id}/reset` | No body required. Generates a new secret, preserving owner, enabled state and resource scope. Returns complete `data.token` once; old secret stops matching. |
| DELETE `/api/auth/keys/{id}` | Owner/admin only; returns `{success:true}` and removes the Key. |

System accessType is `all`, `groups`, `servers`, `custom` or `exclude`; use allowedGroups/allowedServers for allow scopes and excludedGroups/excludedServers for exclude. Exclude requires at least one excluded resource. User Keys use the owner's live access (`all` within that user's permissions), not an independent administrator resource scope. Updating an unrelated system field does not re-enable a disabled Key. Losing a secret requires reset; list/update responses cannot recover it. Upstream OAuth credentials and personal credential bindings are independent.

```sh
# Management uses a VOS user token. Use a protected environment; do not log output secrets.
curl --fail-with-body "$MCPHUB_BASE/api/auth/keys" \
  -H "Authorization: Bearer $VOS_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}'
# Save returned data.token as MCPHUB_USER_KEY for the MCP client, not VOS_USER_TOKEN.
curl --fail-with-body -X PUT "$MCPHUB_BASE/api/auth/keys/$KEY_ID" \
  -H "Authorization: Bearer $VOS_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"renamed-agent","enabled":false}'
curl --fail-with-body -X POST "$MCPHUB_BASE/api/auth/keys/$KEY_ID/reset" \
  -H "Authorization: Bearer $VOS_USER_TOKEN"
```

## Server configuration, sharing and personal credentials

`POST /api/servers` accepts `{name,config}`; `PUT /api/servers/{name}` accepts `{config,newName?}`. Configuration includes type (stdio/sse/streamable-http/openapi), command+args/env or url+headers, enabled, description, visibility and sharing metadata. OpenAPI requires config.openapi.url or schema. Command/arguments are separate fields; start only trusted administrator-approved local code. Treat PUT config as the supplied configuration, not an undocumented merge patch: preserve required existing fields deliberately. Never copy exported secrets into a public report.

`POST /api/servers/{name}/toggle` takes `{enabled:boolean}`; reload reconnects asynchronously. Delete removes configuration; reload/disable is not a generic running-tool cancellation or model unload. Groups have their own IDs, server membership and tool policies. See native chapters and ServerConfig/credential types below for full fields and supported options.

Personal upstream bindings: GET `/api/credentials` returns credential-slot/binding metadata; PUT `/api/credentials/{name}` uses `{values:{"<slot>":"<secret>"}}`; DELETE removes that user's binding. Copy uses POST `/api/credentials/{name}/copy` with `{sourceServer,overwrite?}`. Administrator equivalents are under `/api/users/{username}/credentials/...` and retain template and visibility checks. Do not assume omitted/null/empty secret values all clear a slot; use DELETE to remove the binding. Personal bindings are not the client Keys above. OAuth approvals can be listed/revoked separately at `/api/oauth/approvals`; a revoked application does not remove the upstream service itself.

A local offline demo registration, performed by an authorized administrator:

```json
{"name":"vos-demo","config":{"type":"stdio","command":"node","args":["/app/examples/vos-demo.mjs"],"enabled":true,"visibility":"private"}}
```

To change sharing later, PUT the retained configuration to `/api/servers/vos-demo`, changing `config.visibility` to `public` or `group`. For group sharing add `sharedWithUsers`/`sharedWithUserGroups` using actual local usernames/group identifiers. Get share candidates from `/api/servers/{name}/share-candidates`; do not guess identities. A private-to-public change affects access for all authenticated callers.

## MCP calls, sessions and cancellation

Use `/mcp` for aggregate tools, `/mcp/{group-or-server}` for a selected scope and the actual discovered qualified tool name. Authenticate with a user VOS token or MCPHub user Key. Connect with an MCP SDK, initialize/negotiate, list tools and then call tools/call. Input/output follow each discovered schema. Streamable HTTP may return JSON or SSE; preserve the MCP session header and send the negotiated protocol version. Close the transport when done. Legacy SSE and user-scoped paths remain available where enabled.

```javascript
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({name:'my-agent',version:'1.0.0'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCPHUB_MCP_URL), {
    requestInit:{headers:{Authorization:`Bearer ${process.env.MCPHUB_USER_KEY}`}}
  }));
  const {tools} = await client.listTools();
  // Select a discovered name and supply arguments matching that tool's inputSchema.
  const add = tools.find(t => /(?:^|[-_])add$/.test(t.name));
  if (!add) throw new Error('Configured demo add tool is unavailable');
  console.log(await client.callTool({name:add.name,arguments:{a:7,b:5}}));
} finally {await client.close();}
```

The management helper `POST /api/tools/call/{server}` takes `{toolName,arguments:{...}}` under VOS user authentication. Do not send the native JSON-RPC envelope to that REST endpoint. MCP notifications/cancelled and transport closure are protocol cancellation signals, not a guarantee that every upstream process stops immediately; confirm its job state through its own tool. MCP tool errors can be returned as `isError` content despite HTTP 200. Never retry a non-idempotent tool call blindly after timeout. There is no MCPHub model-budget/permit/unload API: inference execution and model stopping belong to V-Scheduler or the registered application.

## Errors, network and live OpenAPI

Most management endpoints use `{success,data,message}`; validation and OAuth errors may differ. Check HTTP status and success, then the native response; 400 invalid input, 401 credential, 403 permission, 404 resource, 409 conflict, 429 throttling and 5xx service/upstream failure need different handling. OAuth may return standard error/error_description. Task creation, install, import, delete and credential rotation must not be replayed after an uncertain network response without checking current state. Logs can identify upstream connectivity but must not expose tokens.

`/api/openapi.json` and `/api/{group}/openapi.json` describe dynamically exposed **MCP tools**, not the complete management REST API. They support title, description, version, serverUrl, includeDisabled, group and servers filters as implemented; YAML variants are also available. Inspect those live schemas and tools/list after upstream changes. The sample plant-store openapi.json in the Mintlify source is a documentation sample and is not MCPHub's management contract. Mainland-China hosts may be unable to reach network-restricted foreign APIs; check network reachability separately from credentials.

## Registered HTTP catalogue

The following catalogue is derived from all 169 static registrations in src/routes/index.ts. The source boundary is authenticatedRouter/router/app; middleware and controller checks still apply. Per-entry bindings and response expressions are **TypeScript source expressions**, not JSON examples or invented JSON schemas. Shared-handler delegates and optional/dynamic handlers are linked to their exact source. The native guides following this catalogue explain common operations with concrete request/response examples; shared type definitions retain all declared fields. This does not grant access to internal hosted/OAuth endpoints.

### ALL <BetterAuthPath>

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### ALL <BetterAuthPath>/*

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /health

`app` · `healthCheck` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/healthController.ts#L18)

```json
{
  "responses": [
    {
      "status": "503",
      "method": "json",
      "expression": "{\n          status: 'unhealthy',\n          message: databaseHealth.lastError || 'Database health check failed',\n          servers: serverStats,\n          timestamp: new Date().toISOString(),\n        }"
    },
    {
      "status": "200",
      "method": "json",
      "expression": "{\n        status: 'healthy',\n        message: 'All enabled MCP servers are ready',\n        servers: serverStats,\n        timestamp: new Date().toISOString(),\n      }"
    },
    {
      "status": "200",
      "method": "json",
      "expression": "{\n        status: 'degraded',\n        message: 'Some enabled MCP servers are not ready',\n        servers: serverStats,\n        timestamp: new Date().toISOString(),\n      }"
    },
    {
      "status": "503",
      "method": "json",
      "expression": "{\n      status: 'unhealthy',\n      message: 'Internal server error during health check',\n      timestamp: new Date().toISOString(),\n    }"
    }
  ]
}
```

### GET /livez

`app` · `livenessCheck` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/healthController.ts#L60)

```json
{
  "responses": [
    {
      "status": "200",
      "method": "json",
      "expression": "{ status: 'alive' }"
    }
  ]
}
```

### GET /readyz

`app` · `readinessCheck` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/healthController.ts#L64)

```json
{
  "responses": [
    {
      "status": "503",
      "method": "json",
      "expression": "{ status: 'not_ready' }"
    },
    {
      "status": "200",
      "method": "json",
      "expression": "{ status: 'ready', nodeId: state.nodeId, appliedVersion: state.appliedVersion }"
    },
    {
      "status": "503",
      "method": "json",
      "expression": "{ status: 'not_ready' }"
    }
  ]
}
```

### GET /metrics

`app` · `metrics` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/metricsController.ts#L15)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "404"
    },
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "401"
    },
    {
      "status": "handler default / status set earlier",
      "method": "send",
      "expression": "await metricsRegistry.metrics()"
    },
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "500"
    }
  ]
}
```

### POST /internal/v1/events

`app` · `receiveHostedInternalEvent` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/hostedInternalController.ts#L15)

```json
{
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Hosted mode is not enabled' }"
    },
    {
      "status": "401",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Invalid internal signature',\n      code: verified.reason,\n    }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Invalid hosted webhook event' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, data: { accepted: true } }"
    }
  ]
}
```

### GET /internal/v1/hosted/runtime-catalog

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /oauth/relay/:name

`app` · `handleOAuthRelay` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthRelayController.ts#L9)

```json
{
  "fields": {
    "params": [
      "name"
    ],
    "query": [
      "state"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "400",
      "method": "send",
      "expression": "'Invalid authorization flow'"
    },
    {
      "status": "handler default / status set earlier",
      "method": "redirect",
      "expression": "302, destination.toString()"
    },
    {
      "status": "400",
      "method": "send",
      "expression": "'Unable to relay authorization; reconnect in Dashboard'"
    }
  ]
}
```

### GET /oauth/callback

`app` · `handleOAuthCallback` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthCallbackController.ts#L247)

```json
{
  "fields": {
    "params": [],
    "query": [
      "iss"
    ],
    "body": []
  },
  "bindings": [
    {
      "location": "query",
      "binding": "code, state, error, error_description",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "send",
      "expression": "generateHtmlResponse(t, 'error', t('oauthCallback.authorizationFailed'), '', [\n          { label: t('oauthCallback.authorizationFailedError'), value: String(error) },\n          ...(error_description\n            ? [\n                {\n                  label: t('oauthCallback.authorizationFailedDetails'),\n                  value: String(error_description),\n                },\n              ]\n            : []),\n        ]),"
    },
    {
      "status": "handler default / status set earlier",
      "method": "send",
      "expression": "generateHtmlResponse(\n            t,\n            'success',\n            t('oauthCallback.authorizationSuccessful'),\n            t('server.oauth.personalSuccess'),\n            undefined,\n            true,\n          ),"
    },
    {
      "status": "200",
      "method": "send",
      "expression": "generateHtmlResponse(\n            t,\n            'success',\n            t('oauthCallback.authorizationSuccessful'),\n            t('oauthCallback.successMessage'),\n            [\n              { label: t('oauthCallback.server'), value: serverInfo.name },\n              { label: t('oauthCallback.status'), value: t('oauthCallback.connected') },\n            ],\n            true, // auto-close\n          ),"
    }
  ]
}
```

### GET /oauth/authorize

`app` · `getAuthorize` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthServerController.ts#L358)

```json
{
  "fields": {
    "params": [],
    "query": [
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "resource",
      "response_type",
      "scope",
      "state",
      "token"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "503",
      "method": "json",
      "expression": "{ error: 'OAuth server not available' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ error: 'invalid_client', error_description: 'Client not found' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ error: 'invalid_request', error_description: 'Invalid redirect_uri' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        error: 'invalid_request',\n        error_description: 'PKCE with code_challenge_method=S256 is required for public clients',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "redirect",
      "expression": "`/login?returnUrl=${returnUrl}`"
    },
    {
      "status": "handler default / status set earlier",
      "method": "send",
      "expression": "generateAuthorizeHtml(\n        t('oauthServer.authorizeTitle') || 'Authorize Application',\n        t('oauthServer.authorizeSubtitle') ||\n          'Allow this application to access your MCPHub account.',\n        {\n          clientName: client.name,\n          scopes,\n          approveLabel: t('oauthServer.buttons.approve') || 'Allow access',\n          denyLabel: t('oauthServer.buttons.deny') || 'Deny',\n          approveButtonLabel:\n            t('oauthServer.buttons.approveSubtitle') ||\n            'Recommended if you trust this application.',\n          denyButtonLabel:\n            t('oauthServer.buttons.denySubtitle') || 'You can always grant access later.',\n          formFields,\n        },\n      ),"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ error: 'server_error', error_description: 'Internal server error' }"
    }
  ]
}
```

### POST /oauth/authorize

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /oauth/token

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /oauth/userinfo

`app` · `getUserInfo` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthServerController.ts#L695)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      sub: token.user.username,\n      username: token.user.username,\n      // Add more user info as needed\n    }"
    },
    {
      "status": "401",
      "method": "json",
      "expression": "{\n      error: 'invalid_token',\n      error_description: 'Invalid or expired access token',\n    }"
    }
  ]
}
```

### GET /.well-known/oauth-authorization-server

`app` · `getMetadata` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthServerController.ts#L717)

```json
{
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ error: 'OAuth server not configured' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "metadata"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ error: 'server_error' }"
    }
  ]
}
```

### GET /.well-known/oauth-protected-resource

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /.well-known/oauth-protected-resource/:resourcePath(*)

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /oauth/register

`app` · `registerClient` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthDynamicRegistrationController.ts#L24)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "redirect_uris, client_name, grant_types, response_types, scope, token_endpoint_auth_method, application_type, contacts, logo_uri, client_uri, policy_uri, tos_uri, jwks_uri, jwks,",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        error: 'invalid_request',\n        error_description: 'Dynamic client registration is not enabled',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        error: 'invalid_redirect_uri',\n        error_description: 'redirect_uris is required and must be a non-empty array',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            error: 'invalid_redirect_uri',\n            error_description: `Redirect URI must use HTTPS: ${uri}`,\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          error: 'invalid_redirect_uri',\n          error_description: `Invalid redirect URI: ${uri}`,\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          error: 'invalid_client_metadata',\n          error_description: `Grant type not allowed: ${grantType}`,\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          error: 'invalid_client_metadata',\n          error_description: `Scope not allowed: ${requestedScope}`,\n        }"
    },
    {
      "status": "201",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        error: 'invalid_client_metadata',\n        error_description: 'Client with this ID already exists',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        error: 'server_error',\n        error_description: 'Failed to register client',\n      }"
    }
  ]
}
```

### GET /oauth/register/:clientId

`app` · `getClientConfiguration` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthDynamicRegistrationController.ts#L232)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{\n        error: 'invalid_token',\n        error_description: 'Registration access token required',\n      }"
    },
    {
      "status": "401",
      "method": "json",
      "expression": "{\n        error: 'invalid_token',\n        error_description: 'Invalid or expired registration access token',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        error: 'invalid_client',\n        error_description: 'Client not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'server_error',\n      error_description: 'Failed to retrieve client configuration',\n    }"
    }
  ]
}
```

### PUT /oauth/register/:clientId

`app` · `updateClientConfiguration` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthDynamicRegistrationController.ts#L305)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    },
    {
      "location": "body",
      "binding": "redirect_uris, client_name, grant_types, scope, contacts, logo_uri, client_uri, policy_uri, tos_uri,",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{\n        error: 'invalid_token',\n        error_description: 'Registration access token required',\n      }"
    },
    {
      "status": "401",
      "method": "json",
      "expression": "{\n        error: 'invalid_token',\n        error_description: 'Invalid or expired registration access token',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        error: 'invalid_client',\n        error_description: 'Client not found',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          error: 'invalid_redirect_uri',\n          error_description: 'redirect_uris must be a non-empty array',\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n              error: 'invalid_redirect_uri',\n              error_description: `Redirect URI must use HTTPS: ${uri}`,\n            }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            error: 'invalid_redirect_uri',\n            error_description: `Invalid redirect URI: ${uri}`,\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            error: 'invalid_client_metadata',\n            error_description: `Grant type not allowed: ${grantType}`,\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            error: 'invalid_client_metadata',\n            error_description: `Scope not allowed: ${requestedScope}`,\n          }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        error: 'server_error',\n        error_description: 'Failed to update client',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'server_error',\n      error_description: 'Failed to update client configuration',\n    }"
    }
  ]
}
```

### DELETE /oauth/register/:clientId

`app` · `deleteClientRegistration` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthDynamicRegistrationController.ts#L489)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{\n        error: 'invalid_token',\n        error_description: 'Registration access token required',\n      }"
    },
    {
      "status": "401",
      "method": "json",
      "expression": "{\n        error: 'invalid_token',\n        error_description: 'Invalid or expired registration access token',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        error: 'invalid_client',\n        error_description: 'Client not found',\n      }"
    },
    {
      "status": "204",
      "method": "send",
      "expression": ""
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'server_error',\n      error_description: 'Failed to delete client registration',\n    }"
    }
  ]
}
```

### GET /api/cluster

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /api/users/:username/credentials

`authenticatedRouter` · `listUserCredentials` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L97)

Arguments/responses are delegated to the linked handler; see the native section and source.

### PUT /api/users/:username/credentials/:name

`authenticatedRouter` · `updateUserCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L98)

```json
{
  "fields": {
    "params": [
      "name"
    ],
    "query": [],
    "body": []
  },
  "bindings": [
    {
      "location": "body",
      "binding": "sourceServer, overwrite",
      "type": "|| {}"
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not available' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true }"
    }
  ]
}
```

### DELETE /api/users/:username/credentials/:name

`authenticatedRouter` · `updateUserCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L98)

```json
{
  "fields": {
    "params": [
      "name"
    ],
    "query": [],
    "body": []
  },
  "bindings": [
    {
      "location": "body",
      "binding": "sourceServer, overwrite",
      "type": "|| {}"
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not available' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true }"
    }
  ]
}
```

### POST /api/users/:username/credentials/:name/copy

`authenticatedRouter` · `copyUserCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L142)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /api/credentials/:name/copy

`authenticatedRouter` · `copyMyCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L141)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /api/credentials

`authenticatedRouter` · `listMyCredentials` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L94)

Arguments/responses are delegated to the linked handler; see the native section and source.

### PUT /api/credentials/:name

`authenticatedRouter` · `updateMyCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L95)

Arguments/responses are delegated to the linked handler; see the native section and source.

### DELETE /api/credentials/:name

`authenticatedRouter` · `updateMyCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L95)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /api/oauth/approvals

`authenticatedRouter` · `listMyOAuthApprovals` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthApprovalController.ts#L6)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "401"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: approvals.map((row) => ({\n        id: row.id,\n        clientId: row.clientId,\n        scopes: row.scopes,\n        redirectUri: row.redirectUri,\n        resource: row.resource,\n        approvedAt: row.approvedAt,\n        expiresAt: row.expiresAt,\n      })),\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to list OAuth approvals' }"
    }
  ]
}
```

### DELETE /api/oauth/approvals/:approvalId

`authenticatedRouter` · `revokeMyOAuthApproval` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthApprovalController.ts#L33)

```json
{
  "fields": {
    "params": [
      "approvalId"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "401"
    },
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "404"
    },
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "404"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to revoke OAuth approval' }"
    }
  ]
}
```

### GET /api/integration/whoami

`authenticatedRouter` · `vosWhoami` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/vosIntegrationController.ts#L22)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n    success: true,\n    data: {\n      kind: user.applicationId ? 'application' : 'user',\n      sub: user.vosSubject ?? user.applicationId,\n      username: user.username,\n      is_admin: user.isAdmin === true,\n      application_id: user.applicationId,\n      scope: user.applicationId ? 'public' : 'user-visible',\n    },\n  }"
    }
  ]
}
```

### GET /api/integration/discovery

`authenticatedRouter` · `vosDiscovery` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/vosIntegrationController.ts#L38)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n    success: true,\n    data: {\n      protocol: 'mcp',\n      transport: 'streamable-http',\n      auth: 'VOS Bearer token',\n      mcp_path: `${config.basePath}/mcp`,\n      servers,\n    },\n  }"
    }
  ]
}
```

### GET /api/servers

`authenticatedRouter` · `getAllServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L316)

```json
{
  "fields": {
    "params": [],
    "query": [
      "limit",
      "page"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Page number must be greater than 0',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Limit must be between 1 and 1000',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get servers information',\n    }"
    }
  ]
}
```

### GET /api/servers/:name/share-candidates

`authenticatedRouter` · `getServerShareCandidates` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L401)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: usernames,\n      userGroups: [...new Set(users.flatMap((user) => user.userGroups ?? []))].sort(),\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get server share candidates',\n    }"
    }
  ]
}
```

### GET /api/servers/:name

`authenticatedRouter` · `getServerConfig` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1416)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server not found',\n      }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Forbidden',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get server configuration',\n    }"
    }
  ]
}
```

### GET /api/settings

`authenticatedRouter` · `getAllSettings` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L432)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get server settings',\n    }"
    }
  ]
}
```

### POST /api/servers

`authenticatedRouter` · `createServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L623)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "name, config",
      "type": "as AddServerRequest"
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: nameValidation.message,\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server configuration is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message:\n          'Server configuration must include either a URL, OpenAPI specification URL or schema, or command',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server type must be one of: stdio, sse, streamable-http, openapi',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: `URL is required for ${normalizedConfig.type} server type`,\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OpenAPI specification URL or schema is required for openapi server type',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Headers must be an object',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Headers are not supported for stdio server type',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        message: 'Server added successfully',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: result.message || 'Failed to add server',\n      }"
    }
  ]
}
```

### POST /api/servers/batch

`authenticatedRouter` · `batchCreateServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L766)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "servers",
      "type": "as BatchCreateServersRequest"
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Request body must contain a \"servers\" array',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Servers array cannot be empty',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### POST /api/servers/openapi/tool-stats

`authenticatedRouter` · `previewOpenApiToolStatsHandler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L583)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "config",
      "type": "as AddServerRequest"
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server configuration is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OpenAPI specification URL or schema is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, data: stats }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to analyze OpenAPI specification',\n    }"
    }
  ]
}
```

### PUT /api/servers/:name

`authenticatedRouter` · `updateServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1102)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    },
    {
      "location": "body",
      "binding": "config, newName",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server configuration is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message:\n          'Server configuration must include either a URL, OpenAPI specification URL or schema, or command',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server type must be one of: stdio, sse, streamable-http, openapi',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: `URL is required for ${normalizedConfig.type} server type`,\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OpenAPI specification URL or schema is required for openapi server type',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Headers must be an object',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Headers are not supported for stdio server type',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          success: false,\n          message: nameValidation.message,\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          success: false,\n          message: `Server name '${targetName}' already exists`,\n        }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Server not found',\n        }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Server not found or failed to update',\n        }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        message: 'Server updated successfully',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        message: isRenaming\n          ? `Server renamed and updated successfully`\n          : 'Server updated successfully',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: result.message || 'Server not found or failed to update',\n      }"
    }
  ]
}
```

### DELETE /api/servers/:name

`authenticatedRouter` · `deleteServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L997)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        message: 'Server removed successfully',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: result.message || 'Server not found or failed to remove',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### POST /api/servers/:name/toggle

`authenticatedRouter` · `toggleServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1480)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    },
    {
      "location": "body",
      "binding": "enabled",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Enabled status must be a boolean',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        message: result.message || `Server ${enabled ? 'enabled' : 'disabled'} successfully`,\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: result.message || 'Server not found or failed to toggle status',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### POST /api/servers/:name/reload

`authenticatedRouter` · `reloadServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1536)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: `Server ${name} reloaded successfully`,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to reload server',\n    }"
    }
  ]
}
```

### POST /api/servers/:name/reinstall

`authenticatedRouter` · `reinstallServerHandler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1622)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: `Server ${name} reinstall initiated`,\n    }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to reinstall server' }"
    }
  ]
}
```

### GET /api/servers/:name/oauth/personal

`authenticatedRouter` · `managePersonalOAuth` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/personalOAuthController.ts#L16)

```json
{
  "fields": {
    "params": [
      "name"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{ success: false }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not available' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: {\n        connected: Boolean(context.config.oauth.accessToken),\n        authorizationUrl,\n        status: context.config.oauth.accessToken ? 'connected' : 'oauth_required',\n      },\n    }"
    }
  ]
}
```

### POST /api/servers/:name/oauth/personal

`authenticatedRouter` · `managePersonalOAuth` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/personalOAuthController.ts#L16)

```json
{
  "fields": {
    "params": [
      "name"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{ success: false }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not available' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: {\n        connected: Boolean(context.config.oauth.accessToken),\n        authorizationUrl,\n        status: context.config.oauth.accessToken ? 'connected' : 'oauth_required',\n      },\n    }"
    }
  ]
}
```

### DELETE /api/servers/:name/oauth/personal

`authenticatedRouter` · `managePersonalOAuth` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/personalOAuthController.ts#L16)

```json
{
  "fields": {
    "params": [
      "name"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{ success: false }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not available' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: {\n        connected: Boolean(context.config.oauth.accessToken),\n        authorizationUrl,\n        status: context.config.oauth.accessToken ? 'connected' : 'oauth_required',\n      },\n    }"
    }
  ]
}
```

### POST /api/servers/:name/oauth/disconnect

`authenticatedRouter` · `disconnectServerOAuth` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1579)

```json
{
  "fields": {
    "params": [],
    "query": [],
    "body": [
      "scope"
    ]
  },
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OAuth disconnect scope must be \"tokens\" or \"all\"',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: `Server ${name} OAuth disconnected successfully`,\n      data,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to disconnect server OAuth',\n    }"
    }
  ]
}
```

### POST /api/servers/:serverName/tools/toggle

`authenticatedRouter` · `batchToggleTools` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1685)

```json
{
  "fields": {
    "params": [
      "serverName"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "403",
      "method": "json",
      "expression": "{ success: false, message: 'Forbidden' }"
    },
    {
      "status": "409",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Personal tool inventory is unavailable; connect with your personal authentication first',\n        }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to save settings' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, data }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Internal server error' }"
    }
  ]
}
```

### POST /api/servers/:serverName/tools/:toolName/toggle

`authenticatedRouter` · `toggleTool` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1770)

```json
{
  "fields": {
    "params": [
      "serverName",
      "toolName"
    ],
    "query": [],
    "body": []
  },
  "bindings": [
    {
      "location": "body",
      "binding": "enabled",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name and tool name are required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Enabled status must be a boolean',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to save settings',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: `Tool ${toolName} ${enabled ? 'enabled' : 'disabled'} successfully`,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### PUT /api/servers/:serverName/tools/:toolName/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### DELETE /api/servers/:serverName/tools/:toolName/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### PUT /api/servers/:serverName/tools/:toolName/hidden-params

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /api/servers/:serverName/prompts/:promptName/toggle

`authenticatedRouter` · `togglePrompt` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L2992)

```json
{
  "fields": {
    "params": [
      "promptName",
      "serverName"
    ],
    "query": [],
    "body": []
  },
  "bindings": [
    {
      "location": "body",
      "binding": "enabled",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name and prompt name are required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Enabled status must be a boolean',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to save settings',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: `Prompt ${promptName} ${enabled ? 'enabled' : 'disabled'} successfully`,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### PUT /api/servers/:serverName/prompts/:promptName/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### DELETE /api/servers/:serverName/prompts/:promptName/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /api/servers/:serverName/resources/:resourceUri/toggle

`authenticatedRouter` · `toggleResource` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L3185)

```json
{
  "fields": {
    "params": [
      "resourceUri",
      "serverName"
    ],
    "query": [],
    "body": []
  },
  "bindings": [
    {
      "location": "body",
      "binding": "enabled",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name and resource URI are required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Enabled status must be a boolean',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to save settings',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: `Resource ${resourceUri} ${enabled ? 'enabled' : 'disabled'} successfully`,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### PUT /api/servers/:serverName/resources/:resourceUri/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### DELETE /api/servers/:serverName/resources/:resourceUri/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### PUT /api/system-config

`authenticatedRouter` · `updateSystemConfig` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L2076)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "routing, install, smartRouting: requestSmartRouting, toolResultCompression, mcpRouter, nameSeparator, dashboardName, enableSessionRebuild, oauthServer, auth, activityLog, network, toolPolicies,",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "403",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Admin privileges required',\n    }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'approvalLifetime must be between 1 and 31536000 seconds',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: (error as Error).message }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'routing.allowAuthorizationPassthrough must be a boolean',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Invalid network allowedCidrs or fakeIpExceptions',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: (req as Request & { t?: (key: string) => string }).t?.('vos.authenticationRequired') ?? 'VOS requires dashboard and MCP authentication' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Invalid system configuration provided',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n              message:\n                'Smart routing cannot be enabled without Database URL. Please provide DB URL.',\n            }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n                message:\n                  'Smart routing cannot be enabled without Azure OpenAI configuration. Please provide endpoint, API key, embedding deployment, and API version.',\n              }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n                message:\n                  'Smart routing cannot be enabled without LLM provider configuration. Please provide API key, API base URL, and embedding model.',\n              }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            success: false,\n            message: 'smartRouting.similarityThreshold must be a number between 0 and 1',\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            success: false,\n            message: 'smartRouting.fullSchemaTopN must be a non-negative integer',\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            success: false,\n            message: `smartRouting.toolDefinitionFields must be an array of: ${TOOL_DEFINITION_FIELDS.join(', ')}`,\n          }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        data: systemConfig,\n        message: 'System configuration updated successfully',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to save system configuration',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### POST /api/cache/clear

`authenticatedRouter` · `clearCache` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/serverController.ts#L1657)

```json
{
  "responses": [
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Only admins can clear runner caches',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: 'Cache clear completed',\n      results,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to clear cache',\n    }"
    }
  ]
}
```

### GET /api/cost/servers

`authenticatedRouter` · `getServerCostsHandler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/contextCostController.ts#L6)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to get server context footprint' }"
    }
  ]
}
```

### GET /api/cost/groups

`authenticatedRouter` · `getGroupCostsHandler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/contextCostController.ts#L17)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to get group context footprint' }"
    }
  ]
}
```

### GET /api/smart-routing/performance

`authenticatedRouter` · `getSmartRoutingPerformance` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/smartRoutingController.ts#L143)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to collect smart routing performance stats' }"
    }
  ]
}
```

### POST /api/smart-routing/reindex

`authenticatedRouter` · `reindexSmartRouting` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/smartRoutingController.ts#L334)

```json
{
  "responses": [
    {
      "status": "409",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'A reindex pass is already running',\n    }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Smart routing is not enabled' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Database (DB_URL) is not configured' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to rebuild smart routing index' }"
    }
  ]
}
```

### GET /api/groups

`authenticatedRouter` · `getGroups` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L107)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get groups information',\n    }"
    }
  ]
}
```

### GET /api/groups/:id

`authenticatedRouter` · `getGroup` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L124)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get group information',\n    }"
    }
  ]
}
```

### GET /api/groups/:id/share-candidates

`authenticatedRouter` · `getGroupShareCandidates` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L838)

```json
{
  "fields": {
    "params": [
      "id"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Group not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      userGroups: [...new Set(users.flatMap((user) => user.userGroups ?? []))].sort(),\n      data: users\n        .map((user) => user.username)\n        .filter((username) => username !== group.owner)\n        .sort((a, b) => a.localeCompare(b)),\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to get group share candidates' }"
    }
  ]
}
```

### POST /api/groups

`authenticatedRouter` · `createNewGroup` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L158)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "name, description, instructions, servers, visibility, sharedWithUsers, sharedWithUserGroups,",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: accessError }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group name is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: validationError,\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to create group or group name already exists',\n      }"
    },
    {
      "status": "201",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### POST /api/groups/batch

`authenticatedRouter` · `batchCreateGroups` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L228)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "groups",
      "type": "as BatchCreateGroupsRequest"
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Request body must contain a \"groups\" array',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Groups array cannot be empty',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### PUT /api/groups/:id

`authenticatedRouter` · `updateExistingGroup` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L406)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    },
    {
      "location": "body",
      "binding": "name, description, instructions, servers, visibility, sharedWithUsers, sharedWithUserGroups,",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: accessError }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          success: false,\n          message: validationError,\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message:\n          'At least one field (name, description, instructions, servers, visibility, or sharedWithUsers) is required to update',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group not found or name already exists',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### DELETE /api/groups/:id

`authenticatedRouter` · `deleteExistingGroup` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L583)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group not found or failed to delete',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: 'Group deleted successfully',\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### POST /api/groups/:id/servers

`authenticatedRouter` · `addServerToExistingGroup` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L616)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    },
    {
      "location": "body",
      "binding": "serverName",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group or server not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### DELETE /api/groups/:id/servers/:serverName

`authenticatedRouter` · `removeServerFromExistingGroup` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L660)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id, serverName",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID and server name are required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### GET /api/groups/:id/servers

`authenticatedRouter` · `getGroupServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L695)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get group servers',\n    }"
    }
  ]
}
```

### PUT /api/groups/:id/servers/batch

`authenticatedRouter` · `updateGroupServersBatch` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L493)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    },
    {
      "location": "body",
      "binding": "servers",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Servers must be an array of server names or server configurations',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            success: false,\n            message: 'Each server configuration must have a valid name',\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            success: false,\n            message: 'Server alias must be a string when provided',\n          }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: PINNED_TOOLS_MESSAGE }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n            success: false,\n            message: 'Tools, prompts, and resources must each be \"all\" or an array of strings',\n          }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### GET /api/groups/:id/server-configs

`authenticatedRouter` · `getGroupServerConfigs` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L729)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get group server configurations',\n    }"
    }
  ]
}
```

### GET /api/groups/:id/server-configs/:serverName

`authenticatedRouter` · `getGroupServerConfig` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L755)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id, serverName",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID and server name are required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server not found in group',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get server configuration',\n    }"
    }
  ]
}
```

### PUT /api/groups/:id/server-configs/:serverName/tools

`authenticatedRouter` · `updateGroupServerTools` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/groupController.ts#L789)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id, serverName",
      "type": ""
    },
    {
      "location": "body",
      "binding": "tools",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group ID and server name are required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Tools must be \"all\" or an array of strings',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Group or server not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### GET /api/users

`authenticatedRouter` · `getUsers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/userController.ts#L30)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get users information',\n    }"
    }
  ]
}
```

### GET /api/users/:username

`authenticatedRouter` · `getUser` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/userController.ts#L49)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "username",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Username is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'User not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get user information',\n    }"
    }
  ]
}
```

### POST /api/users

`authenticatedRouter` · `createUser` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/userController.ts#L86)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "username, password, isAdmin, email",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Username and password are required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Password does not meet security requirements',\n        errors: validationResult.errors,\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: reservedError,\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to create user or username already exists',\n      }"
    },
    {
      "status": "201",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### PUT /api/users/:username

`authenticatedRouter` · `updateExistingUser` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/userController.ts#L146)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "username",
      "type": ""
    },
    {
      "location": "body",
      "binding": "isAdmin, newPassword, email, userGroups",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Username is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'User not found',\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Cannot remove admin status from the last admin user',\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Password does not meet security requirements',\n          errors: validationResult.errors,\n        }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'At least one field (isAdmin, email, or newPassword) is required to update',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'User not found or update failed',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### DELETE /api/users/:username

`authenticatedRouter` · `deleteExistingUser` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/userController.ts#L244)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "username",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Username is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Cannot delete your own account',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'User not found, failed to delete, or cannot delete the last admin',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: 'User deleted successfully',\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Internal server error',\n    }"
    }
  ]
}
```

### GET /api/users-stats

`authenticatedRouter` · `getUserStats` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/userController.ts#L290)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get user statistics',\n    }"
    }
  ]
}
```

### GET /api/oauth/clients

`authenticatedRouter` · `getAllClients` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthClientController.ts#L23)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      clients: sanitizedClients,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to retrieve OAuth clients',\n    }"
    }
  ]
}
```

### GET /api/oauth/clients/:clientId

`authenticatedRouter` · `getClient` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthClientController.ts#L58)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OAuth client not found',\n      }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Forbidden',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      client: sanitizedClient,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to retrieve OAuth client',\n    }"
    }
  ]
}
```

### POST /api/oauth/clients

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### PUT /api/oauth/clients/:clientId

`authenticatedRouter` · `updateClient` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthClientController.ts#L180)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    },
    {
      "location": "body",
      "binding": "name, redirectUris, grants, scopes",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OAuth client not found',\n      }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Forbidden',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to update OAuth client',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: 'OAuth client updated successfully',\n      client: {\n        clientId: updatedClient.clientId,\n        name: updatedClient.name,\n        redirectUris: updatedClient.redirectUris,\n        grants: updatedClient.grants,\n        scopes: updatedClient.scopes,\n        owner: updatedClient.owner,\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to update OAuth client',\n    }"
    }
  ]
}
```

### DELETE /api/oauth/clients/:clientId

`authenticatedRouter` · `deleteClient` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthClientController.ts#L246)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OAuth client not found',\n      }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Forbidden',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OAuth client not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: 'OAuth client deleted successfully',\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to delete OAuth client',\n    }"
    }
  ]
}
```

### POST /api/oauth/clients/:clientId/regenerate-secret

`authenticatedRouter` · `regenerateSecret` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/oauthClientController.ts#L294)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "clientId",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'OAuth client not found',\n      }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Forbidden',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to regenerate client secret',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      message: 'Client secret regenerated successfully',\n      clientSecret: newSecret,\n      warning: 'Client secret is only shown once. Please save it securely.',\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to regenerate client secret',\n    }"
    }
  ]
}
```

### GET /api/auth/keys

`authenticatedRouter` · `getBearerKeys` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/bearerKeyController.ts#L64)

```json
{
  "responses": [
    {
      "status": "403",
      "method": "json",
      "expression": "{ success: false, message: 'Authentication required' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to get bearer keys' }"
    }
  ]
}
```

### POST /api/auth/keys

`authenticatedRouter` · `createBearerKey` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/bearerKeyController.ts#L85)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "name, enabled, kind: requestedKind, owner, accessType, allowedGroups, allowedServers, excludedGroups, excludedServers,",
      "type": "as Partial<BearerKey>"
    }
  ],
  "responses": [
    {
      "status": "403",
      "method": "json",
      "expression": "{ success: false, message: 'Authentication required' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Key name is required' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Invalid key kind' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'User-level keys require an owner' }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Bearer key owner not found' }"
    },
    {
      "status": "201",
      "method": "json",
      "expression": "{\n      success: true,\n      data: created,\n      message: 'Bearer key created. The token is only shown once.',\n    } satisfies ApiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to create bearer key' }"
    }
  ]
}
```

### PUT /api/auth/keys/:id

`authenticatedRouter` · `updateBearerKey` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/bearerKeyController.ts#L173)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    },
    {
      "location": "body",
      "binding": "name, enabled, accessType, allowedGroups, allowedServers, excludedGroups, excludedServers",
      "type": "as Partial<BearerKey>"
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Key id is required' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Bearer key not found' }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{ success: false, message: 'Forbidden' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, data: sanitizeKey(updated!) } satisfies ApiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to update bearer key' }"
    }
  ]
}
```

### POST /api/auth/keys/:id/reset

`authenticatedRouter` · `resetBearerKey` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/bearerKeyController.ts#L250)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Key id is required' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Bearer key not found' }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{ success: false, message: 'Forbidden' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Bearer key not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, data: { ...sanitizeKey(updated), token } } satisfies ApiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to reset bearer key' }"
    }
  ]
}
```

### DELETE /api/auth/keys/:id

`authenticatedRouter` · `deleteBearerKey` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/bearerKeyController.ts#L281)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Key id is required' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Bearer key not found' }"
    },
    {
      "status": "403",
      "method": "json",
      "expression": "{ success: false, message: 'Forbidden' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true } satisfies ApiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to delete bearer key' }"
    }
  ]
}
```

### GET /api/activities/available

`authenticatedRouter` · `checkActivityAvailable` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/activityController.ts#L10)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n    success: true,\n    data: {\n      available: isActivityLoggingEnabled(),\n    },\n  }"
    }
  ]
}
```

### GET /api/activities

`authenticatedRouter` · `getActivities` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/activityController.ts#L22)

```json
{
  "fields": {
    "params": [],
    "query": [
      "endDate",
      "group",
      "keyId",
      "keyName",
      "limit",
      "page",
      "server",
      "startDate",
      "status",
      "tool",
      "username"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Activity logging is only available in database mode',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Page number must be greater than 0',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Limit must be between 1 and 100',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: result.data,\n      pagination: {\n        page: result.page,\n        limit: result.limit,\n        total: result.total,\n        totalPages: result.totalPages,\n        hasNextPage: result.page < result.totalPages,\n        hasPrevPage: result.page > 1,\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to fetch activities',\n    }"
    }
  ]
}
```

### GET /api/activities/stats

`authenticatedRouter` · `getActivityStats` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/activityController.ts#L152)

```json
{
  "fields": {
    "params": [],
    "query": [
      "endDate",
      "group",
      "keyId",
      "keyName",
      "server",
      "startDate",
      "status",
      "tool",
      "username"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Activity logging is only available in database mode',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: stats,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to fetch activity statistics',\n    }"
    }
  ]
}
```

### GET /api/activities/filters

`authenticatedRouter` · `getActivityFilterOptions` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/activityController.ts#L213)

```json
{
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Activity logging is only available in database mode',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: {\n        servers,\n        tools,\n        groups,\n        usernames,\n        keyNames,\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to fetch filter options',\n    }"
    }
  ]
}
```

### GET /api/activities/:id

`authenticatedRouter` · `getActivityById` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/activityController.ts#L112)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Activity logging is only available in database mode',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Activity not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: activity,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to fetch activity',\n    }"
    }
  ]
}
```

### DELETE /api/activities/cleanup

`authenticatedRouter` · `deleteOldActivities` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/activityController.ts#L256)

```json
{
  "fields": {
    "params": [],
    "query": [
      "daysOld"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Activity logging is only available in database mode',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'daysOld must be at least 1',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: {\n        deletedCount,\n        cutoffDate: cutoffDate.toISOString(),\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to delete old activities',\n    }"
    }
  ]
}
```

### POST /api/templates/export

`authenticatedRouter` · `exportConfigTemplate` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/templateController.ts#L10)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "name, description, groupIds, includeDisabledServers",
      "type": "as TemplateExportOptions"
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Template name is required',\n      } as ApiResponse"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: template,\n    } as ApiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to export configuration template',\n    } as ApiResponse"
    }
  ]
}
```

### GET /api/templates/export/groups/:id

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /api/templates/import

`authenticatedRouter` · `importConfigTemplate` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/templateController.ts#L84)

```json
{
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Template data is required in request body',\n      } as ApiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to import configuration template',\n    } as ApiResponse"
    }
  ]
}
```

### POST /api/tools/call/:server

`authenticatedRouter` · `callTool` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/toolController.ts#L40)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "server",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'toolName is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to call tool',\n      error: error instanceof Error ? error.message : 'Unknown error occurred',\n    }"
    }
  ]
}
```

### POST /api/mcp/:serverName/prompts/:promptName

`authenticatedRouter` · `getPrompt` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/promptController.ts#L9)

```json
{
  "fields": {
    "params": [
      "promptName",
      "serverName"
    ],
    "query": [],
    "body": [
      "arguments"
    ]
  },
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'serverName and promptName are required',\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Failed to get prompt',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get prompt',\n      error: error instanceof Error ? error.message : 'Unknown error occurred',\n    }"
    }
  ]
}
```

### GET /api/prompts

`authenticatedRouter` · `listBuiltinPrompts` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinPromptController.ts#L10)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to list built-in prompts',\n    }"
    }
  ]
}
```

### GET /api/prompts/:id

`authenticatedRouter` · `getBuiltinPrompt` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinPromptController.ts#L30)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Built-in prompt not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to get built-in prompt',\n    }"
    }
  ]
}
```

### POST /api/prompts

`authenticatedRouter` · `createBuiltinPrompt` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinPromptController.ts#L52)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "name, title, description, template, arguments: args, enabled",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'name and template are required' }"
    },
    {
      "status": "201",
      "method": "json",
      "expression": "response"
    }
  ]
}
```

### PUT /api/prompts/:id

`authenticatedRouter` · `updateBuiltinPrompt` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinPromptController.ts#L83)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Built-in prompt not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    }
  ]
}
```

### DELETE /api/prompts/:id

`authenticatedRouter` · `deleteBuiltinPrompt` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinPromptController.ts#L108)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Built-in prompt not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, message: 'Built-in prompt deleted' }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to delete built-in prompt',\n    }"
    }
  ]
}
```

### GET /api/resources

`authenticatedRouter` · `listBuiltinResources` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinResourceController.ts#L11)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to list built-in resources',\n    }"
    }
  ]
}
```

### GET /api/resources/:id

`authenticatedRouter` · `getBuiltinResource` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinResourceController.ts#L31)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Built-in resource not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to get built-in resource',\n    }"
    }
  ]
}
```

### POST /api/resources

`authenticatedRouter` · `createBuiltinResource` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinResourceController.ts#L53)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "uri, name, description, mimeType, content, enabled",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'uri and content are required' }"
    },
    {
      "status": "201",
      "method": "json",
      "expression": "response"
    }
  ]
}
```

### PUT /api/resources/:id

`authenticatedRouter` · `updateBuiltinResource` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinResourceController.ts#L84)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Built-in resource not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    }
  ]
}
```

### DELETE /api/resources/:id

`authenticatedRouter` · `deleteBuiltinResource` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinResourceController.ts#L109)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "id",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Built-in resource not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, message: 'Built-in resource deleted' }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to delete built-in resource',\n    }"
    }
  ]
}
```

### POST /api/resources/read

`authenticatedRouter` · `readResource` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/builtinResourceController.ts#L131)

```json
{
  "bindings": [
    {
      "location": "body",
      "binding": "uri",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'uri is required' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: error instanceof Error ? error.message : 'Failed to read resource',\n    }"
    }
  ]
}
```

### POST /api/mcpb/upload

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /api/market/servers

`authenticatedRouter` · `getAllMarketServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L14)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get market servers information',\n    }"
    }
  ]
}
```

### GET /api/market/servers/search

`authenticatedRouter` · `searchMarketServersByQuery` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L99)

```json
{
  "bindings": [
    {
      "location": "query",
      "binding": "query",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to search market servers',\n    }"
    }
  ]
}
```

### GET /api/market/servers/:name

`authenticatedRouter` · `getMarketServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L31)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Market server not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get market server information',\n    }"
    }
  ]
}
```

### GET /api/market/categories

`authenticatedRouter` · `getAllMarketCategories` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L65)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get market categories',\n    }"
    }
  ]
}
```

### GET /api/market/categories/:category

`authenticatedRouter` · `getMarketServersByCategory` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L119)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "category",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to filter market servers by category',\n    }"
    }
  ]
}
```

### GET /api/market/tags

`authenticatedRouter` · `getAllMarketTags` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L82)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get market tags',\n    }"
    }
  ]
}
```

### GET /api/market/tags/:tag

`authenticatedRouter` · `getMarketServersByTag` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/marketController.ts#L138)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "tag",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to filter market servers by tag',\n    }"
    }
  ]
}
```

### GET /api/cloud/servers

`authenticatedRouter` · `getAllCloudServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L17)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/servers/search

`authenticatedRouter` · `searchCloudServersByQuery` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L122)

```json
{
  "fields": {
    "params": [],
    "query": [
      "query"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Search query is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/servers/:name

`authenticatedRouter` · `getCloudServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L37)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Cloud server not found',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/categories

`authenticatedRouter` · `getAllCloudCategories` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L83)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/categories/:category

`authenticatedRouter` · `getCloudServersByCategory` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L151)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "category",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Category is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/tags

`authenticatedRouter` · `getAllCloudTags` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L103)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/tags/:tag

`authenticatedRouter` · `getCloudServersByTag` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L180)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "tag",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Tag is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/cloud/servers/:serverName/tools

`authenticatedRouter` · `getCloudServerToolsList` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L209)

```json
{
  "fields": {
    "params": [
      "serverName"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### POST /api/cloud/servers/:serverName/tools/:toolName/call

`authenticatedRouter` · `callCloudTool` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/cloudController.ts#L239)

```json
{
  "fields": {
    "params": [
      "serverName",
      "toolName"
    ],
    "query": [],
    "body": []
  },
  "bindings": [
    {
      "location": "body",
      "binding": "arguments: args",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Tool name is required',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/registry/servers

`authenticatedRouter` · `getAllRegistryServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/registryController.ts#L12)

```json
{
  "bindings": [
    {
      "location": "query",
      "binding": "cursor, limit, search",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "apiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/registry/servers/versions

`authenticatedRouter` · `getRegistryServerVersions` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/registryController.ts#L64)

```json
{
  "fields": {
    "params": [],
    "query": [
      "serverName"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name is required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Server not found',\n        }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "apiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/registry/servers/version

`authenticatedRouter` · `getRegistryServerVersion` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/registryController.ts#L117)

```json
{
  "fields": {
    "params": [],
    "query": [
      "serverName",
      "version"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{\n        success: false,\n        message: 'Server name and version are required',\n      }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n          success: false,\n          message: 'Server version not found',\n        }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "apiResponse"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: errorMessage,\n    }"
    }
  ]
}
```

### GET /api/changelog/update-info

`authenticatedRouter` · `getChangelogUpdateInfoHandler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/changelogController.ts#L6)

```json
{
  "fields": {
    "params": [],
    "query": [
      "currentVersion",
      "force",
      "locale"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message:\n        error instanceof Error ? error.message : 'Failed to fetch changelog update information',\n    }"
    }
  ]
}
```

### GET /api/logs

`authenticatedRouter` · `getAllLogs` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/logController.ts#L8)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, data: logs }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, error: 'Error getting logs' }"
    }
  ]
}
```

### DELETE /api/logs

`authenticatedRouter` · `clearLogs` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/logController.ts#L21)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{ success: true, message: 'Logs cleared successfully' }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, error: 'Error clearing logs' }"
    }
  ]
}
```

### GET /api/logs/stream

`authenticatedRouter` · `streamLogs` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/logController.ts#L34)

```json
{
  "responses": [
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, error: 'Error streaming logs' }"
    }
  ]
}
```

### GET /api/mcp-settings/export

`authenticatedRouter` · `getMcpSettingsJson` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/configController.ts#L149)

```json
{
  "bindings": [
    {
      "location": "query",
      "binding": "serverName",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "404",
      "method": "json",
      "expression": "{\n          success: false,\n          message: `Server '${serverName}' not found`,\n        }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        data: {\n          mcpServers: {\n            [name]: cleanedConfig,\n          },\n        },\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n        success: true,\n        data: settings,\n      }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get MCP settings',\n    }"
    }
  ]
}
```

### GET /api/better-auth/user

`authenticatedRouter` · `getBetterAuthUser` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/betterAuthController.ts#L9)

```json
{
  "responses": [
    {
      "status": "401",
      "method": "json",
      "expression": "{ success: false, message: 'Unauthorized' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      user: {\n        username: user.username,\n        isAdmin: user.isAdmin,\n        permissions: dataService.getPermissions(user),\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Server error' }"
    }
  ]
}
```

### POST /api/auth/vos

`router` · `vosLogin` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/vosAuthController.ts#L5)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "sendStatus",
      "expression": "404"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      user: {\n        username: user.username,\n        displayName: user.displayName,\n        isAdmin: user.isAdmin,\n        permissions: getDataService().getPermissions(user),\n      },\n    }"
    },
    {
      "status": "401",
      "method": "json",
      "expression": "{ success: false, message: (req as Request & { t?: (key: string) => string }).t?.('vos.signInFailed') ?? 'VOS sign-in failed' }"
    }
  ]
}
```

### POST /api/auth/login

`router` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### POST /api/auth/register

`router` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /api/auth/user

`router` · `getCurrentUser` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/authController.ts#L194)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      user: {\n        username: user.username,\n        isAdmin: user.isAdmin,\n        permissions: dataService.getPermissions(user),\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Server error' }"
    }
  ]
}
```

### POST /api/auth/change-password

`router` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

Arguments/responses are delegated to the linked handler; see the native section and source.

### GET /config

`app` · `getRuntimeConfig` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/configController.ts#L39)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: runtimeConfig,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get runtime configuration',\n    }"
    }
  ]
}
```

### GET /public-config

`app` · `getPublicConfig` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/configController.ts#L71)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: {\n        dashboardName: systemConfig?.dashboardName || '',\n        skipAuth,\n        allowRegistration:\n          systemConfig?.auth?.allowRegistration === true &&\n          !betterAuth.disablePasswordLogin,\n        permissions,\n        betterAuth,\n      },\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      message: 'Failed to get public configuration',\n    }"
    }
  ]
}
```

### GET /.well-known/mcp-marketplace

`app` · `getMarketplaceWellKnown` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/discoveryController.ts#L195)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      name: 'mcphub-marketplace',\n      version: '0.1',\n      hub: { name: config.mcpHubName, version: config.mcpHubVersion },\n      endpoints: {\n        servers: `${base}/discovery/servers`,\n        server: `${base}/discovery/servers/{name}`,\n        install: `${base}/discovery/servers/{name}/install`,\n        categories: `${base}/discovery/categories`,\n        tags: `${base}/discovery/tags`,\n      },\n      total_servers: total,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to fetch marketplace metadata' }"
    }
  ]
}
```

### GET /discovery/servers

`app` · `listDiscoveryServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/discoveryController.ts#L74)

```json
{
  "bindings": [
    {
      "location": "query",
      "binding": "search, category, tag, limit",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to list discovery servers' }"
    }
  ]
}
```

### GET /discovery/servers/:name

`app` · `getDiscoveryServer` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/discoveryController.ts#L100)

```json
{
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Server name is required' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not found' }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to get discovery server' }"
    }
  ]
}
```

### GET /discovery/servers/:name/install

`app` · `getDiscoveryServerInstall` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/discoveryController.ts#L125)

```json
{
  "fields": {
    "params": [],
    "query": [
      "type"
    ],
    "body": []
  },
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "400",
      "method": "json",
      "expression": "{ success: false, message: 'Server name is required' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{ success: false, message: 'Server not found' }"
    },
    {
      "status": "404",
      "method": "json",
      "expression": "{\n        success: false,\n        message: preferred\n          ? `Server has no '${preferred}' installation method`\n          : 'Server has no installation method',\n      }"
    },
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to build install snippet' }"
    }
  ]
}
```

### GET /discovery/categories

`app` · `listDiscoveryCategories` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/discoveryController.ts#L173)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to list categories' }"
    }
  ]
}
```

### GET /discovery/tags

`app` · `listDiscoveryTags` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/discoveryController.ts#L183)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "response"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{ success: false, message: 'Failed to list tags' }"
    }
  ]
}
```

### GET /api/openapi.json

`app` · `getOpenAPISpec` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L48)

```json
{
  "fields": {
    "params": [],
    "query": [
      "description",
      "group",
      "includeDisabled",
      "serverUrl",
      "servers",
      "title",
      "version"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to generate OpenAPI specification',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/openapi.yaml

`app` · `getOpenAPISpec` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L48)

```json
{
  "fields": {
    "params": [],
    "query": [
      "description",
      "group",
      "includeDisabled",
      "serverUrl",
      "servers",
      "title",
      "version"
    ],
    "body": []
  },
  "responses": [
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to generate OpenAPI specification',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/:name/openapi.json

`app` · `getGroupOpenAPISpec` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L222)

```json
{
  "fields": {
    "params": [],
    "query": [
      "description",
      "includeDisabled",
      "serverUrl",
      "title",
      "version"
    ],
    "body": []
  },
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to generate group OpenAPI specification',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/:name/openapi.yaml

`app` · `getGroupOpenAPISpec` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L222)

```json
{
  "fields": {
    "params": [],
    "query": [
      "description",
      "includeDisabled",
      "serverUrl",
      "title",
      "version"
    ],
    "body": []
  },
  "bindings": [
    {
      "location": "params",
      "binding": "name",
      "type": ""
    }
  ],
  "responses": [
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to generate group OpenAPI specification',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/openapi/servers

`app` · `getOpenAPIServers` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L76)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: servers,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      error: 'Failed to get available servers',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/openapi/stats

`app` · `getOpenAPIStats` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L97)

```json
{
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "{\n      success: true,\n      data: stats,\n    }"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      success: false,\n      error: 'Failed to get tool statistics',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/tools/:serverName/:toolName

`app` · `executeToolViaOpenAPI` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L120)

```json
{
  "fields": {
    "params": [
      "serverName",
      "toolName"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "result"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to execute tool',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### POST /api/tools/:serverName/:toolName

`app` · `executeToolViaOpenAPI` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L120)

```json
{
  "fields": {
    "params": [
      "serverName",
      "toolName"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "result"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to execute tool',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### GET /api/:name/tools/:serverName/:toolName

`app` · `executeToolViaOpenAPI` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L120)

```json
{
  "fields": {
    "params": [
      "serverName",
      "toolName"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "result"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to execute tool',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

### POST /api/:name/tools/:serverName/:toolName

`app` · `executeToolViaOpenAPI` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/openApiController.ts#L120)

```json
{
  "fields": {
    "params": [
      "serverName",
      "toolName"
    ],
    "query": [],
    "body": []
  },
  "responses": [
    {
      "status": "handler default / status set earlier",
      "method": "json",
      "expression": "result"
    },
    {
      "status": "500",
      "method": "json",
      "expression": "{\n      error: 'Failed to execute tool',\n      message: error instanceof Error ? error.message : 'Unknown error',\n    }"
    }
  ]
}
```

## Native REST and MCP operation guide

Apply the VOS authentication restrictions above to standalone authentication examples below.

### servers

















---

### Get All Servers

Retrieves a list of all configured MCP servers, including their status and available tools.

Connected, enabled MCP servers include an optional `protocolVersion` field containing the current connection's negotiated MCP protocol version. It is omitted for disconnected, disabled, and OpenAPI servers, or when unavailable. This is separate from the server software `version`.

- **Endpoint**: `/api/servers`
- **Method**: `GET`
- **Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "name": "example-server",
        "status": "connected",
        "tools": [
          {
            "name": "tool1",
            "description": "Description of tool 1"
          }
        ],
        "config": {
          "type": "stdio",
          "command": "node",
          "args": ["server.js"]
        }
      }
    ]
  }
  ```

---

### Get a Server

Returns the configuration of a single server, including upstream tools/prompts/resources when connected.

- **Endpoint**: `GET /api/servers/:name`
- **Authentication**: Required.
- Returns `404` if the server is not configured.

---

### Create a New Server

Adds a new MCP server to the configuration.

- **Endpoint**: `/api/servers`
- **Method**: `POST`
- **Body**:
  ```json
  {
    "name": "my-new-server",
    "config": {
      "type": "stdio",
      "command": "python",
      "args": ["-u", "my_script.py"],
      "owner": "admin"
    }
  }
  ```
  - `name` (string, required): The unique name for the server.
  - `config` (object, required): The server configuration object.
    - `type` (string): `stdio`, `sse`, `streamable-http`, or `openapi`.
    - `command` (string): Command to execute for `stdio` type.
    - `args` (array of strings): Arguments for the command.
    - `url` (string): URL for `sse`, `streamable-http`, or `openapi` types.
    - `openapi` (object): OpenAPI configuration.
      - `url` (string): URL to the OpenAPI schema.
      - `schema` (object): The OpenAPI schema object itself.
    - `headers` (object): Headers to send with requests for `sse`, `streamable-http`, and `openapi` types.
    - `keepAliveInterval` (number): Health check interval in milliseconds for remote servers. Defaults to 60000.
    - `enableKeepAlive` (boolean): Toggle periodic health checks for remote servers. Disconnected remote servers always retry automatically with bounded exponential backoff and jitter.
    - `enabled` (boolean): Defaults to `true`. Disabled servers stay in the configuration but are not connected.
    - `owner` (string): The owner of the server. Defaults to the current user or `'admin'`.
    - `passthroughHeaders` (string[]): Inbound HTTP header names that should be forwarded to the upstream server.
    - `oauth`, `proxy`, `options`, `description`: Optional advanced settings — see [MCP Settings](/configuration/mcp-settings).

---

### Batch Create Servers

Create several servers in a single request. The body contains a `servers` **array** of `{ name, config }` objects — the same shape `POST /api/servers` accepts, just batched:

- **Endpoint**: `POST /api/servers/batch`
- **Authentication**: Required.
- **Body**:
  ```json
  {
    "servers": [
      { "name": "fetch", "config": { "type": "stdio", "command": "uvx", "args": ["mcp-server-fetch"] } },
      { "name": "amap", "config": { "type": "sse", "url": "https://mcp.amap.com/sse?key=..." } }
    ]
  }
  ```

Each element is validated independently, and the response contains a per-server `{ name, success, message? }` record so partial batches do not abort the whole request.

---

### Update a Server

Updates the configuration of an existing MCP server.

- **Endpoint**: `/api/servers/:name`
- **Method**: `PUT`
- **Parameters**:
  - `:name` (string, required): The name of the server to update.
- **Body**:
  ```json
  {
    "config": {
      "type": "stdio",
      "command": "node",
      "args": ["new_server.js"]
    }
  }
  ```
  - `config` (object, required): The updated server configuration object. See "Create a New Server" for details.

---

### Delete a Server

Removes an MCP server from the configuration.

- **Endpoint**: `/api/servers/:name`
- **Method**: `DELETE`
- **Parameters**:
  - `:name` (string, required): The name of the server to delete.

---

### Toggle a Server

Enables or disables an MCP server.

- **Endpoint**: `/api/servers/:name/toggle`
- **Method**: `POST`
- **Parameters**:
  - `:name` (string, required): The name of the server to toggle.
- **Body**:
  ```json
  {
    "enabled": true
  }
  ```
  - `enabled` (boolean, required): `true` to enable the server, `false` to disable it.

---

### Reload a Server

Forces MCPHub to disconnect and re-establish the upstream connection (or re-spawn the stdio child) for a single server. Use this when an upstream server has been updated out-of-band or appears stuck.

- **Endpoint**: `POST /api/servers/:name/reload`
- **Authentication**: Required.

---

### Batch Tool Status

`POST /api/servers/:serverName/tools/toggle` enables or disables currently discovered tools in one request. It requires dashboard authentication and the same server configuration access as the single-tool endpoint.

```json
{
  "enabled": false,
  "tools": ["create_*", "delete_*", "specific_tool"]
}
```

- `enabled` is a required boolean; repeated requests set the same state.
- `tools` contains 1–100 non-empty names or patterns, up to 256 characters each. Patterns are case-sensitive full-name matches: `*` matches zero or more characters, `?` matches one; every other character is literal.
- Exact names resolve runtime (server-prefixed) names first, then original upstream names. Patterns match either form using the configured name separator.
- Matching tools are deduplicated and saved in one update. Descriptions and hidden parameters are preserved. The change applies across groups and takes effect for discovery and subsequent calls without reconnecting.
- For personal OAuth or credential bindings, the inventory belongs to the authenticated caller; another user's credentials are never borrowed. If that inventory cannot be acquired, the request returns `409` without changing tool states.
- Patterns are expanded once against the current inventory, not persisted as policies for future tools. An unavailable inventory returns `409`; an empty match succeeds without writing.

The response lists matched runtime names:

```json
{
  "success": true,
  "data": {
    "matchedTools": ["example-create_item", "example-delete_item"],
    "enabled": false
  }
}
```

The existing single-tool endpoint remains available.

---

### Toggle a Tool

Enables or disables a specific tool on a server.

- **Endpoint**: `/api/servers/:serverName/tools/:toolName/toggle`
- **Method**: `POST`
- **Parameters**:
  - `:serverName` (string, required): The name of the server.
  - `:toolName` (string, required): The name of the tool.
- **Body**:
  ```json
  {
    "enabled": true
  }
  ```
  - `enabled` (boolean, required): `true` to enable the tool, `false` to disable it.

---

### Update Tool Description

Updates the description of a specific tool.

- **Endpoint**: `/api/servers/:serverName/tools/:toolName/description`
- **Method**: `PUT`
- **Parameters**:
  - `:serverName` (string, required): The name of the server.
  - `:toolName` (string, required): The name of the tool.
- **Body**:
  ```json
  {
    "description": "New tool description"
  }
  ```
  - `description` (string, required): The new description for the tool.

---

### Reset Tool Description

Drops the override stored in MCPHub and falls back to the upstream tool description.

- **Endpoint**: `DELETE /api/servers/:serverName/tools/:toolName/description`
- **Authentication**: Required.

---

### Hide Tool Parameters

Sets the top-level input parameters of a tool that models do not see. They are removed from the input schema in `tools/list`, `search_tools` results, `describe_tool`, the Smart Routing embedding text, generated OpenAPI specs and context cost figures, and dropped from the arguments of a call before it is forwarded, so the upstream default applies. Use it for options a deployment cannot use, such as cloud-only features of a self-hosted backend. The dashboard keeps showing the full schema.

- **Endpoint**: `/api/servers/:serverName/tools/:toolName/hidden-params`
- **Method**: `PUT`
- **Parameters**:
  - `:serverName` (string, required): The name of the server.
  - `:toolName` (string, required): The name of the tool, bare or server-prefixed.
- **Body**:
  ```json
  {
    "hiddenParams": ["profile", "zeroDataRetention"]
  }
  ```
  - `hiddenParams` (string[], required): Top-level parameter names. An empty array removes the setting.
- **Errors**: `400` when a name is not a parameter of the tool or is listed in its `required`. These checks run when the server is connected; otherwise the list is stored as given, and a required parameter is still never hidden.

---

### Prompts

MCPHub exposes the same toggle / describe / reset triple for upstream prompts. The body shape mirrors the tool endpoints above.

| Method & Path | Purpose |
| ------------- | ------- |
| `POST /api/servers/:serverName/prompts/:promptName/toggle` | Enable / disable a prompt. Body: `{ "enabled": true }`. |
| `PUT /api/servers/:serverName/prompts/:promptName/description` | Override the prompt description. Body: `{ "description": "..." }`. |
| `DELETE /api/servers/:serverName/prompts/:promptName/description` | Reset the description to the upstream value. |

---

### Resources

| Method & Path | Purpose |
| ------------- | ------- |
| `POST /api/servers/:serverName/resources/:resourceUri/toggle` | Enable / disable a resource. Body: `{ "enabled": true }`. The `:resourceUri` must be URL-encoded. |
| `PUT /api/servers/:serverName/resources/:resourceUri/description` | Override the resource description. |
| `DELETE /api/servers/:serverName/resources/:resourceUri/description` | Reset the description. |

---

### System Configuration

System-wide configuration (routing, install, smart routing, mcpRouter, name separator, session rebuild, OAuth server) is managed through `PUT /api/system-config`. See [System Config API](/api-reference/config) for the full request schema and accepted top-level keys (`routing`, `install`, `smartRouting`, `mcpRouter`, `nameSeparator`, `enableSessionRebuild`, `oauthServer`).


  The legacy `openaiApiKey` / `modelName` / `temperature` / `maxTokens` request body is no longer accepted. Smart-routing model selection now lives under the nested `smartRouting` object documented in [System Config API](/api-reference/config).


---

### Get Settings

Retrieves all server settings and configurations.

- **Endpoint**: `/api/settings`
- **Method**: `GET`
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "servers": [...],
      "groups": [...],
      "systemConfig": {...}
    }
  }
  ```

**Note**: For built-in prompt and resource management (not tied to an upstream server), see the [Prompts API](/api-reference/prompts) documentation.

---

### Other server-adjacent endpoints

MCPHub exposes several other route families beyond pure server CRUD. Each lives on its own resource and is documented separately or, where no dedicated page exists yet, follows the schema described inline:

| Family | Method & Path(s) | Notes |
| ------ | ---------------- | ----- |
| **Auth & users** | `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/user`, `POST /api/auth/change-password`, `/api/users/*`, `/api/users-stats` | See [Auth](/api-reference/auth) and [Users](/api-reference/users). |
| **Bearer keys** | `GET /api/auth/keys`, `POST /api/auth/keys`, `PUT /api/auth/keys/:id`, `DELETE /api/auth/keys/:id` | System-level and user-level static MCP tokens. Only all-access system keys can authenticate dashboard APIs. See [Authentication](/features/authentication). |
| **Groups** | `/api/groups`, `/api/groups/batch`, `/api/groups/:id/servers*`, `/api/groups/:id/server-configs*` | See [Groups](/api-reference/groups). |
| **Templates** | `POST /api/templates/export`, `GET /api/templates/export/groups/:id`, `POST /api/templates/import` | Export / import `mcp_settings.json` snapshots and group templates. Rate-limited. |
| **Activities** | `GET /api/activities`, `/api/activities/stats`, `/api/activities/filters`, `/api/activities/:id`, `DELETE /api/activities/cleanup`, `GET /api/activities/available` | Database mode only — see [Monitoring](/features/monitoring). |
| **Logs** | `GET /api/logs`, `DELETE /api/logs`, `GET /api/logs/stream` | In-process log buffer + SSE stream. |
| **Built-in prompts / resources** | `/api/prompts`, `/api/resources`, `POST /api/resources/read` | First-party prompts and resources that are not attached to an upstream server. |
| **MCPB upload** | `POST /api/mcpb/upload` | Upload an MCPB bundle to register a new server. |
| **Market / Cloud / Registry** | `/api/market/*`, `/api/cloud/*`, `/api/registry/*` | Read-only catalogs that back the dashboard's discovery pages. |
| **OAuth clients (MCPHub server)** | `/api/oauth/clients`, `/api/oauth/clients/:clientId/regenerate-secret` | Manage clients of MCPHub's own authorization server. The flow itself lives at `/oauth/*` and is documented under [OAuth](/features/oauth). |
| **Better Auth** | `GET /api/better-auth/user`, plus the Better Auth handler mounted at `${BASE_PATH}${betterAuthConfig.basePath}` (default `/api/auth/better`) | Optional GitHub / Google login. |
| **OpenAPI** | `GET ${BASE_PATH}/api/openapi.{json,yaml}`, `GET ${BASE_PATH}/api/:name/openapi.{json,yaml}`, `GET ${BASE_PATH}/api/openapi/servers`, `GET ${BASE_PATH}/api/openapi/stats`, plus the OpenAPI tool execution routes | See [OpenAPI](/api-reference/openapi). |
| **MCP settings export** | `GET /api/mcp-settings/export` | Download the live settings as JSON. |

### groups












---

### Get All Groups

Retrieves a list of all server groups.

- **Endpoint**: `/api/groups`
- **Method**: `GET`
- **Success Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "group-1",
        "name": "My Group",
        "description": "A collection of servers.",
        "servers": ["server1", "server2"],
        "owner": "admin"
      }
    ]
  }
  ```

---

### Create a New Group

Creates a new server group.

- **Endpoint**: `/api/groups`
- **Method**: `POST`
- **Body**:
  - `name` (string, required): The name of the group.
  - `description` (string, optional): A description for the group.
  - `instructions` (string, optional): Sent as the MCP `initialize` instructions on the group's routes. See [Group instructions](/features/group-management#group-instructions).
  - `servers` (array, optional): A list of server names or capability-scoped server configuration objects.
- **Request Example**:
  ```json
  {
    "name": "My New Group",
    "description": "A description for the new group",
    "servers": [
      "server1",
      {
        "name": "server2",
        "tools": ["toolA", "toolB"],
        "prompts": ["draft_prompt"],
        "resources": ["resource://docs/guide"]
      }
    ]
  }
  ```

---

### Get a Group

Retrieves details for a specific group by its ID or name.

- **Endpoint**: `/api/groups/:id`
- **Method**: `GET`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group.

---

### Update a Group

Updates an existing group's name, description, instructions, or server list.

- **Endpoint**: `/api/groups/:id`
- **Method**: `PUT`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group to update.
- **Body**:
  - `name` (string, optional): The new name for the group.
  - `description` (string, optional): The new description for the group.
  - `instructions` (string, optional): The new instructions for the group; an empty string removes them.
  - `servers` (array, optional): The new list of servers for the group. See [Batch Update Group Servers](#batch-update-group-servers) for format.
- **Request Example**:
  ```json
  {
    "name": "Updated Group Name",
    "description": "Updated description"
  }
  ```

---

### Delete a Group

Deletes a group by its ID or name.

- **Endpoint**: `/api/groups/:id`
- **Method**: `DELETE`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group to delete.

---

### Add Server to Group

Adds a single server to a group.

- **Endpoint**: `/api/groups/:id/servers`
- **Method**: `POST`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group.
- **Body**:
  - `serverName` (string, required): The name of the server to add.
- **Request Example**:
  ```json
  {
    "serverName": "my-server"
  }
  ```

---

### Remove Server from Group

Removes a single server from a group.

- **Endpoint**: `/api/groups/:id/servers/:serverName`
- **Method**: `DELETE`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group.
  - `:serverName` (string, required): The name of the server to remove.

---

### Batch Update Group Servers

Replaces all servers in a group with a new list. The list can be simple strings or detailed configuration objects.

- **Endpoint**: `/api/groups/:id/servers/batch`
- **Method**: `PUT`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group.
- **Body**:
  - `servers` (array, required): An array of server names (strings) or server configuration objects.
- **Request Example (Simple)**:
  ```json
  {
    "servers": ["server1", "server2"]
  }
  ```
- **Request Example (Detailed)**:
  ```json
  {
    "servers": [
      {
        "name": "server1",
        "tools": "all",
        "prompts": "all",
        "resources": "all"
      },
      {
        "name": "server2",
        "tools": ["toolA", "toolB"],
        "prompts": ["draft_prompt"],
        "resources": ["resource://docs/guide"]
      }
    ]
  }
  ```

Each detailed server object accepts these optional capability selectors:

- `preserveToolNames`: a boolean (default `false`). Expose upstream tool names without a server prefix on group and Smart Routing routes. Names must be unique in the group; prompts and resources are unchanged. See [Keep original tool names](/features/group-management#keep-original-tool-names).
- `tools`: `"all"` or an array of tool names.
- `prompts`: `"all"` or an array of prompt names.
- `resources`: `"all"` or an array of resource URIs.
- `pinnedTools`: an array of bare tool names listed next to the meta-tools on the group's `$smart/{group}` endpoint (see [Pinned Tools](/features/smart-routing#pinned-tools)). Only pins that are also selected in `tools` take effect.

---

### Get Group Server Configs

Retrieves the detailed configuration for all servers within a group, including which tools, prompts, and resources are enabled.

- **Endpoint**: `/api/groups/:id/server-configs`
- **Method**: `GET`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group.
- **Success Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "name": "server1",
        "tools": "all",
        "prompts": "all",
        "resources": "all"
      },
      {
        "name": "server2",
        "tools": ["toolA", "toolB"],
        "prompts": ["draft_prompt"],
        "resources": ["resource://docs/guide"]
      }
    ]
  }
  ```

---

### Update Group Server Tools

Updates the tool selection for a specific server within a group.

- **Endpoint**: `/api/groups/:id/server-configs/:serverName/tools`
- **Method**: `PUT`
- **Parameters**:
  - `:id` (string, required): The ID or name of the group.
  - `:serverName` (string, required): The name of the server to update.
- **Body**:
  - `tools` (string or array of strings, required): Either the string `"all"` to enable all tools, or an array of tool names to enable specifically. Pins (`pinnedTools`) of tools left out of the array are removed.
- **Request Example**:
  ```json
  {
    "tools": ["toolA", "toolC"]
  }
  ```

### Visibility fields

`POST /api/groups`, entries in `POST /api/groups/batch`, and `PUT /api/groups/:id`
accept `visibility` (`private | group | public`) and `sharedWithUsers` (an array of
non-empty usernames). New groups default to `private`; omitted fields on update remain
unchanged. `shared` and `null` are not valid visibility values. An empty shared user list
allows only the owner and admins.

`GET /api/groups/:id/share-candidates` returns a sorted array of usernames, excluding
the owner, and requires owner/admin access. Sharing grants discovery/use, not management.
All group read responses filter inaccessible nested servers; replacement server edits
preserve existing inaccessible entries. See [Group Management](/features/group-management)
for legacy compatibility and database upgrade behavior.

### tools



---

### Call a Tool

Execute a specific tool on an MCP server with given arguments.

- **Endpoint**: `/api/tools/call/:server`
- **Method**: `POST`
- **Parameters**:
  - `:server` (string, required): The name of the MCP server.
- **Body**:
  ```json
  {
    "toolName": "tool-name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    }
  }
  ```
  - `toolName` (string, required): The name of the tool to execute. Accepted in either form:
    - The bare upstream tool name (e.g. `weather`). MCPHub will route it to `:server`.
    - The fully qualified `<server><separator><tool>` form (e.g. `amap-weather`). The separator defaults to `-` and is configurable via `systemConfig.nameSeparator` (see [System Config API](/api-reference/config)). Use the qualified form when an upstream tool name happens to contain the separator and you need to disambiguate.
  - `arguments` (object, optional): The arguments to pass to the tool. Defaults to an empty object.

- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "content": [
        {
          "type": "text",
          "text": "Tool execution result"
        }
      ],
      "toolName": "tool-name",
      "arguments": {
        "param1": "value1",
        "param2": "value2"
      }
    }
  }
  ```

The response keeps the `success` / `data` envelope. `data` preserves the tool result fields, including `structuredContent`, `isError`, and `_meta` when present, alongside `toolName` and the converted `arguments`. Missing `content` defaults to `[]`. A tool execution failure is indicated by `data.isError: true`; the envelope's `success: true` means the API returned a tool result, not that the tool succeeded.

**Example Request:**

```bash
curl -X POST "http://localhost:3000/api/tools/call/amap" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "toolName": "amap-maps_weather",
    "arguments": {
      "city": "Beijing"
    }
  }'
```

**Notes:**
- The tool arguments are automatically converted to the proper types based on the tool's input schema.
- Use the `x-session-id` header to maintain session state across multiple tool calls if needed.
- This endpoint requires authentication.

---

### Alternative: OpenAPI Tool Execution

For OpenAPI-compatible tool execution without authentication, see the [OpenAPI Integration](/api-reference/openapi#tool-execution) documentation. The OpenAPI endpoints provide:

- **GET** `/api/tools/:serverName/:toolName` - For simple tools with query parameters
- **POST** `/api/tools/:serverName/:toolName` - For complex tools with JSON body

These endpoints are designed for integration with OpenWebUI and other OpenAPI-compatible systems.

### prompts







---

### Get a Prompt

Execute a prompt on an MCP server and get the result.

- **Endpoint**: `/api/mcp/:serverName/prompts/:promptName`
- **Method**: `POST`
- **Authentication**: Required
- **Parameters**:
  - `:serverName` (string, required): The name of the MCP server.
  - `:promptName` (string, required): The name of the prompt.
- **Body**:
  ```json
  {
    "arguments": {
      "arg1": "value1",
      "arg2": "value2"
    }
  }
  ```
  - `arguments` (object, optional): Arguments to pass to the prompt.

- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "messages": [
        {
          "role": "user",
          "content": {
            "type": "text",
            "text": "Prompt content"
          }
        }
      ]
    }
  }
  ```

**Example Request:**

```bash
curl -X POST "http://localhost:3000/api/mcp/myserver/prompts/code-review" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "arguments": {
      "language": "typescript",
      "code": "const x = 1;"
    }
  }'
```

---

### Toggle a Prompt

Enable or disable a specific prompt on a server.

- **Endpoint**: `/api/servers/:serverName/prompts/:promptName/toggle`
- **Method**: `POST`
- **Authentication**: Required
- **Parameters**:
  - `:serverName` (string, required): The name of the server.
  - `:promptName` (string, required): The name of the prompt.
- **Body**:
  ```json
  {
    "enabled": true
  }
  ```
  - `enabled` (boolean, required): `true` to enable the prompt, `false` to disable it.

**Example Request:**

```bash
curl -X POST "http://localhost:3000/api/servers/myserver/prompts/code-review/toggle" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"enabled": false}'
```

---

### Update Prompt Description

Update the description of a specific prompt.

- **Endpoint**: `/api/servers/:serverName/prompts/:promptName/description`
- **Method**: `PUT`
- **Authentication**: Required
- **Parameters**:
  - `:serverName` (string, required): The name of the server.
  - `:promptName` (string, required): The name of the prompt.
- **Body**:
  ```json
  {
    "description": "New prompt description"
  }
  ```
  - `description` (string, required): The new description for the prompt.

**Example Request:**

```bash
curl -X PUT "http://localhost:3000/api/servers/myserver/prompts/code-review/description" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"description": "Review code for best practices and potential issues"}'
```

**Note**: Prompts are templates that can be used to generate standardized requests to MCP servers. They are defined by the MCP server and can have arguments that are filled in when the prompt is executed.

### users

These endpoints manage the local username/password users stored in `mcp_settings.json` (or the `mcphub_user` table when the database backend is enabled). All endpoints require an authenticated admin (`isAdmin: true`).

For OAuth/social accounts created via Better Auth, see `/api/better-auth/*` instead — those records live in a separate table and are not managed through this API.








---

### Get All Users

- **Endpoint**: `GET /api/users`
- **Authentication**: Required (admin only)
- **Response**: The `password` field is stripped from every record.

```json
{
  "success": true,
  "data": [
    { "username": "admin", "isAdmin": true },
    { "username": "alice", "isAdmin": false }
  ]
}
```

---

### Get a User

- **Endpoint**: `GET /api/users/:username`
- **Authentication**: Required (admin only)
- **Response**:

```json
{
  "success": true,
  "data": { "username": "alice", "isAdmin": false }
}
```

Returns `404` if the user does not exist.

---

### Create a User

- **Endpoint**: `POST /api/users`
- **Authentication**: Required (admin only)
- **Body**:

```json
{
  "username": "alice",
  "password": "P@ssw0rd-123",
  "isAdmin": false
}
```

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `username` | string | yes | Must be unique. |
| `password` | string | yes | Must satisfy the configured password policy (see `src/utils/passwordValidation.ts`). |
| `isAdmin` | boolean | no | Defaults to `false`. |

- Returns `400` if `username`/`password` are missing, the password is too weak, or the username is already taken.
- Returns `201` with the new user (password stripped) on success.


  The user model does not have per-user `servers` or `groups` lists. Server access is governed by each server's `owner`, `visibility`, and `sharedWithUsers` fields. See [Authentication & Security](/features/authentication) and [MCP Settings](/configuration/mcp-settings).


---

### Update a User

- **Endpoint**: `PUT /api/users/:username`
- **Authentication**: Required (admin only)
- **Body** (at least one field is required):

```json
{
  "isAdmin": true,
  "newPassword": "Newp@ssw0rd"
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `isAdmin` | boolean | Promote/demote the user. |
| `userGroups` | string[] | Replace case-sensitive user-group memberships (admin only). Empty array removes all memberships; names are trimmed and deduplicated. |
| `newPassword` | string | Replace the user's password. Must satisfy the password policy. |

- Returns `400` if no supported field is supplied, the password fails validation, or the request would demote the last remaining admin.
- Returns `404` if the username does not exist.


  Username is the primary key — to rename a user, delete and recreate them. Other profile fields (email, display name, etc.) are not currently supported on the local user model.


---

### Delete a User

- **Endpoint**: `DELETE /api/users/:username`
- **Authentication**: Required (admin only)
- **Restrictions**:
  - You cannot delete your own account.
  - You cannot delete the last admin.

```json
{
  "success": true,
  "message": "User deleted successfully"
}
```

---

### Get User Statistics

- **Endpoint**: `GET /api/users-stats`
- **Authentication**: Required (admin only)

```json
{
  "success": true,
  "data": {
    "totalUsers": 5,
    "adminUsers": 1,
    "regularUsers": 4
  }
}
```

The stats endpoint reports only aggregate counts; per-server or per-group breakdowns are not produced here.

### logs







---

### Get All Logs

Retrieves all stored logs.

- **Endpoint**: `/api/logs`
- **Method**: `GET`
- **Success Response**:
  ```json
  {
    "success": true,
    "data": [
      {
        "timestamp": "2023-10-27T10:00:00.000Z",
        "level": "info",
        "message": "Server started successfully.",
        "service": "system"
      }
    ]
  }
  ```

---

### Clear Logs

Deletes all stored logs.

- **Endpoint**: `/api/logs`
- **Method**: `DELETE`
- **Success Response**:
  ```json
  {
    "success": true,
    "message": "Logs cleared successfully"
  }
  ```

---

### Stream Logs

Streams logs in real-time using Server-Sent Events (SSE). The connection will remain open, and new log entries will be sent as they occur.

- **Endpoint**: `/api/logs/stream`
- **Method**: `GET`
- **Response Format**: The stream sends events with a `data` field containing a JSON object. The first event has `type: 'initial'` and contains all historical logs. Subsequent events have `type: 'log'` and contain a single new log entry.

- **Example Event**:
  ```
  data: {"type":"log","log":{"timestamp":"2023-10-27T10:00:05.000Z","level":"debug","message":"Processing request for /api/some-endpoint","service":"mcp-server"}}
  ```

### config






---

### Update System Config

Updates various parts of the system configuration. You only need to provide the keys for the sections you want to update.

- **Endpoint**: `/api/system-config`
- **Method**: `PUT`
- **Body**: A JSON object containing one or more of the following top-level keys: `routing`, `install`, `smartRouting`, `toolResultCompression`, `mcpRouter`.

### Routing Configuration (`routing`)

- `enableGlobalRoute` (boolean): Enable or disable the global `/api/mcp` route.
- `enableGroupNameRoute` (boolean): Enable or disable group-based routing (e.g., `/api/mcp/group/:groupName`).
- `enableBearerAuth` (boolean): Require bearer token authentication for MCP endpoints (default: `true`).
- `bearerAuthKey` (string): Legacy bearer key (used only for one-time migration).
- `bearerAuthHeaderName` (string): Header name used to receive MCP bearer credentials (default: `Authorization`). Change this when upstream passthrough headers also use `Authorization`.
- `jsonBodyLimit` (string): Express JSON body size limit (default: `1mb`). This applies to large inline OpenAPI schema uploads too.
- `skipAuth` (boolean): If true, skips dashboard/web API login requirements so the frontend can call `/api` routes without a session token. Unauthenticated dashboard users are treated as the built-in `guest` administrator, so enable this only in trusted environments. This does **not** disable MCP endpoint authentication.

### Install Configuration (`install`)

- `pythonIndexUrl` (string): The base URL of the Python Package Index (PyPI) to use for installations.
- `npmRegistry` (string): The URL of the npm registry to use for installations.
- `baseUrl` (string): The public base URL of this MCPHub instance, used for MCP requests and OAuth callback URLs.

### Smart Routing Configuration (`smartRouting`)

- `enabled` (boolean): Enable or disable the Smart Routing feature.
- `dbUrl` (string): The database connection URL for storing embeddings.
- `llmProviderBaseUrl` (string): The base URL for the OpenAI-compatible API for generating embeddings.
- `llmProviderApiKey` (string): The API key for the embeddings service.
- `embeddingModel` (string): The name of the embedding model to use.
- `embeddingDimensions` (number, optional): The output dimensionality for providers that support configurable dimensions. Leave unset to use the model default. This value also declares the expected storage dimension, but it is only forwarded to the provider as the `dimensions` request parameter for models known to support Matryoshka (MRL) representations, or when `embeddingDimensionsApiPassthrough` is enabled (issue #1131).
- `embeddingDimensionsApiPassthrough` (boolean, optional, default `false`): When `true`, always forward `embeddingDimensions` to the provider as the `dimensions` request parameter. Non-MRL models/backends (Qwen3-Embedding, BGE, vLLM/sglang) reject the parameter outright; enable only for other MRL-capable models. See also `EMBEDDING_DIMENSIONS_API_PASSTHROUGH`.

### Tool Result Compression Configuration (`toolResultCompression`)

- `enabled` (boolean): Enable transparent compression for successful tool results.
- `minTokens` (number): Only compress text blocks at or above this estimated token count. Default: `2000`.
- `maxOutputTokens` (number): Target token budget for each compressed text block. Default: `1200`.
- `strategy` (string): Compression strategy. Allowed values: `auto`, `json`, `log`, `search`, `diff`, `text`. Default: `auto`.

Compression applies only to successful tool responses. `isError: true` responses and non-text content blocks are returned unchanged. Activity logging records the original upstream output before compression.

### MCP Router Configuration (`mcpRouter`)

- `apiKey` (string): The API key for the MCP Router service.
- `referer` (string): The referer header to use for MCP Router requests.
- `title` (string): The title to display for this instance on MCP Router.
- `baseUrl` (string): The base URL for the MCP Router API.

- **Request Example**:
  ```json
  {
    "routing": {
      "enableBearerAuth": true,
      "bearerAuthHeaderName": "X-MCP-Authorization",
      "jsonBodyLimit": "5mb",
      "skipAuth": false
    },
    "smartRouting": {
      "enabled": true,
      "dbUrl": "postgresql://user:pass@host:port/db"
    },
    "toolResultCompression": {
      "enabled": true,
      "minTokens": 2000,
      "maxOutputTokens": 1200,
      "strategy": "auto"
    }
  }
  ```

---

### Get All Settings

Retrieves the entire settings object for the instance, including all server configurations, groups, and system settings. This is a comprehensive dump of the `mcp_settings.json` file.

- **Endpoint**: `/api/settings`
- **Method**: `GET`

---

### Get Runtime Config

Retrieves the essential runtime configuration required for the frontend application. This endpoint does not require authentication.

- **Endpoint**: `/config`
- **Method**: `GET`
- **Success Response**:
  ```json
  {
    "success": true,
    "data": {
      "basePath": "",
      "version": "1.0.0",
      "name": "MCPHub"
    }
  }
  ```

---

### Get Public Config

Retrieves public configuration, primarily to check if authentication is skipped. This allows the frontend to adjust its behavior accordingly before a user has logged in. This endpoint does not require authentication.

- **Endpoint**: `/public-config`
- **Method**: `GET`
- **Success Response**:
  ```json
  {
    "success": true,
    "data": {
      "skipAuth": false,
      "permissions": {}
    }
  }
  ```

### Session rebuild

Set `enableSessionRebuild` to `true` to recreate a missing Streamable HTTP session
using its existing ID. This does not restore the client's negotiated capabilities.
Single-upstream routes accept both raw and prefixed tool names, allowing cached
ordinary tool calls to continue. MCP Apps metadata and app-only tools still require
a fresh initialization that advertises Apps support.

When rebuild is disabled, requests with an unknown session ID return HTTP 404 so
the client can initialize a new session. Requests missing a required session ID
continue to return HTTP 400.

### system









---

### Health Check

Check the health status of the MCPHub server.

- **Endpoint**: `/health`
- **Method**: `GET`
- **Authentication**: Not required
- **Response**:
  ```json
  {
    "status": "ok",
    "timestamp": "2024-11-12T01:30:00.000Z",
    "uptime": 12345
  }
  ```

**Example Request:**

```bash
curl "http://localhost:3000/health"
```

---

### OAuth Callback

OAuth callback endpoint for handling OAuth authentication flows. This endpoint is automatically called by OAuth providers after user authorization.

- **Endpoint**: `/oauth/callback`
- **Method**: `GET`
- **Authentication**: Not required (public callback URL)
- **Query Parameters**: Varies by OAuth provider (typically includes `code`, `state`, etc.)

**Note**: This endpoint is used internally by MCPHub's OAuth integration and should not be called directly by clients.

---

### Upload MCPB File

Upload a MCPB (MCP Bundle) file to import server configurations.

- **Endpoint**: `/api/mcpb/upload`
- **Method**: `POST`
- **Authentication**: Required (admin only)
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `mcpbFile` (file, required): The MCPB bundle file to upload.

**Security notes:**

- **Admin only**: the uploaded bundle's code is extracted to the deterministic `data/uploads/mcpb/server-<name>` path that existing stdio server configurations execute from, so non-admin uploads are rejected with `403` before the request body is staged on disk.
- `manifest.json` must include a safe `name` value using only letters, numbers, `.`, `_`, and `-`.
- Uploads are rejected if the manifest name contains path separators, `..`, or other unsafe path characters.

**Example Request:**

```bash
curl -X POST "http://localhost:3000/api/mcpb/upload" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "mcpbFile=@bundle.mcpb"
```

---

### Export MCP Settings

Export the current MCP settings configuration as a JSON file.

- **Endpoint**: `/api/mcp-settings/export`
- **Method**: `GET`
- **Authentication**: Required
- **Response**: Returns the `mcp_settings.json` configuration file.

**Example Request:**

```bash
curl "http://localhost:3000/api/mcp-settings/export" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o mcp_settings.json
```

**Note**: This endpoint allows you to download a backup of your MCP settings, which can be used to restore or migrate your configuration.

### auth









---

### Login

Authenticates a user and returns a JWT token along with user details.

- **Endpoint**: `/api/auth/login`
- **Method**: `POST`
- **Body**:
  - `username` (string, required): The user's username.
  - `password` (string, required): The user's password.
- **Request Example**:
  ```json
  {
    "username": "admin",
    "password": "your-admin-password"
  }
  ```
- **Success Response**:
  ```json
  {
    "success": true,
    "message": "Login successful",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "username": "admin",
      "isAdmin": true,
      "permissions": { ... }
    }
  }
  ```

- **Password login disabled**: while Better Auth's `disablePasswordLogin` is in effect, the endpoint answers `403` with `{"success": false, "message": "Password login is disabled. Sign in with SSO, or use a bearer key for API access."}`. See [SSO-only sign-in](/features/authentication#sso-only-sign-in).

---

### Register

Registers a regular user and returns a JWT token. Requires `systemConfig.auth.allowRegistration: true` (default: false) and password login to be enabled; otherwise returns HTTP 403.

- **Endpoint**: `/api/auth/register`
- **Method**: `POST`
- **Body**:
  - `username` (string, required): The desired username.
  - `password` (string, required): The desired password (at least 8 characters, including a letter, a number, and a special character).
  - Administrator privileges cannot be requested; `isAdmin` is ignored.
- **Request Example**:
  ```json
  {
    "username": "newuser",
    "password": "Password123!"
  }
  ```
- **Success Response**:
  ```json
  {
    "success": true,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "username": "newuser",
      "isAdmin": false,
      "permissions": { ... }
    }
  }
  ```

---

### Get Current User

Retrieves the profile of the currently authenticated user.

- **Endpoint**: `/api/auth/user`
- **Method**: `GET`
- **Authentication**: Bearer Token required.
- **Success Response**:
  ```json
  {
    "success": true,
    "user": {
      "username": "admin",
      "isAdmin": true,
      "permissions": { ... }
    }
  }
  ```

---

### Change Password

Allows the authenticated user to change their password.

- **Endpoint**: `/api/auth/change-password`
- **Method**: `POST`
- **Authentication**: Bearer Token required.
- **Body**:
  - `currentPassword` (string, required): The user's current password.
  - `newPassword` (string, required): The desired new password (must be at least 6 characters).
- **Request Example**:
  ```json
  {
    "currentPassword": "oldpassword",
    "newPassword": "newpassword123"
  }
  ```
- **Success Response**:
  ```json
  {
    "success": true,
    "message": "Password updated successfully"
  }
  ```

---

### Social Login (Better Auth)

MCPHub integrates [Better Auth](https://www.better-auth.com/) to provide seamless social login capabilities (GitHub, Google, etc.).

**Prerequisites**:
1.  **Database Mode**: `DB_URL` environment variable must be configured (PostgreSQL is required for Better Auth persistence).
2.  **Provider Configuration**: Better Auth bootstrap settings are read once at startup, so restart MCPHub after changing them.
3.  **Environment Variables**:
  *   **Global**: `BETTER_AUTH_ENABLED`, `BETTER_AUTH_URL`, optional `BETTER_AUTH_BASE_PATH`, optional `BETTER_AUTH_TRUSTED_ORIGINS`.
  *   **GitHub**: `BETTER_AUTH_GITHUB_ENABLED`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`.
  *   **Google**: `BETTER_AUTH_GOOGLE_ENABLED`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`.
  *   **Local OIDC**: `BETTER_AUTH_OIDC_ENABLED`, optional `BETTER_AUTH_OIDC_PROVIDER_ID`, `BETTER_AUTH_OIDC_DISCOVERY_URL` (or legacy `OIDC_DISCOVERY_URL`), optional `BETTER_AUTH_OIDC_SCOPES`, optional `BETTER_AUTH_OIDC_PKCE`, optional `BETTER_AUTH_OIDC_PROMPT`, plus `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.

Non-secret Better Auth settings can also be stored in `systemConfig.auth.betterAuth`, but the `BETTER_AUTH_*` environment variables take precedence over stored config values.

**Endpoints**:
The Better Auth handler is mounted at `${BASE_PATH}${betterAuthConfig.basePath}`. The default `betterAuthConfig.basePath` is `/api/auth/better`; set `BETTER_AUTH_BASE_PATH` to override it at startup, or use `systemConfig.auth.betterAuth.basePath` as a fallback. `BETTER_AUTH_URL` takes precedence over `systemConfig.install.baseUrl` when MCPHub builds redirect URLs. If you also set `BASE_PATH`, prepend it to every example below. Key endpoints include:

- **Initiate Login**:
  - `GET /api/auth/better/signIn/social?provider=github`
  - `GET /api/auth/better/signIn/social?provider=google`

- **Session Management**:
  - `GET /api/auth/better/session` (Get current session)
  - `POST /api/auth/better/signOut` (Sign out)

For a complete list of endpoints and usage details, refer to the [Better Auth API Documentation](https://www.better-auth.com/docs).

**Disabling Better Auth**:

Better Auth is automatically disabled if `DB_URL` is not configured, if `BETTER_AUTH_ENABLED=false`, or if no login providers are effectively enabled with their required credentials.

### openapi

### OpenAPI Generation for OpenWebUI Integration

MCPHub now supports generating OpenAPI 3.0.3 specifications from MCP tools, enabling seamless integration with OpenWebUI and other OpenAPI-compatible systems without requiring MCPO as an intermediary proxy.

### Features

- ✅ **Automatic OpenAPI Generation**: Converts MCP tools to OpenAPI 3.0.3 specification
- ✅ **OpenWebUI Compatible**: Direct integration without MCPO proxy
- ✅ **Real-time Tool Discovery**: Dynamically includes tools from connected MCP servers
- ✅ **Dual Parameter Support**: Supports both GET (query params) and POST (JSON body) for tool execution
- ✅ **No Authentication Required**: OpenAPI endpoints are public for easy integration
- ✅ **Comprehensive Metadata**: Full OpenAPI specification with proper schemas and documentation

### API Endpoints

### OpenAPI Specification



```bash GET /api/openapi.json
curl "http://localhost:3000/api/openapi.json"
```

```bash GET /api/openapi.yaml
curl "http://localhost:3000/api/openapi.yaml"
```

```bash With Parameters
curl "http://localhost:3000/api/openapi.json?title=My MCP API&version=2.0.0"
```



Generates and returns the complete OpenAPI 3.0.3 specification for all connected MCP tools. The `.json` and `.yaml` variants accept the same query parameters.

**Query Parameters:**


  Custom API title



  Custom API description



  Custom API version



  Custom server URL



  Include disabled tools



  Comma-separated list of server names to include


### Group/Server-Specific OpenAPI Specification



```bash GET /api/:name/openapi.json
curl "http://localhost:3000/api/mygroup/openapi.json"
```

```bash GET /api/:name/openapi.yaml
curl "http://localhost:3000/api/mygroup/openapi.yaml"
```

```bash With Parameters
curl "http://localhost:3000/api/myserver/openapi.json?title=My Server API&version=1.0.0"
```



Generates and returns the OpenAPI 3.0.3 specification for a specific group or server in JSON or YAML format. If a group with the given name exists, it returns the specification for all servers in that group. Otherwise, it treats the name as a server name and returns the specification for that server only.

**Path Parameters:**


  Group ID/name or server name


**Query Parameters:**

Same as the main OpenAPI specification endpoint (title, description, version, serverUrl, includeDisabled).

### Available Servers



```bash GET /api/openapi/servers
curl "http://localhost:3000/api/openapi/servers"
```



Returns a list of connected MCP server names.

<ResponseExample>

```json Example Response
{
  "success": true,
  "data": ["amap", "playwright", "slack"]
}
```

</ResponseExample>

### Tool Statistics



```bash GET /api/openapi/stats
curl "http://localhost:3000/api/openapi/stats"
```



Returns statistics about available tools and servers.

<ResponseExample>

```json Example Response
{
  "success": true,
  "data": {
    "totalServers": 3,
    "totalTools": 41,
    "serverBreakdown": [
      {"name": "amap", "toolCount": 12, "status": "connected"},
      {"name": "playwright", "toolCount": 21, "status": "connected"},
      {"name": "slack", "toolCount": 8, "status": "connected"}
    ]
  }
}
```

</ResponseExample>

### Tool Execution



```bash GET /api/tools/{serverName}/{toolName}
curl "http://localhost:3000/api/tools/amap/amap-maps_weather?city=Beijing"
```

```bash POST /api/tools/{serverName}/{toolName}
curl -X POST "http://localhost:3000/api/tools/playwright/playwright-browser_navigate" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```



Execute MCP tools via OpenAPI-compatible endpoints.

Decimal numeric strings are converted in full, including scientific notation (for example, an integer parameter of `1e3` becomes `1000`). Fractional values for integer parameters, non-finite values, and invalid strings are left unchanged for the tool's schema validation; they are not truncated into a different number. Already numeric values are forwarded unchanged.

String array items submitted by the dashboard are converted according to the tool's `items.type` (`integer`, `number`, or `boolean`) before being forwarded to the MCP server.

**Path Parameters:**


  The name of the MCP server



  The name of the tool to execute


### OpenWebUI Integration

To integrate MCPHub with OpenWebUI:


  
    Ensure MCPHub is running with your MCP servers configured
  
  
    ```bash
    curl http://localhost:3000/api/openapi.json > mcphub-api.json
    curl http://localhost:3000/api/openapi.yaml > mcphub-api.yaml
    ```
  
  
    Import the OpenAPI specification file or point to the URL directly in OpenWebUI
  


### Configuration Example

In OpenWebUI, you can add MCPHub as an OpenAPI tool by using:

<CardGroup cols={2}>
  
  
</CardGroup>

### Generated OpenAPI Structure

The generated OpenAPI specification includes:

### Tool Conversion Logic

- **Simple tools** (≤10 primitive parameters) → GET endpoints with query parameters
- **Complex tools** (objects, arrays, or >10 parameters) → POST endpoints with JSON request body
- **All tools** include comprehensive response schemas and error handling

### Example Generated Operation

```yaml
/tools/amap/amap-maps_weather:
  get:
    summary: "根据城市名称或者标准adcode查询指定城市的天气"
    operationId: "amap_amap-maps_weather"
    tags: ["amap"]
    parameters:
      - name: city
        in: query
        required: true
        description: "城市名称或者adcode"
        schema:
          type: string
    responses:
      '200':
        description: "Successful tool execution"
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ToolResponse'
```

### Security

- The OpenAPI specification and tool execution endpoints are mounted **outside** the authenticated router (see `app.use(${BASE_PATH}/api, router)` versus the `app.get(${BASE_PATH}/api/openapi*)` and `app.get(${BASE_PATH}/api/tools/...)` registrations in `src/routes/index.ts`). They do not require a JWT, bearer key, OAuth token, or Better Auth session.
- For private deployments, gate these endpoints at your reverse proxy or only expose MCPHub on a trusted network.

### Benefits over MCPO

<CardGroup cols={2}>
  
  
  
  
</CardGroup>

### Troubleshooting


  
    Ensure MCP servers are connected. Check `/api/openapi/stats` for server status.
  

  
    Verify the tool name and parameters match the OpenAPI specification. Check server logs for details.
  

  
    Ensure MCPHub is accessible from OpenWebUI and the OpenAPI URL is correct.
  

  
    Check if tools are enabled in your MCP server configuration. Use `includeDisabled=true` to see all tools.
  


### mcp-http

MCPHub provides a unified streamable HTTP interface for all your MCP servers. This allows you to send requests to any configured MCP server and receive responses in real-time.

**Security note**: MCP endpoints require authentication by default to avoid exposing connected tools and data. If you intentionally want public MCP access, disable **Enable Bearer Authentication** in the Keys settings. **Skip Authentication** only affects dashboard login. By default MCPHub reads Bearer credentials from the `Authorization` header, but this is configurable via **Bearer Auth Header Name** if upstream passthrough headers would otherwise conflict.

### Unified Endpoint

This endpoint provides access to all enabled MCP servers.

- **Endpoint**: `http://localhost:3000/mcp`
- **Method**: `POST`

### Group-Specific Endpoint

For targeted access to specific server groups, use the group-based HTTP endpoint.

- **Endpoint**: `http://localhost:3000/mcp/{group}`
- **Method**: `POST`
- **Parameters**:
  - `{group}`: The ID or name of the group.

### Server-Specific Endpoint

For direct access to individual servers, use the server-specific HTTP endpoint.

- **Endpoint**: `http://localhost:3000/mcp/{server}`
- **Method**: `POST`
- **Parameters**:
  - `{server}`: The name of the server.

> **Note**: If a server name and group name are the same, the group will take precedence.

### Protocol compatibility

The same `/mcp` URL serves legacy `2025-11-25` and modern `2026-07-28`
clients. Group and server URLs use the same protocol handling. Changing the URL
from `/sse` to `/mcp` does not by itself upgrade the client's protocol revision.

| Behavior                  | Legacy HTTP+SSE (`/sse`)                    | HTTP `2025-11-25` (`/mcp`)        | HTTP `2026-07-28` (`/mcp`)                                             |
| ------------------------- | ------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| Status                    | Deprecated; still supported                 | Supported for compatibility       | Supported; migration work continues                                    |
| Startup                   | `initialize` over the SSE transport         | `initialize` over Streamable HTTP | No `initialize` handshake; SDK discovery                               |
| Downstream session        | SSE connection and session message endpoint | `Mcp-Session-Id`                  | No downstream transport session                                        |
| Routing headers           | Legacy transport behavior                   | Legacy transport behavior         | `Mcp-Method`; `Mcp-Name` for named calls and resource reads            |
| Stateful tools            | Existing session lifecycle                  | Existing session lifecycle        | Bearer auth plus explicit state ID or OpenAI conversation metadata     |
| MCP Apps capabilities     | Declared during initialization              | Declared during initialization    | Declared in each request's `params._meta`                              |
| List cache hints          | Existing legacy response shape              | Existing legacy response shape    | Remaining upstream TTL, capped at 5 seconds; `private`; otherwise zero |
| Resource-read cache hints | Existing upstream hints preserved           | Existing upstream hints preserved | Valid remaining upstream TTL, restricted to `private`; otherwise zero  |

MCP Apps passthrough also depends on the route and visible upstream servers;
`$smart` routes remain ordinary MCP routes. See [MCP Apps](/features/mcp-apps).
Upstream Streamable HTTP connections default to automatic protocol negotiation:
MCPHub probes `server/discover`, uses `2026-07-28` stateless HTTP when supported,
and falls back to the legacy handshake according to the SDK's negotiation rules.
The downstream protocol is independent of the upstream protocol. Set the
per-server `protocolNegotiation: "legacy"` option to skip probing for a legacy
server. Stdio and legacy SSE upstreams continue using legacy negotiation.

| Upstream behavior                       | Modern Streamable HTTP                                                                    | Legacy upstream                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Startup                                 | `server/discover`; no transport session or GET stream                                     | `initialize`; existing transport lifecycle         |
| Lists                                   | On-demand revalidation at the original upstream TTL expiry; concurrent refreshes coalesce | Existing list-changed notifications                |
| Missing/zero TTL or partial list        | Revalidate on the next relevant request                                                   | Existing discovery behavior                        |
| Health checks (opt-in)                  | Network `server/discover`, including servers without tools                                | `ping`, with existing method-availability fallback |
| Elicitation-enabled isolated connection | Uses legacy negotiation while the relay requires legacy requests                          | Existing forwarding support                        |

List revalidation also runs before tool calls, prompt retrieval and resource
reads so newly added or removed entries affect routing. Resource templates are
fetched on demand. A failed refresh excludes only that upstream from the current
request; healthy upstreams and built-in content remain available. Partial lists
advertise zero TTL, and later requests retry the failed upstream. No background list polling is
introduced, and a list does not update until a relevant request occurs. Changed
shared lists notify connected legacy downstream clients after refresh; personal
lists remain scoped to their own runtime. Upstream list discovery remains
single-page; a response with `nextCursor` receives no positive freshness hint.

When `passthroughHeaders` are configured, modern discovery uses a disposable,
request-local client and snapshots. Lists and pending refreshes are never shared
between forwarded identities, even with positive TTLs or absent headers. This
adds a discovery round trip per relevant request; those snapshots do not update
global descriptors, embeddings or list-change broadcasts.

Automatic negotiation does not treat every connection failure as evidence of a
legacy server. HTTP probe timeouts, network outages and authentication errors
can fail the connection rather than trigger fallback. See the
[upstream configuration guide](/configuration/mcp-settings#upstream-protocol-negotiation).

### Elicitation forwarding

For legacy clients, MCPHub forwards form and URL `elicitation/create` requests
during tool calls when the upstream server has `perSessionClient: true`.
The isolated connection advertises only the modes declared by its downstream
client; the legacy empty `elicitation: {}` capability means form support only.
Accept, decline and cancel responses are returned to the upstream unchanged.
URL completion notifications are sent only to the owning downstream session.
This works for direct calls and Smart Routing's `call_tool`.

Calls on an elicitation-enabled upstream connection run sequentially within
each downstream session because legacy requests do not provide a portable
parent-call identifier. Other sessions use separate connections. Cancelling a
call, ending the session, or a timeout aborts the pending interaction. A thrown
request error discards the upstream connection without automatically replaying
the call, so the next call creates a fresh connection and any upstream session
state must be rebuilt. A completed tool response with `isError` is still returned
normally.

Shared upstream connections, personal-credential/OAuth runtimes, prompt/resource
operations, and modern `2026-07-28` multi-round-trip elicitation are not supported
in this initial implementation. These paths do not advertise elicitation.
Enabling `X-MCPHub-State-Id` does not enable elicitation for modern clients.

Form elicitation is for ordinary structured input. Passwords, API keys and
access tokens must use URL mode, with sensitive input collected on the upstream
service's page rather than in an MCP form. MCPHub does not add a dashboard input
dialog; the connected MCP client provides the interaction UI.

### Migrating a client

1. Replace the legacy SSE client transport with an HTTP transport, and change
   `/sse` to `/mcp`, preserving any group, server or user route scope. Keep the
   same bearer credentials. A legacy HTTP client can make this transport change
   while retaining its initialization and session lifecycle.
2. To adopt `2026-07-28`, use a client that supports modern HTTP discovery and
   the per-request metadata envelope. The SDK v2 HTTP client supplies the
   protocol and routing headers. A custom client must send the normal JSON-RPC
   body with `params._meta["io.modelcontextprotocol/protocolVersion"]` set to
   `2026-07-28` and declare client capabilities under
   `params._meta["io.modelcontextprotocol/clientCapabilities"]`. Send matching
   `MCP-Protocol-Version` and `Mcp-Method` headers; `tools/call` and `prompts/get`
   require `Mcp-Name` matching `params.name`, and `resources/read` requires it
   matching `params.uri`. Use names returned by that route's list response.
3. For `perSessionClient` or OpenAPI `cookieSession` tools, create a UUID v4 for
   each independent workflow and send it as `X-MCPHub-State-Id` on tool calls.
   Authenticated OpenAI/ChatGPT tool calls that cannot set this extension may
   instead reuse their client-declared `_meta["openai/session"]` conversation
   hint when the explicit header is absent. MCPHub hashes that hint before use;
   it is correlation metadata, not authentication. An invalid explicit state
   header fails closed and never falls back. Stateless tools need neither value.
   Reuse is limited to the same bearer credential, user and route. State is
   process-local, expires after 30 idle minutes, and requires sticky routing
   across replicas. Restart, expiry or credential/route changes require
   rebuilding application state. See
   [explicit-state configuration](/configuration/mcp-settings#stateful-tools-over-mcp-2026-07-28).
4. Verify listing and calling tools with your actual permissions, then verify
   resource reads and MCP Apps if used. Modern Apps hosts must declare their UI
   capability on each request. Modern calls do not depend on `Mcp-Session-Id`
   or `enableSessionRebuild`; those remain legacy mechanisms.

### Cache behavior

Modern list results combine upstream discovery snapshots with live configuration,
permissions and per-request capabilities. Positive hints are private and bounded
by the shortest remaining upstream freshness and a maximum five-second projection
window. Discovery age is retained; repeated gateway lists do not renew it. Empty
upstream lists also participate in the bound. Unknown/invalid TTLs, partial pages,
failed or incomplete discovery, gateway-generated Smart Routing entries, built-in
prompts/resources and unknown hosted permission freshness use zero.

Every request rebuilds its projection. Configuration, membership, permission or
runtime changes detected during projection force zero. List refreshes revoke the
previous snapshot's freshness before awaiting a new envelope; failure, disconnect
or replacement cannot establish new freshness. Template lists use the actual
responses fetched for that request. No gateway response cache is added.

Clients may retain an already-issued list for at most five seconds after a local
configuration/permission change; server invalidation cannot retract client caches.
Keep caches separate by endpoint, authenticated identity and per-request
capabilities. A cached list never authorizes a call: MCPHub rechecks access on each
request. Use zero when an upstream supplies no trustworthy freshness.

Modern resource reads continue to bypass the SDK response cache, subtract handling
time from a valid upstream TTL and restrict sharing to the requesting authorization
context. Missing or invalid TTLs, built-in resources and gateway-generated read
errors use zero. Legacy response shapes and session behavior are unchanged.

### Legacy SSE deprecation plan

The public notice will accompany the next release that includes this plan.
The release notes must record the actual notice date **N** and the earliest
eligible removal date **N + 12 calendar months**. This page and the ADR do not
establish an earlier notice date. Until those release notes are published, the
notice date and removal date remain unannounced.

The intended removal release is the first major release on or after that date
that meets the readiness criteria below. If readiness is incomplete, postpone
removal and publish the revised target; do not shorten the notice window.
Publish the exact target release and date at least 90 days before removal,
remind users 30 days before removal, and include the migration instructions in
each announcement. Actual removal requires a separate reviewed change.

### Preserve route scope and authentication

Prefix every URL below with the deployment's configured base path, if any.
Group IDs remain preferable to names; retain the same route identifier and
bearer header name/value. Group names take precedence over server names.

| Existing SSE connection | Streamable HTTP replacement | SSE message endpoint being retired |
| ----------------------- | --------------------------- | ---------------------------------- |
| `/sse`                  | `/mcp`                      | `/messages`                        |
| `/sse/{group}`          | `/mcp/{group}`              | `/messages`                        |
| `/sse/{server}`         | `/mcp/{server}`             | `/messages`                        |
| `/{user}/sse`           | `/{user}/mcp`               | `/{user}/messages`                 |
| `/{user}/sse/{group}`   | `/{user}/mcp/{group}`       | `/{user}/messages`                 |
| `/{user}/sse/{server}`  | `/{user}/mcp/{server}`      | `/{user}/messages`                 |

Smart Routing suffixes such as `$smart/{group}` are preserved as well. The SSE
client follows its advertised message URL and session query; do not translate
that message URL into a new HTTP endpoint. Replace the connection URL and let
the HTTP transport manage its requests.

First migrate the transport independently of the protocol revision. For example,
with the legacy TypeScript SDK (`@modelcontextprotocol/sdk` 1.29.0, the version
used by MCPHub's independent compatibility tests):

```typescript
const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://hub.example.com/alice/mcp/my-group-id'), {
    requestInit: { headers: { Authorization: 'Bearer YOUR_EXISTING_KEY' } },
  }),
);
const tools = await client.listTools();
// Use the returned tool names; retain this client for the workflow.
await client.close();
```

This keeps the legacy initialization and `Mcp-Session-Id` lifecycle. Existing
stateful tools keep session isolation; no `X-MCPHub-State-Id` is required for
this transport-only migration. Modern discovery and explicit state are a
separate upgrade described above. Existing SSE session IDs cannot be carried
across transports: start a new HTTP workflow and repeat any login/tool setup.

### Readiness and removal boundaries

Before announcing the exact removal target, maintainers must record:

- The release containing the public notice and its actual date, plus proof that
  at least 12 calendar months will have elapsed at removal.
- Passing legacy SSE and Streamable HTTP compatibility suites throughout the
  window, including authenticated global, group, server and user routes,
  session continuation/rebuild and stateful-tool isolation.
- A migration checklist for each documented client integration: HTTP transport,
  preserved route/authentication, successful listing/calling, and resources,
  Apps or stateful workflows where used. Record tested client versions and
  unresolved blockers; there must be zero unresolved release-blocking migration
  defects. Operator confirmations may supplement this checklist; absence of
  telemetry is not evidence that nobody uses SSE.
- Published release notes and documentation in both languages, the 90-day and
  30-day reminders, and a support path for deployments that still use SSE.

The removal inventory is limited to the SSE GET routes, their POST message
routes, `handleSseConnection`, `handleSseMessage`, SSE transport construction,
and SSE-only tests/imports. Audit every caller before removing shared helpers.
Retain `/mcp` POST/GET/DELETE routes, legacy HTTP initialization, session maps
and cleanup, session creation/rebuild locks, bearer/group authorization,
`perSessionClient` isolation, OpenAPI cookie jars and modern explicit state.
The `server-legacy` package also supplies shared legacy HTTP/OAuth functionality;
SSE retirement alone is not grounds to remove the dependency.

The plan is tracked in [#1272](https://github.com/samanhappy/mcphub/issues/1272).
The notice release must open a separate removal task carrying the actual dates,
client checklist and inventory. Legacy `2025-11-25` Streamable HTTP remains
supported independently.

### mcp-sse

The legacy HTTP+SSE endpoint is deprecated but remains supported during migration. Use the [MCP HTTP endpoints and migration guide](/api-reference/mcp-http) for new integrations. No removal release or date has been announced.

The staged-upgrade ADR calls for a deprecation window of at least 12 months. Removal requires a published schedule and a verified migration path. This does not deprecate the session lifecycle of legacy `2025-11-25` HTTP clients: both legacy and modern HTTP remain supported.

**Security note**: MCP endpoints require authentication by default to avoid exposing connected tools and data. If you intentionally want public MCP access, disable **Enable Bearer Authentication** in the Keys settings. **Skip Authentication** only affects dashboard login. By default MCPHub reads Bearer credentials from the `Authorization` header, but this is configurable via **Bearer Auth Header Name** if upstream passthrough headers would otherwise conflict.

### Unified Endpoint

- **Endpoint**: `http://localhost:3000/sse`
- **Method**: `GET`

### Group-Specific Endpoint

- **Endpoint**: `http://localhost:3000/sse/{group}`
- **Method**: `GET`
- **Parameters**:
  - `{group}`: The ID or name of the group.

### Server-Specific Endpoint

- **Endpoint**: `http://localhost:3000/sse/{server}`
- **Method**: `GET`
- **Parameters**:
  - `{server}`: The name of the server.

### smart-routing

Smart Routing is MCPHub's intelligent tool discovery system that uses vector semantic search to automatically find the most relevant tools for any given task.

### HTTP Endpoint

- **Endpoint**: `http://localhost:3000/mcp/$smart`
- **Method**: `POST`

### SSE Endpoint (Deprecated)

- **Endpoint**: `http://localhost:3000/sse/$smart`
- **Method**: `GET`

### How it Works

1.  **Tool Indexing**: All MCP tools are automatically converted to vector embeddings and stored in PostgreSQL with pgvector.
2.  **Semantic Search**: User queries are converted to vectors and matched against tool embeddings using cosine similarity.
3.  **Intelligent Filtering**: Dynamic thresholds ensure relevant results without noise.
4.  **Precise Execution**: Found tools can be directly executed with proper parameter validation.

### Setup Requirements

- PostgreSQL with pgvector extension
- LLM Provider (OpenAI or compatible) API key
- Enable Smart Routing in MCPHub settings

### Diagnostics & Maintenance API

The following admin endpoints live under the authenticated Dashboard API and
require a valid Dashboard session (JWT) or a system-level all-access bearer key
(`Authorization: Bearer mcphub_...`), like any other `/api/*` route. Both are
additionally **admin-only**: an authenticated non-admin identity receives
`403 Admin privileges required`.

### Index Status & Performance

Returns Smart Routing configuration, database connection state, vector store
size (tool/server row counts, distinct servers, dimensions), per-model and
per-server statistics, sync freshness, and index coverage.

```bash
curl http://localhost:3000/api/smart-routing/performance \
  -H "Authorization: Bearer YOUR_JWT_OR_BEARER_KEY"
```

### Reindex

Force a full rebuild of the vector index: `vector_embeddings` is cleared first,
then embeddings are regenerated for every enabled server. Runs synchronously
and returns a summary; per-server progress is streamed over SSE
`embedding-sync-progress` events.

Servers that declare a personal credential template are never connected
globally, so they are reached on behalf of the users who bound credentials (the
server owner first) and the union of the tools those users can see is indexed.
A server nobody bound credentials for is reported as skipped with a reason in
the response `results`.

Only one pass runs at a time: a call made while another pass is in flight is
rejected with `409 A reindex pass is already running`. The
`GET /api/smart-routing/performance` payload exposes the same state as
`reindexing`, so a dashboard can disable its button while a pass is running.

```bash
curl -X POST http://localhost:3000/api/smart-routing/reindex \
  -H "Authorization: Bearer YOUR_JWT_OR_BEARER_KEY"
```

## Shared TypeScript data contracts

Optional fields use ?. Type declarations do not replace controller authorization/validation.

### CapabilitySnapshot

```typescript
export interface CapabilitySnapshot {
  serverName: string;
  principal: string;
  fingerprint: string;
  capturedAt: string;
  tools: import('@modelcontextprotocol/client').Tool[];
}
```

### CapabilityCacheStatus

```typescript
export interface CapabilityCacheStatus {
  state: 'fresh' | 'stale' | 'missing';
  capturedAt?: string;
}

// User interface
```

### IUser

```typescript
export interface IUser {
  userGroups?: string[];
  username: string;
  password: string;
  isAdmin?: boolean;
  email?: string | null;
  ssoUserId?: string | null;
}

// Group interface for server grouping
```

### IGroup

```typescript
export interface IGroup {
  visibility?: 'private' | 'group' | 'public';
  sharedWithUserGroups?: string[];
  sharedWithUsers?: string[];
  id: string; // Unique UUID for the group
  name: string; // Display name of the group
  description?: string; // Optional description of the group
  instructions?: string; // Sent as the MCP initialize instructions on this group's routes
  servers: string[] | IGroupServerConfig[]; // Array of server names or server configurations that belong to this group
  owner?: string; // Owner of the group, defaults to 'admin' user
}

// Server configuration within a group - supports tool selection
```

### IGroupServerConfig

```typescript
export interface IGroupServerConfig {
  name: string; // Server name
  alias?: string; // Optional exposed name for this server within the group
  preserveToolNames?: boolean; // Expose upstream tool names without a server prefix
  tools?: string[] | 'all'; // Array of specific tool names to include, or 'all' for all tools (default: 'all')
  prompts?: string[] | 'all'; // Array of specific prompt names to include, or 'all' for all prompts (default: 'all')
  resources?: string[] | 'all'; // Array of specific resource URIs to include, or 'all' for all resources (default: 'all')
  pinnedTools?: string[]; // Tool names listed next to the meta-tools on $smart/<group> (must also be selected in tools)
}

// Market server types
```

### MarketServerRepository

```typescript
export interface MarketServerRepository {
  type: string;
  url: string;
}
```

### MarketServerAuthor

```typescript
export interface MarketServerAuthor {
  name: string;
}
```

### MarketServerInstallation

```typescript
export interface MarketServerInstallation {
  type: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}
```

### MarketServerArgument

```typescript
export interface MarketServerArgument {
  description: string;
  required: boolean;
  example: string;
}
```

### MarketServerExample

```typescript
export interface MarketServerExample {
  title: string;
  description: string;
  prompt: string;
}
```

### MarketServerTool

```typescript
export interface MarketServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}
```

### MarketServer

```typescript
export interface MarketServer {
  name: string;
  display_name: string;
  description: string;
  repository: MarketServerRepository;
  homepage: string;
  author: MarketServerAuthor;
  license: string;
  categories: string[];
  tags: string[];
  examples: MarketServerExample[];
  installations: {
    [key: string]: MarketServerInstallation;
  };
  arguments: Record<string, MarketServerArgument>;
  tools: MarketServerTool[];
  is_official?: boolean;
}
```

### ChangelogCategory

```typescript
export type ChangelogCategory = 'feature' | 'fix' | 'breaking' | 'security';
```

### ChangelogEntry

```typescript
export interface ChangelogEntry {
  product: 'mcphub';
  version: string;
  tagName: string;
  publishedAt: string;
  url: string;
  changelogUrl: string;
  title: string;
  summary: string;
  highlights: string[];
  fixes: string[];
  breakingChanges: string[];
  upgradeNotes: string[];
  categories: ChangelogCategory[];
  locale: 'en' | 'zh';
  bodyMarkdown: string;
  isStructured: boolean;
}
```

### ChangelogUpdateInfo

```typescript
export interface ChangelogUpdateInfo {
  latestVersion: string | null;
  hasUpdate: boolean;
  entries: ChangelogEntry[];
  totalUpdateCount: number;
  changelogUrl: string;
  allChangelogUrl: string;
  source: 'mcphub-web' | 'npm-fallback' | 'disabled';
}

// Cloud Market Server types (for MCPRouter API)
```

### CloudServer

```typescript
export interface CloudServer {
  created_at: string;
  updated_at: string;
  name: string;
  author_name: string;
  title: string;
  description: string;
  content: string;
  server_key: string;
  config_name: string;
  tools?: CloudTool[];
}
```

### CloudTool

```typescript
export interface CloudTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

// MCPRouter API Response types
```

### MCPRouterResponse

```typescript
export interface MCPRouterResponse<T = any> {
  code: number;
  message: string;
  data: T;
}
```

### MCPRouterListServersResponse

```typescript
export interface MCPRouterListServersResponse {
  servers: CloudServer[];
}
```

### MCPRouterListToolsResponse

```typescript
export interface MCPRouterListToolsResponse {
  tools: CloudTool[];
}
```

### MCPRouterCallToolResponse

```typescript
export interface MCPRouterCallToolResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError: boolean;
}

// OAuth Provider Configuration for MCP Authorization Server
```

### OAuthProviderConfig

```typescript
export interface OAuthProviderConfig {
  enabled?: boolean; // Enable/disable OAuth provider
  issuerUrl: string; // Authorization server's issuer identifier (e.g., 'http://auth.external.com')
  baseUrl?: string; // Base URL for the authorization server metadata endpoints (defaults to issuerUrl)
  serviceDocumentationUrl?: string; // URL for human-readable OAuth documentation
  scopesSupported?: string[]; // List of OAuth scopes supported
  endpoints: {
    authorizationUrl: string; // External OAuth authorization endpoint
    tokenUrl: string; // External OAuth token endpoint
    revocationUrl?: string; // External OAuth revocation endpoint (optional)
  };
  // Token verification function details
  verifyAccessToken?: {
    endpoint?: string; // Optional: External endpoint to verify access tokens
    headers?: Record<string, string>; // Optional: Headers for token verification requests
  };
  // Client management
  clients?: Array<{
    client_id: string; // Client identifier
    redirect_uris: string[]; // Allowed redirect URIs for this client
    scopes?: string[]; // Scopes this client can request
  }>;
}
```

### BetterAuthProviderToggle

```typescript
export interface BetterAuthProviderToggle {
  enabled?: boolean; // Enable/disable the provider
}
```

### BetterAuthOidcProviderConfig

```typescript
export interface BetterAuthOidcProviderConfig extends BetterAuthProviderToggle {
  providerId?: string; // Provider identifier used by Better Auth generic OAuth plugin
  discoveryUrl?: string; // OIDC discovery URL for a local issuer
  scopes?: string[]; // Requested scopes for login
  pkce?: boolean; // Enable/disable PKCE for the provider
  prompt?:
    | 'none'
    | 'login'
    | 'create'
    | 'consent'
    | 'select_account'
    | 'select_account consent'
    | 'login consent';
}
```

### BetterAuthConfig

```typescript
export interface BetterAuthConfig {
  enabled?: boolean; // Enable/disable Better Auth integration
  baseUrl?: string; // Public base URL used to build Better Auth redirect URIs
  basePath?: string; // Base path to mount Better Auth handler
  trustedOrigins?: string[]; // Explicitly trusted origins for social/OIDC login requests
  disableAutoCreate?: boolean; // When true, SSO login will not auto-create new users
  disablePasswordLogin?: boolean; // When true and an SSO provider is enabled, username/password login is refused
  providers?: {
    google?: BetterAuthProviderToggle;
    github?: BetterAuthProviderToggle;
    oidc?: BetterAuthOidcProviderConfig;
  };
}
```

### ForwardAuthMode

```typescript
export type ForwardAuthMode = 'jwks';
```

### ForwardAuthJwksConfig

```typescript
export interface ForwardAuthJwksConfig {
  uri?: string; // JWKS endpoint of the upstream identity provider (https required)
  issuer?: string; // Expected `iss` claim; tokens with this issuer are verified and never fall back
  audience?: string | string[]; // Accepted `aud` claim value(s)
  algorithms?: string[]; // Allowed asymmetric algorithms (default: RS256, ES256)
  tokenHeader?: string; // Header carrying the JWT, raw or as `Bearer <jwt>` (default: the bearer auth header)
}
```

### ForwardAuthConfig

```typescript
export interface ForwardAuthConfig {
  enabled?: boolean; // Enable/disable trusting identity from an upstream gateway (default: false)
  mode?: ForwardAuthMode; // Verification mode; only 'jwks' is supported
  jwks?: ForwardAuthJwksConfig;
  usernameClaim?: string; // Claim used for the local username of new users (default: preferred_username)
  emailClaim?: string; // Claim used for the email of new users (default: email)
  autoCreate?: boolean; // Create a local non-admin user on first sight of an identity (default: true)
}
```

### ToolResultCompressionStrategy

```typescript
export type ToolResultCompressionStrategy = 'auto' | 'json' | 'log' | 'search' | 'diff' | 'text';
```

### ToolResultCompressionConfig

```typescript
export interface ToolResultCompressionConfig {
  enabled?: boolean;
  minTokens?: number;
  maxOutputTokens?: number;
  strategy?: ToolResultCompressionStrategy;
}
```

### ToolPolicyAudit

```typescript
export interface ToolPolicyAudit extends PolicyDecision {
  serverId?: string;
  groupId?: string;
}
```

### SystemConfig

```typescript
export interface SystemConfig {
  dashboardName?: string;
  toolPolicies?: ToolPolicyRule[];
  network?: {
    allowedCidrs?: string[]; // Admin-managed ranges reachable by non-admin-owned upstreams.
    fakeIpExceptions?: FakeIpException[];
  };
  routing?: {
    enableGlobalRoute?: boolean; // Controls whether the /sse endpoint without group is enabled
    enableGroupNameRoute?: boolean; // Controls whether group routing by name is allowed
    enableBearerAuth?: boolean; // Controls whether MCP endpoints require bearer authentication
    bearerAuthKey?: string; // Legacy bearer auth key (used for one-time migration)
    bearerAuthHeaderName?: string; // Header name used to receive bearer credentials for MCP/API requests (default: 'Authorization')
    allowAuthorizationPassthrough?: boolean; // Admin opt-in; requires a separate MCPHub auth header.
    jsonBodyLimit?: string; // JSON request body size limit used by Express parser (default: '1mb'), including OpenAPI schema uploads
    skipAuth?: boolean; // Controls whether the dashboard requires login
  };
  install?: {
    pythonIndexUrl?: string; // Python package repository URL (UV_DEFAULT_INDEX)
    npmRegistry?: string; // NPM registry URL (npm_config_registry)
    baseUrl?: string; // Base URL for group card copy operations
  };
  smartRouting?: SmartRoutingConfig;
  toolResultCompression?: ToolResultCompressionConfig;
  mcpRouter?: {
    apiKey?: string; // MCPRouter API key for authentication
    referer?: string; // Referer header for MCPRouter API requests
    title?: string; // Title header for MCPRouter API requests
    baseUrl?: string; // Base URL for MCPRouter API (default: https://api.mcprouter.to/v1)
  };
  nameSeparator?: string; // Separator used between server name and tool/prompt name (default: '-')
  oauth?: OAuthProviderConfig; // OAuth provider configuration for upstream MCP servers
  oauthServer?: OAuthServerConfig; // OAuth authorization server configuration for MCPHub itself
  enableSessionRebuild?: boolean; // Controls whether server session rebuild is enabled
  auth?: {
    allowRegistration?: boolean; // Allow public local account registration (default: false)
    betterAuth?: BetterAuthConfig; // Better Auth integration configuration
    forwardAuth?: ForwardAuthConfig; // Trust identity asserted by an upstream gateway (JWKS-verified JWT)
  };
  discovery?: {
    // Public unauthenticated read-only discovery API for the local market catalog.
    // When enabled, exposes /discovery/servers and /.well-known/mcp-marketplace so
    // external MCP clients (e.g. OpenClaw, Claude Desktop installers) can find and
    // install servers programmatically. Off by default to avoid leaking catalog data.
    enabled?: boolean;
  };
  activityLog?: {
    // Whether to persist the full tool call input/output payload in activity logs.
    // Tool payloads are stored verbatim (no field-level redaction); deployments that
    // treat tool arguments as sensitive can turn this off to store metadata only.
    // Defaults to true.
    storeToolPayload?: boolean;
  };
}
```

### UserConfig

```typescript
export interface UserConfig {
  routing?: Record<string, any>; // User-specific routing configuration
  [key: string]: any; // Allow additional dynamic properties
}

// OAuth Client for MCPHub's own authorization server
```

### IOAuthClient

```typescript
export interface IOAuthClient {
  clientId: string; // OAuth client ID
  clientSecret?: string; // OAuth client secret (optional for public clients with PKCE)
  name: string; // Human-readable client name
  redirectUris: string[]; // Allowed redirect URIs
  grants: string[]; // Allowed grant types (e.g., ['authorization_code', 'refresh_token'])
  scopes?: string[]; // Allowed scopes for this client
  owner?: string; // Owner of the OAuth client, defaults to 'admin' user
  clientIdIssuedAt?: number; // Unix timestamp (seconds) when the client was registered (RFC 7591 client_id_issued_at)
  metadata?: {
    // RFC 7591 Client Metadata
    application_type?: 'web' | 'native'; // Application type
    response_types?: string[]; // OAuth response types
    token_endpoint_auth_method?: string; // Token endpoint authentication method
    contacts?: string[]; // Array of contact emails
    logo_uri?: string; // URL of the client logo
    client_uri?: string; // URL of the client's homepage
    policy_uri?: string; // URL of the client's policy document
    tos_uri?: string; // URL of the client's terms of service
    jwks_uri?: string; // URL of the client's JSON Web Key Set
    jwks?: object; // Client's JSON Web Key Set
  };
}
```

### OAuthClientApproval

```typescript
export interface OAuthClientApproval {
  id: string;
  username: string;
  sessionVersion: string;
  clientId: string;
  clientFingerprint: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  approvedAt: string;
  expiresAt: string;
}

// OAuth Authorization Code (for MCPHub's authorization server)
```

### IOAuthAuthorizationCode

```typescript
export interface IOAuthAuthorizationCode {
  code: string; // Authorization code
  expiresAt: Date; // Expiration time
  redirectUri: string; // Redirect URI used in the authorization request
  scope?: string; // Granted scopes
  clientId: string; // Client ID
  approvalId?: string; // Revocable consent grant associated with this authorization
  sessionVersion?: string; // Credential version at authorization
  username: string; // User who authorized
  codeChallenge?: string; // PKCE code challenge
  codeChallengeMethod?: string; // PKCE code challenge method
}

// OAuth Token (for MCPHub's authorization server)
```

### IOAuthToken

```typescript
export interface IOAuthToken {
  accessToken: string; // Access token
  accessTokenExpiresAt: Date; // Access token expiration
  refreshToken?: string; // Refresh token (optional)
  refreshTokenExpiresAt?: Date; // Refresh token expiration
  scope?: string; // Granted scopes
  clientId: string; // Client ID
  approvalId?: string; // Preserved through refresh-token rotation
  sessionVersion?: string; // Credential version at issuance
  username: string; // Username
}

// OAuth Server Configuration
```

### OAuthServerConfig

```typescript
export interface OAuthServerConfig {
  alwaysShowApprovalScreen?: boolean; // Default true; false enables remembered consent
  approvalLifetime?: number; // Fixed consent lifetime in seconds (default 1209600)
  enabled?: boolean; // Enable/disable OAuth authorization server
  accessTokenLifetime?: number; // Access token lifetime in seconds (default: 3600)
  refreshTokenLifetime?: number; // Refresh token lifetime in seconds (default: 1209600 = 14 days)
  authorizationCodeLifetime?: number; // Authorization code lifetime in seconds (default: 300 = 5 minutes)
  requireClientSecret?: boolean; // Whether client secret is required (default: false for PKCE support)
  allowedScopes?: string[]; // List of allowed OAuth scopes (default: ['read', 'write'])
  requireState?: boolean; // Whether the state parameter is required during authorization (default: false)
  dynamicRegistration?: {
    enabled?: boolean; // Enable/disable RFC 7591 dynamic client registration
    allowedGrantTypes?: string[]; // Allowed grant types for dynamic registration (default: ['authorization_code', 'refresh_token'])
    requiresAuthentication?: boolean; // Whether initial registration requires authentication (default: false for public registration)
    clientTtl?: number; // Idle-client cleanup TTL in seconds. Dynamically-registered clients with no live token and no in-progress authorization flow older than this are reaped (default: 2592000 = 30 days; 0 disables cleanup)
  };
  clientIdMetadata?: {
    // Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document):
    // accept HTTPS-URL-shaped client_ids whose metadata is fetched from the URL itself.
    // Opt-in (default false) because it makes the authorize endpoint fetch attacker-chosen URLs.
    enabled?: boolean;
    cacheTtlMs?: number; // Metadata document cache TTL in milliseconds (default: 3600000)
  };
}

// Bearer authentication key configuration
```

### BearerKeyAccessType

```typescript
export type BearerKeyAccessType = 'all' | 'groups' | 'servers' | 'custom' | 'exclude';
```

### BearerKeyKind

```typescript
export type BearerKeyKind = 'system' | 'user';
```

### BearerKey

```typescript
export interface BearerKey {
  id: string; // Unique identifier for the key
  name: string; // Human readable key name
  token?: string; // Raw token: only present in the creation response (or on legacy, not yet hashed keys)
  tokenHash?: string; // SHA-256 hex of the token; what is stored and compared
  tokenPrefix?: string; // First characters of the token, safe to display
  enabled: boolean; // Whether this key is enabled
  kind?: BearerKeyKind; // Defaults to 'system' for keys created before user-level keys existed
  owner?: string; // Required for user-level keys
  accessType: BearerKeyAccessType; // Access scope type
  allowedGroups?: string[]; // Allowed group names when accessType === 'groups' or 'custom'
  allowedServers?: string[]; // Allowed server names when accessType === 'servers' or 'custom'
  excludedGroups?: string[]; // Excluded group names when accessType === 'exclude' (system keys only)
  excludedServers?: string[]; // Excluded server names when accessType === 'exclude' (system keys only)
}

// Represents the settings for MCP servers
```

### McpSettings

```typescript
export interface McpSettings {
  users?: IUser[]; // Array of user credentials and permissions
  mcpServers: {
    [key: string]: ServerConfig; // Key-value pairs of server names and their configurations
  };
  groups?: IGroup[]; // Array of server groups
  systemConfig?: SystemConfig; // System-wide configuration settings
  userConfigs?: Record<string, UserConfig>; // User-specific configurations
  oauthClients?: IOAuthClient[]; // OAuth clients for MCPHub's authorization server
  oauthTokens?: IOAuthToken[]; // Persisted OAuth tokens (access + refresh) for authorization server
  bearerKeys?: BearerKey[]; // Bearer authentication keys (multi-key configuration)
  prompts?: BuiltinPrompt[]; // Built-in configuration-driven prompt templates
  resources?: BuiltinResource[]; // Built-in configuration-driven static resources
}

// Proxychains4 configuration for STDIO servers (Linux/macOS only)
```

### ProxychainsConfig

```typescript
export interface ProxychainsConfig {
  enabled?: boolean; // Enable/disable proxychains4 proxy routing
  type?: 'socks4' | 'socks5' | 'http'; // Proxy protocol type
  host?: string; // Proxy server hostname or IP address
  port?: number; // Proxy server port
  username?: string; // Proxy authentication username (optional)
  password?: string; // Proxy authentication password (optional)
  configPath?: string; // Path to custom proxychains4 configuration file (optional, overrides above settings)
}

// Visibility level for a server, used by non-admin filtering. See issue #817.
// 'group' is restricted sharing for explicitly selected users. Group membership
// can extend the same scope in a future change.
```

### ServerVisibility

```typescript
export type ServerVisibility = 'private' | 'group' | 'public';
```

### CredentialSlot

```typescript
export interface CredentialSlot {
  target: 'env' | 'headers' | 'args' | 'url';
  allowed?: string[];
  name: string;
  label?: string;
}
```

### StoredCredentialBinding

```typescript
export interface StoredCredentialBinding {
  serverName: string;
  username: string;
  encryptedValues: string;
  updatedAt: string;
}

// Configuration details for an individual server
```

### ServerConfig

```typescript
export interface ServerConfig {
  id?: string; // Stable policy identity; runtime routing remains name-based.
  credentialTemplate?: CredentialSlot[]; // Metadata only; every slot requires a personal binding.
  type?: 'stdio' | 'sse' | 'streamable-http' | 'openapi'; // Type of server
  description?: string; // Optional server note/description for management UI
  url?: string; // URL for SSE or streamable HTTP servers
  command?: string; // Command to execute for stdio-based servers
  args?: string[]; // Arguments for the command
  env?: Record<string, string>; // Environment variables
  headers?: Record<string, string>; // HTTP headers for SSE/streamable-http/openapi servers
  passthroughHeaders?: string[]; // Header names to pass through from MCP requests to upstream SSE/streamable-http servers
  enabled?: boolean; // Flag to enable/disable the server
  owner?: string; // Owner of the server, defaults to 'admin' user
  // Per-server visibility for non-admin users.
  //   'private' — only the owner (or admins) can see this server. Default.
  //   'public'  — every authenticated user can see this server.
  //   'group'   — selected users and user-group members can see this server.
  // See issues #817 and #1037.
  visibility?: ServerVisibility;
  sharedWithUserGroups?: string[];
  sharedWithUsers?: string[]; // Local MCPHub usernames allowed when visibility is 'group'.
  protocolNegotiation?: 'auto' | 'legacy'; // Streamable HTTP defaults to auto; other transports remain legacy.
  enableKeepAlive?: boolean; // Enable remote health checks; disconnected remote servers always retry
  keepAliveInterval?: number; // Health check interval in milliseconds (default: 60000ms for SSE servers)
  tools?: Record<string, { enabled: boolean; description?: string; hiddenParams?: string[] }>; // Tool-specific configurations: enable/disable state, custom description, top-level input parameters hidden from models
  prompts?: Record<string, { enabled: boolean; description?: string }>; // Prompt-specific configurations with enable/disable state and custom descriptions
  resources?: Record<string, { enabled: boolean; description?: string }>; // Resource-specific configurations with enable/disable state and custom descriptions
  options?: Partial<
    Pick<RequestOptions, 'timeout' | 'resetTimeoutOnProgress' | 'maxTotalTimeout'>
  > & {
    maxBufferSize?: number; // Stdio read buffer limit in bytes; omitted uses the SDK default (10 MiB).
    // Internal persistence carriers for startOnDemand/idleTimeoutMs (see below). The
    // database-backed ServerDao has no dedicated columns for those two fields, so
    // serverConfigPersistence.ts piggybacks them onto this schema-less JSON blob
    // and ServerDaoDbImpl unpacks them back to the top-level fields on read.
    // Application code should read/write config.startOnDemand / config.idleTimeoutMs
    // directly rather than these mirrored keys.
    startOnDemand?: boolean;
    idleTimeoutMs?: number;
  }; // MCP request options configuration
  // Proxychains4 proxy configuration for STDIO servers (Linux/macOS only, Windows not supported)
  proxy?: ProxychainsConfig;
  // OAuth authentication for upstream MCP servers
  oauth?: {
    identityMode?: 'shared' | 'personal';
    // Admin-only, default false: permit HTTP token exchange/refresh for this upstream.
    allowInsecureTokenEndpoint?: boolean;
    // Static client configuration (traditional OAuth flow)
    clientId?: string; // OAuth client ID
    clientSecret?: string; // OAuth client secret
    redirectUri?: string; // Preferred redirect URI for authorization requests and registration
    scopes?: string[]; // Required OAuth scopes
    accessToken?: string; // Pre-obtained access token (if available)
    accessTokenExpiresAt?: number; // Absolute access token expiry in milliseconds
    refreshToken?: string; // Refresh token for renewing access

    // Dynamic client registration (RFC7591)
    // If not explicitly configured, will auto-detect via WWW-Authenticate header on 401 responses
    dynamicRegistration?: {
      enabled?: boolean; // Enable/disable dynamic registration (default: auto-detect on 401)
      issuer?: string; // OAuth issuer URL for discovery (e.g., 'https://auth.example.com')
      registrationEndpoint?: string; // Direct registration endpoint URL (if discovery is not used)
      metadata?: {
        // Client metadata for registration (RFC7591 section 2)
        client_name?: string; // Human-readable client name
        client_uri?: string; // URL of client's home page
        logo_uri?: string; // URL of client's logo
        scope?: string; // Space-separated list of scope values
        redirect_uris?: string[]; // Array of redirect URIs
        grant_types?: string[]; // Array of OAuth 2.0 grant types (e.g., ['authorization_code', 'refresh_token'])
        response_types?: string[]; // Array of OAuth 2.0 response types (e.g., ['code'])
        token_endpoint_auth_method?: string; // Token endpoint authentication method (e.g., 'client_secret_basic', 'none')
        contacts?: string[]; // Array of contact email addresses
        software_id?: string; // Unique identifier for the client software
        software_version?: string; // Version of the client software
        [key: string]: any; // Additional metadata fields
      };
      // Optional: Initial access token for protected registration endpoints
      initialAccessToken?: string;
    };

    // MCP resource parameter (RFC8707) - the canonical URI of the MCP server
    resource?: string; // e.g., 'https://mcp.example.com/mcp'

    // Explicit authorization-server metadata replaces SDK discovery for this upstream.
    authorizationServerMetadata?: NonNullable<OAuthDiscoveryState['authorizationServerMetadata']>;
    authorizationRelay?: { allowedRedirectOrigins: string[] };
    // Authorization endpoint for user authorization (for authorization code flow)
    authorizationEndpoint?: string;
    // Token endpoint for exchanging authorization codes for tokens
    tokenEndpoint?: string;
    // Token revocation endpoint for upstream OAuth providers (RFC 7009)
    revocationEndpoint?: string;
    // Pending OAuth session metadata for PKCE/state recovery between restarts
    pendingAuthorization?: {
      authorizationUrl?: string;
      issuer?: string;
      issRequired?: boolean;
      state?: string;
      codeVerifier?: string;
      discoveryState?: OAuthDiscoveryState;
      createdAt?: number;
    };
  };
  perSessionClient?: boolean; // Dedicated upstream client per legacy session or explicit modern client state
  // On-demand spawning: start the stdio process only when a tool call arrives,
  // and shut it down automatically after a period of inactivity.
  // This reduces persistent memory usage for rarely-used servers.
  // Only effective for stdio-type servers; HTTP/SSE servers are unaffected.
  startOnDemand?: boolean; // When true, skip startup connect and spawn lazily on first tool call
  idleTimeoutMs?: number; // Milliseconds of inactivity before shutting down (default: 300_000 = 5 min)
  // OpenAPI specific configuration
  openapi?: {
    url?: string; // OpenAPI specification URL
    schema?: Record<string, any>; // Complete OpenAPI JSON schema
    version?: string; // OpenAPI version (default: '3.1.0')
    security?: OpenAPISecurityConfig; // Security configuration for API calls
    // Optional credential used ONLY to download the specification document when
    // the spec endpoint authenticates differently from the API (#1079), e.g.
    // Basic-protected /v3/api-docs behind a Bearer-protected API. Falls back to
    // `security` when absent. oauth2/openIdConnect here require a pre-obtained
    // static token; the dynamic client-credentials flow only exists for
    // `security`.
    specSecurity?: OpenAPISecurityConfig;
    passthroughHeaders?: string[]; // Header names to pass through from tool call requests to upstream OpenAPI endpoints
    cookieSession?: boolean; // Capture/replay cookies per legacy session or explicit modern client state
  };
}

// OpenAPI Security Configuration
```

### OpenAPISecurityConfig

```typescript
export interface OpenAPISecurityConfig {
  type: 'none' | 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  // API Key authentication
  apiKey?: {
    name: string; // Header/query/cookie name
    in: 'header' | 'query' | 'cookie';
    value?: string; // The API key value (may be empty until the user supplies it)
  };
  // HTTP authentication (Basic, Bearer, etc.)
  http?: {
    scheme: 'basic' | 'bearer' | 'digest'; // HTTP auth scheme
    bearerFormat?: string; // Bearer token format (e.g., JWT)
    credentials?: string; // Base64 encoded credentials for basic auth or bearer token
  };
  // OAuth2 (simplified - mainly for bearer tokens)
  oauth2?: {
    tokenUrl?: string; // Token endpoint for client credentials flow
    clientId?: string;
    clientSecret?: string;
    scopes?: string[]; // Required scopes
    token?: string; // Pre-obtained access token
    expiresAt?: number; // Access token expiration timestamp in milliseconds
  };
  // OpenID Connect
  openIdConnect?: {
    url: string; // OpenID Connect discovery URL
    clientId?: string;
    clientSecret?: string;
    token?: string; // Pre-obtained ID token
  };
}

// Information about a server's status and tools
```

### ServerInfo

```typescript
export interface ServerInfo {
  capabilityCache?: CapabilityCacheStatus;
  name: string; // Unique name of the server
  protocolVersion?: string; // Negotiated MCP protocol version for the current connection
  version?: string; // Upstream server version reported during MCP initialization
  // Resolved package version for stdio servers launched via npx/uvx (see #1166).
  // Read from the runner's install cache (npm _npx / uv tool environments),
  // distinct from `version` which is what the server reports about itself.
  packageVersion?: string;
  // Newest version the configured registry offers for this npx/uvx package
  // (see #1166). Only present once the registry has been queried.
  latestVersion?: string;
  // True when the registry has a newer version than the installed one.
  updateAvailable?: boolean;
  instructions?: string; // Upstream server instructions reported during MCP initialization
  owner?: string; // Owner of the server, defaults to 'admin' user
  visibility?: ServerVisibility; // Carried over from ServerConfig so dataService.filterData can apply #817 visibility rules at runtime.
  sharedWithUserGroups?: string[];
  sharedWithUsers?: string[]; // Carried over for restricted user-sharing authorization.
  status: 'connected' | 'connecting' | 'disconnected' | 'oauth_required'; // Current connection status
  error: string | null; // Error message if any
  tools: Tool[]; // List of tools available on the server
  prompts: Prompt[]; // List of prompts available on the server
  resources: Resource[]; // List of resources available on the server
  client?: Client; // Client instance for communication (MCP clients)
  transport?: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport; // Transport mechanism used
  openApiClient?: any; // OpenAPI client instance for openapi type servers
  options?: RequestOptions; // Options for requests
  createTime: number; // Timestamp of when the server was created
  enabled?: boolean; // Flag to indicate if the server is enabled
  recovery?: { attempts: number; lastAttemptAt?: number; nextAttemptAt?: number };
  keepAliveIntervalId?: NodeJS.Timeout; // Timer ID for keep-alive ping interval
  config?: ServerConfig; // Reference to the original server configuration for OpenAPI passthrough headers
  // On-demand spawning runtime state
  spawningPromise?: Promise<void>; // Singleton promise: concurrent callers await this instead of double-spawning
  activeToolCalls?: number; // Calls holding the on-demand runtime awake, including cold starts
  idleTimeoutId?: NodeJS.Timeout; // Timer ID for idle-shutdown (cleared/reset on each tool call)
  lastUsedAt?: number; // Timestamp of last tool call (ms since epoch)
  oauth?: {
    identityMode?: 'shared' | 'personal';
    // OAuth authorization state
    issuer?: string;
    issRequired?: boolean;
    authorizationUrl?: string; // OAuth authorization URL for user to visit
    state?: string; // OAuth state parameter for CSRF protection
    connected?: boolean; // True when stored upstream OAuth tokens exist
    clientIdConfigured?: boolean; // True when a static oauth.clientId is set (dynamic registration is suppressed).
    // When set, a preconfigured client's redirect-URI allow-list may not include this hub's callback,
    // causing the upstream authorize endpoint to reject with "invalid redirect_uri". Surfaced so the UI
    // can hint the user to remove clientId and let MCPHub self-register (DCR).
  };
}

// Details about a tool available on the server
```

### Tool

```typescript
export interface Tool {
  name: string; // Name of the tool
  title?: string; // Human-readable title
  description: string; // Brief description of the tool
  defaultDescription?: string; // Upstream tool description before any MCPHub override is applied
  hasDescriptionOverride?: boolean; // Whether MCPHub is currently overriding the upstream description
  hiddenParams?: string[]; // Configured top-level input parameters hidden from models (dashboard/API projection)
  inputSchema: Record<string, unknown>; // Input schema for the tool
  outputSchema?: Record<string, unknown>; // Optional schema for structured output
  annotations?: Record<string, unknown>; // Standard MCP tool annotations
  execution?: Record<string, unknown>; // Standard MCP execution metadata
  icons?: Array<Record<string, unknown>>; // Standard MCP icons
  _meta?: Record<string, unknown>; // Extension metadata, including MCP Apps metadata
  enabled?: boolean; // Whether the tool is enabled (optional, defaults to true)
}
```

### Prompt

```typescript
export interface Prompt {
  name: string; // Name of the prompt
  title?: string; // Title of the prompt
  description?: string; // Brief description of the prompt
  arguments?: PromptArgument[]; // Input schema for the prompt
}
```

### PromptArgument

```typescript
export interface PromptArgument {
  name: string; // Name of the argument
  title?: string; // Title of the argument
  description?: string; // Brief description of the argument
  required?: boolean; // Whether the argument is required
}

// Resource exposed by a connected MCP server
```

### Resource

```typescript
export interface Resource {
  uri: string; // Unique URI of the resource (e.g., 'file:///path' or custom scheme)
  name?: string; // Human-readable name
  title?: string; // Human-readable title
  description?: string; // Brief description of the resource
  mimeType?: string; // MIME type of the resource content
  size?: number; // Resource size in bytes
  annotations?: Record<string, unknown>; // Standard MCP resource annotations
  icons?: Array<Record<string, unknown>>; // Standard MCP icons
  _meta?: Record<string, unknown>; // Extension metadata, including MCP Apps metadata
}

// Built-in prompt defined via configuration
```

### BuiltinPrompt

```typescript
export interface BuiltinPrompt {
  id: string; // Unique identifier (UUID)
  name: string; // Prompt name used in MCP protocol
  title?: string; // Human-readable title
  description?: string; // Brief description
  template: string; // Template body with {{parameter}} placeholders
  arguments?: PromptArgument[]; // Argument definitions matching placeholders
  enabled?: boolean; // Whether this prompt is active (default: true)
}

// Built-in resource defined via configuration
```

### BuiltinResource

```typescript
export interface BuiltinResource {
  id: string; // Unique identifier (UUID)
  uri: string; // Resource URI (e.g., 'resource://docs/guide')
  name?: string; // Human-readable name
  description?: string; // Brief description
  mimeType?: string; // MIME type (default: 'text/plain')
  content: string; // Static content of the resource
  enabled?: boolean; // Whether this resource is active (default: true)
}

// Standardized API response structure
```

### ApiResponse

```typescript
export interface ApiResponse<T = unknown> {
  success: boolean; // Indicates if the operation was successful
  message?: string; // Optional message providing additional details
  data?: T; // Optional data payload
}

// Request payload for adding a new server
```

### AddServerRequest

```typescript
export interface AddServerRequest {
  name: string; // Name of the server to add
  config: ServerConfig; // Configuration details for the server
}

// Request payload for batch creating servers
```

### BatchCreateServersRequest

```typescript
export interface BatchCreateServersRequest {
  servers: AddServerRequest[]; // Array of servers to create
}

// Result for a single server in batch operation
```

### BatchServerResult

```typescript
export interface BatchServerResult {
  name: string; // Server name
  success: boolean; // Whether the operation succeeded
  message?: string; // Error message if failed
}

// Response for batch create servers operation
```

### BatchCreateServersResponse

```typescript
export interface BatchCreateServersResponse {
  success: boolean; // Overall operation success (true if at least one server succeeded)
  successCount: number; // Number of servers successfully created
  failureCount: number; // Number of servers that failed
  results: BatchServerResult[]; // Detailed results for each server
}

// Request payload for adding a new group
```

### AddGroupRequest

```typescript
export interface AddGroupRequest {
  visibility?: IGroup['visibility'];
  sharedWithUserGroups?: string[];
  sharedWithUsers?: string[];
  name: string; // Name of the group to add
  description?: string; // Optional description of the group
  instructions?: string; // Optional MCP initialize instructions for the group's routes
  servers?: string[] | IGroupServerConfig[]; // Array of server names or server configurations
}

// Request payload for batch creating groups
```

### BatchCreateGroupsRequest

```typescript
export interface BatchCreateGroupsRequest {
  groups: AddGroupRequest[]; // Array of groups to create
}

// Result for a single group in batch operation
```

### BatchGroupResult

```typescript
export interface BatchGroupResult {
  name: string; // Group name
  success: boolean; // Whether the operation succeeded
  message?: string; // Error message if failed
}

// Response for batch create groups operation
```

### BatchCreateGroupsResponse

```typescript
export interface BatchCreateGroupsResponse {
  success: boolean; // Overall operation success (true if at least one group succeeded)
  successCount: number; // Number of groups successfully created
  failureCount: number; // Number of groups that failed
  results: BatchGroupResult[]; // Detailed results for each group
}

// Activity status types
```

### ActivityStatus

```typescript
export type ActivityStatus = 'success' | 'error';

// Activity interface for tracking tool calls
```

### IActivity

```typescript
export interface IActivity {
  policy?: ToolPolicyAudit;
  id?: string; // Unique identifier (auto-generated for DB)
  timestamp: Date; // When the tool was called
  server: string; // Server name that handled the call
  tool: string; // Tool name that was called
  duration: number; // Duration in milliseconds
  status: ActivityStatus; // Call status
  input?: string; // JSON stringified input arguments
  output?: string; // JSON stringified output result
  group?: string; // Group name if called via group route
  username?: string; // Username associated with the request
  keyId?: string; // Bearer key ID if authenticated with bearer token
  keyName?: string; // Bearer key name for display purposes
  sourceIp?: string; // Source IP address of the caller
  errorMessage?: string; // Error message if status is 'error'
}

// Activity statistics interface
```

### IActivityStats

```typescript
export interface IActivityStats {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDuration: number; // Average duration in milliseconds
}

// Activity search/filter parameters
```

### IActivityFilter

```typescript
export interface IActivityFilter {
  server?: string;
  tool?: string;
  status?: ActivityStatus;
  group?: string;
  username?: string;
  keyId?: string;
  keyName?: string;
  startDate?: Date;
  endDate?: Date;
}

// Configuration template for team sharing
```

### ConfigTemplate

```typescript
export interface ConfigTemplate {
  version: string; // Template format version
  name: string; // Template name
  description?: string; // Template description
  createdAt: string; // ISO date string
  servers: Record<string, TemplateServerConfig>; // Server definitions with secrets stripped
  groups: TemplateGroup[]; // Group definitions
  requiredEnvVars: string[]; // List of environment variable placeholders that need user values
}

// Server config within a template - secrets replaced with placeholders
```

### TemplateServerConfig

```typescript
export interface TemplateServerConfig extends Omit<ServerConfig, 'owner' | 'oauth'> {
  env?: Record<string, string>; // Values are either literal or ${PLACEHOLDER}
  headers?: Record<string, string>;
  oauth?: Omit<NonNullable<ServerConfig['oauth']>, 'pendingAuthorization'>;
}

// Group within a template
```

### TemplateGroup

```typescript
export interface TemplateGroup {
  name: string;
  description?: string;
  servers: IGroupServerConfig[];
}

// Options for exporting a template
```

### TemplateExportOptions

```typescript
export interface TemplateExportOptions {
  name: string; // Template name
  description?: string; // Template description
  groupIds?: string[]; // Specific group IDs to export (empty = all)
  includeDisabledServers?: boolean; // Include disabled servers (default: false)
  requestingUser?: IUser; // Caller identity; non-admins only export what they can see
}

// Result of importing a template
```

### TemplateImportResult

```typescript
export interface TemplateImportResult {
  success: boolean;
  serversCreated: number;
  serversSkipped: number; // Already exist
  groupsCreated: number;
  groupsSkipped: number; // Already exist
  requiredEnvVars: string[]; // Env vars that need to be supplied
  details: TemplateImportDetail[];
}

// Detail for a single import item
```

### TemplateImportDetail

```typescript
export interface TemplateImportDetail {
  type: 'server' | 'group';
  name: string;
  action: 'created' | 'skipped' | 'failed';
  message?: string;
}

// ─── Context Footprint (token cost) feature ───────────────────────────────
```

### ItemCost

```typescript
export interface ItemCost {
  kind: 'tool' | 'prompt' | 'resource';
  name: string;
  cost: number;
  enabled: boolean;
}
```

### ServerCost

```typescript
export interface ServerCost {
  name: string;
  connected: boolean;
  exposed: number;
  gross: number;
  items: ItemCost[];
}
```

### SmartRoutingCost

```typescript
export interface SmartRoutingCost {
  base: number;
  progressiveDisclosure: number;
}
```

### GroupCost

```typescript
export interface GroupCost {
  id: string;
  name: string;
  connectedCount: number;
  totalCount: number;
  direct: { exposed: number; gross: number };
  smartRouting: SmartRoutingCost | null;
}

/**
 * The effective security requirement a parsed OpenAPI spec declares (#1077).
 *
 * Resolved per OpenAPI 3.x: an operation-level `security` overrides the
 * root-level one for that operation; `security: []` explicitly disables auth.
 * A requirement is an OR-list of named schemes from
 * `components.securitySchemes`; the first alternative MCPHub can represent is
 * returned as `prefill` with structural fields only — a spec can never supply
 * the secret itself, so value / credentials / token are left empty for the
 * user to fill in on the import form.
 */
```

### OpenAPIDeclaredSecurity

```typescript
export interface OpenAPIDeclaredSecurity {
  /** True when the spec declares a resolvable security requirement. */
  declared: boolean;
  /** True when the declared scheme maps onto MCPHub's security model. */
  supported: boolean;
  /** Prefill-able security config (structure only, never secrets). */
  prefill?: OpenAPISecurityConfig;
  /** Human-readable description of the resolved scheme (e.g. "HTTP bearer (JWT)"). */
  summary: string;
  /** Number of OR-alternatives in the resolved requirement (1 = single scheme). */
  alternatives: number;
  /** True when a secret the spec cannot supply is required to call tools. */
  requiresCredentials: boolean;
  /** Why the declared scheme cannot be represented by MCPHub. */
  unsupportedReason?: string;
  /** True when the effective apiKey scheme uses `in: 'cookie'` (cookieSession hint). */
  cookieHint?: boolean;
}

/**
 * Pre-save OpenAPI import preview (#1082): what the generated tool list would
 * look like if this spec were imported, before anything is persisted.
 */
```

### OpenApiToolStats

```typescript
export interface OpenApiToolStats {
  /** Number of tools extractTools() would generate for the spec. */
  toolCount: number;
  /**
   * Byte length of the JSON array of generated tool definitions — a proxy for
   * the tools/list payload size clients receive.
   */
  definitionsBytes: number;
  /** cl100k token estimate across all generated tool definitions. */
  estimatedTokens: number;
  /** Effective security requirement the spec declares, for form prefill (#1077). */
  declaredSecurity?: OpenAPIDeclaredSecurity;
}

/** One-shot updates to currently discovered tools; patterns are not persisted. */
```

### BatchToggleToolsRequest

```typescript
export interface BatchToggleToolsRequest {
  enabled: boolean;
  tools: string[];
}
```

### BatchToggleToolsResponse

```typescript
export interface BatchToggleToolsResponse {
  matchedTools: string[];
  enabled: boolean;
}
```
