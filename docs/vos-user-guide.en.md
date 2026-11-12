### MCPHub: run, manage and call MCP servers

Applies to VOS MCPHub 1.2.3-vos.01. MCPHub brings local and remote MCP servers into one gateway with server management, tools, groups, prompts, resources and application integration. The VOS app drawer contains two peer pages: Server Management and API Integration Guide.

#### Install, sign in and choose a language

Install or upgrade MCPHub in the VOS App Store. Choose the CPU profile matching your device architecture for management and remote MCP calls. Use an NVIDIA, L4T or Thor/Spark profile only when a trusted local MCP needs GPU access. These profiles expose devices and drivers; they do not include model frameworks or the CUDA toolkit.

Open Server Management from the app drawer. Sign-in uses the current VOS account automatically; no separate MCPHub password is required. Administrators can manage local command servers. Other users can access authorized services. Language follows VOS by default; the app's language menu also offers English, Chinese and Follow VOS language. Changing language does not stop servers.

#### A working offline MCP example

The image includes `/app/examples/vos-demo.mjs`. It needs no model download, additional package installation or API key. It provides the `add` and `echo` tools, the `demo://status` resource and the `explain-sum` prompt.

As an administrator, choose Servers → Add. Set Server Name to `vos-demo`, Server Type to STDIO Command and command to `node`. Click Add argument and enter `/app/examples/vos-demo.mjs` in one argument field. Keep Visibility under Advanced Options set to Private — only the owner and admins, then click Add. Wait for Online and refresh the tool list if necessary. Keep command and arguments in separate fields.

Call `add` with `a=7` and `b=5`; the result should be `12`. Call `echo` with `message=hello MCP`; it should return the same text. In the server card’s Resources tab, confirm that `demo://status` was discovered, then read it with the SDK client below; the result should be `{"server":"vos-demo","status":"ready"}`. In the server card’s Prompts tab, choose `explain-sum` and supply string arguments `a=7`, `b=5`. It creates a message asking a client to calculate and explain the sum; retrieving a prompt does not itself run a language model.

Create a second server named `vos-demo-public` with the same command and argument, selecting Public under Advanced Options. This starts another independent MCP process for authenticated sharing and application discovery checks.

#### Manage instances and sharing

Server cards show connection state, tools and errors. Edit changes the connection configuration. Disabling prevents calls; enabling restores the server. Reload rebuilds the connection and local process, which is useful after changing commands or environment variables. Delete removes the configuration, so check the selected server first. Start On Demand starts a local server when called and stops it after the idle timeout. Per-Session Client Isolation suits stateful browser servers and increases connections and processes.

Enable and Reload connect asynchronously. Wait for Online and the tool list to return before calling. The card's `v1.0.0` is the demo MCP server's own version, separate from the VOS package version.

Private allows the owner and administrators. Shared selects users and user groups. Public allows authenticated users and discovery by other VOS applications using their own application identity. Public does not mean anonymous. Application identities can only discover and call public servers and never inherit a platform administrator role. Private is an access scope, not an operating-system sandbox: only run trusted administrator-approved STDIO code.

#### Existing servers, market and imports

Add supports STDIO, SSE, Streamable HTTP and OpenAPI. Enter a remote service's real URL and required upstream credentials. OpenAPI converts an API definition into tools. Market provides templates; Import and Upload load configurations in batches. Review commands, URLs, environment variables and sharing before enabling them. Package downloads, market services and remote APIs require network access. MCPHub runs no Docker daemon and mounts no host Docker socket. Deploy Docker-only MCPs independently, then connect over HTTP/SSE.

Credentials manages personal upstream credentials. When a server declares personal credential slots, each user binds their own values; organization credentials are not an automatic fallback. Connect OAuth-based upstreams through their authorization flow. Do not put VOS tokens in upstream API-key fields or configure them for header passthrough.

#### Groups, tools, prompts and resources

Create a group and add servers to expose a combined group endpoint. Enable or disable individual tools, customize descriptions and configure hidden parameters to narrow the client-facing surface. Tool access policies can further restrict calls. The server card’s Prompts and Resources tabs show upstream entries, with prompt invocation, descriptions and enable switches. Read resource content through an MCP client; capabilities depend on the server. The sidebar Prompts and Resources pages let administrators create, edit, enable, disable and delete MCPHub built-in entries. Built-in prompts accept configured arguments; built-in resources contain a URI, MIME type and text content and are available through the aggregate MCP endpoint.

For a reproducible group, create private `vos-demo-group` and add `vos-demo` and `vos-demo-public`. Connect to `/app/com.ictrek.mcphub/mcp/vos-demo-group`, list tools and use the returned full name. Default names include a server prefix, such as `vos-demo-add`.

#### Logs, settings and troubleshooting

Logs shows connection, process and call errors. Settings includes keys, tool policies, Smart Routing, result compression, OAuth Server, market/system configuration and configuration export. Smart Routing, model-based compression and external markets require their own dependencies; the offline demo does not need them. Manage VOS accounts and passwords on the platform. Generic upstream authentication options do not replace VOS sign-in.

For login failure, confirm that the app was opened from VOS, the platform session is valid and MCPHub is upgraded to 1.2.3-vos.01, which fixes Safari's login-request credential mode on local devices. For an offline server, inspect command, arguments, dependencies, network and logs. If a server has no available tools, check permissions and server/tool switches. Export configuration before major changes and protect the application data directory and credentials with your backup policy. Upgrades preserve server configuration and do not automatically create these demo instances.

These examples ran on a Thor/Spark device with Safari and Chromium UI checks. Acceptance covered tools, resources and prompts on both servers, disable/enable/reload, group calls, and another VOS application's identity discovering and calling the public instance while being excluded from private discovery and management APIs. The demo uses CPU; this does not establish GPU inference compatibility.

## Application API reference

### MCPHub

#### VOS tokens, user verification and automatic application integration

API Integration Guide includes the complete PKCE user-token flow: call `vos_platform.api.v1000.oauth2.authorize` inside a VOS same-origin iframe, validate state, exchange the code with `token` and refresh expired credentials. Do not extract the platform login token or replace authorization with hard-coded administrator credentials.

Call `GET /app/com.ictrek.mcphub/api/integration/whoami` with `Authorization: Bearer <VOS application access token>` to verify identity. Call `GET /app/com.ictrek.mcphub/api/integration/discovery` to list enabled, authorized servers and their relative MCP paths. The backend verifies the token through VOS userinfo rather than trusting browser-supplied roles.

Another VOS application can mount its own application-context token read-only as shown in the guide. Its backend calls discovery and connects to public servers using the returned paths. Forward an actual user's valid authorization token when accessing their private servers. Handle MCPHub being absent, unavailable or forbidden without falling back to anonymous access. Discovery never returns commands, environment variables, upstream addresses or secrets.

#### Call from an MCP client

API Integration Guide provides complete device-specific URLs, desktop-client configuration and Node SDK examples. The single-server path is `/app/com.ictrek.mcphub/mcp/vos-demo`; the aggregate endpoint is `/app/com.ictrek.mcphub/mcp`. Group and user-scoped endpoints are also supported. Authenticate with a valid VOS application access token representing the user, or an MCPHub user-level Bearer Key owned by that user. User-level keys work on MCP transports, not VOS discovery/identity APIs. Store credentials in protected client configuration or environment variables, never in documentation or screenshots. The client system must trust the HTTPS certificate.

Install `@modelcontextprotocol/sdk@1.29.0` in a client directory and save the following as `call-mcp.mjs`. Set `MCPHUB_URL` to the full single-server URL, set `MCPHUB_TOKEN` to the user credential above, then run `node call-mcp.mjs`.

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'mcphub-demo-client', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCPHUB_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCPHUB_TOKEN}` } },
  }));
  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === 'add' || t.name.endsWith('-add') || t.name.endsWith('__add'));
  if (!tool) throw new Error('add tool is unavailable');
  console.log(await client.callTool({ name: tool.name, arguments: { a: 7, b: 5 } }));
  const resources = await client.listResources();
  console.log(await client.readResource({ uri: resources.resources[0].uri }));
  const prompts = await client.listPrompts();
  console.log(await client.getPrompt({
    name: prompts.prompts[0].name, arguments: { a: '7', b: '5' },
  }));
} finally {
  await client.close();
}
```
