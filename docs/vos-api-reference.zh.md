# MCPHub API 参考

## 地址与快速入门

从 **API 集成指南 → 完整 API 参考** 打开可离线阅读、搜索的文档。原有指南保留 VOS OAuth/PKCE 和 SDK 示例。下面集中说明身份、Key、服务配置与共享、工具调用、错误以及所有静态注册 HTTP 操作。动态 MCP 工具的 inputSchema/outputSchema 由上游定义，应通过 tools/list 发现参数，不凭模型或工具名称猜测。

| 调用方 | 基础地址 |
| --- | --- |
| VOS 同域应用 | `/app/com.ictrek.mcphub` |
| vos_default 容器 | `http://mcphub:3000/app/com.ictrek.mcphub` |
| 外部客户端 | `https://<VOS宿主机>:<VOS端口>/app/com.ictrek.mcphub` |

应用没有单独映射宿主机端口。`/health`、`/livez`、`/readyz`、`/metrics` 是容器根路径，不带应用前缀。内部 hosted webhook 不是外部客户端入口；目录列出的接口仍可能要求管理员、归属检查、数据库模式或启用可选功能。

## VOS 鉴权与权限

管理请求携带 `Authorization: Bearer <VOS用户access-token>`，也支持 x-vos-token。通过调用应用自身的 VOS OAuth PKCE 流程取得凭证，原 API 集成指南提供完整示例。`POST /api/auth/vos` 校验后返回 `{success,user:{username,displayName,isAdmin,permissions}}`，不会另外生成 dashboard Key。VOS 模式先校验平台身份，不走旧 JWT/static-key 管理分支。MCP 用户 Key、Scheduler Key、厂商凭证均不能认证 VOS 管理 API。原生章节中的独立部署 `/api/auth/login`、x-auth-token 不是 VOS 登录方式。

`GET /api/integration/whoami` 返回 `{success,data:{kind,sub,username,is_admin,application_id,scope}}`；`GET /api/integration/discovery` 返回 protocol、transport、auth、聚合 mcp_path，以及 name、description、visibility、status、mcp_path 组成的服务列表。发现结果不包含命令、环境变量、上游地址或密钥。应用上下文身份仅可用这些集成接口及 public MCP 调用，不能成为管理员或访问 private 服务。

服务 visibility 的 API 值是 `private`、`group`（界面“共享”）和 `public`。private 供所有者和管理员，group 使用 `sharedWithUsers`、`sharedWithUserGroups` 扩展给指定用户/组，public 供已认证用户与应用发现，**不代表匿名开放**。工具与组可继续限制权限。发现到 disconnected 服务不代表可调用；401 是身份问题，403 是拒绝权限，404 也可能隐藏无权资源，不能通过移除权限解决发现问题。

## 客户端 Key：创建、查看、修改、轮换、删除

在设置中的 Bearer 认证密钥创建 **用户级** Key 给外部 MCP 客户端。用户 Key 在 MCP transport 恢复所属用户的实时权限，不能调用 dashboard/integration REST API。普通用户只能创建自己的用户 Key；管理员创建 kind:user 时须指定已有 owner。kind:system 是管理员运维 Key，有独立资源范围，不应发给普通客户端；VOS REST 管理仍要求 VOS 用户鉴权。

| 操作 | 请求与返回 |
| --- | --- |
| GET `/api/auth/keys` | `{success:true,data:[...]}`，token 脱敏、hash 不返回；管理员看全部，普通用户看自己的用户 Key。 |
| POST `/api/auth/keys` | 管理员创建用户 Key：`{name,kind:"user",owner:"<已有用户>"}`；普通用户可只发 `{name}`。enabled 默认 true。201 响应的 data.token **只返回一次**，应立即安全保存。 |
| PUT `/api/auth/keys/{id}` | 修改 name/enabled；管理员的 system Key 还可改 accessType 及允许/排除组与服务。返回脱敏元数据，不能在这里替换原始 token 或转移 owner/kind；省略保留原值。 |
| POST `/api/auth/keys/{id}/reset` | 无需 body；生成新 secret，保留 owner、启用状态、资源范围。data.token 完整返回一次，旧 secret 立即失效。 |
| DELETE `/api/auth/keys/{id}` | 所有者/管理员操作；返回 `{success:true}` 并删除 Key。 |

system accessType 为 all/groups/servers/custom/exclude；允许范围用 allowedGroups/allowedServers，排除范围用 excludedGroups/excludedServers，exclude 至少指定一个排除对象。用户 Key 的 all 表示该用户实时权限范围，不能获得管理员权限。修改无关字段不会自动启用禁用的 Key。丢失 secret 要 reset，列表和修改响应无法找回。上游 OAuth 和个人凭证绑定与此处客户端 Key 无关。

```sh
# 管理使用 VOS 用户 token；不要把包含新 Key 的响应写入公开日志。
curl --fail-with-body "$MCPHUB_BASE/api/auth/keys" \
  -H "Authorization: Bearer $VOS_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"my-agent"}'
# 将 data.token 保存为 MCPHUB_USER_KEY，不能替代管理所用 VOS_USER_TOKEN。
curl --fail-with-body -X PUT "$MCPHUB_BASE/api/auth/keys/$KEY_ID" \
  -H "Authorization: Bearer $VOS_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"renamed-agent","enabled":false}'
curl --fail-with-body -X POST "$MCPHUB_BASE/api/auth/keys/$KEY_ID/reset" \
  -H "Authorization: Bearer $VOS_USER_TOKEN"
```

## 服务配置、共享与个人上游凭证

`POST /api/servers` 接收 `{name,config}`，`PUT /api/servers/{name}` 接收 `{config,newName?}`。config 包含 type（stdio/sse/streamable-http/openapi）、command+args/env 或 url+headers、enabled、description、visibility 和共享配置。OpenAPI 类型要求 config.openapi.url 或 schema。命令与参数分别填写，本地代码须可信并经管理员批准。PUT config 应提供所需完整配置，不能当作未经定义的 merge patch；有意保留原有必需字段。导出配置可能敏感，不要复制到公开报告。

`POST /api/servers/{name}/toggle` 接收 `{enabled:boolean}`；reload 异步重连。delete 删除配置；reload/disable 不等于通用运行中任务取消或模型卸载。组有自身 ID、成员和工具策略，完整字段见下方原生说明、ServerConfig 和 credential 类型。

个人上游绑定：GET `/api/credentials` 返回 slot/绑定元数据，PUT `/api/credentials/{name}` 为 `{values:{"<slot>":"<secret>"}}`，DELETE 删除该用户绑定。复制使用 POST `/api/credentials/{name}/copy` 和 `{sourceServer,overwrite?}`。管理员对应 `/api/users/{username}/credentials/...`，仍检查模板及可见性。不要把省略、null、空字符串视为统一清空，用 DELETE 移除绑定。这些凭证不是外部客户端 Key。`/api/oauth/approvals` 可单独列出/撤销授权；撤销调用应用不等于删除上游服务。

管理员可通过 POST /api/servers 注册无需下载的本地示例：

```json
{"name":"vos-demo","config":{"type":"stdio","command":"node","args":["/app/examples/vos-demo.mjs"],"enabled":true,"visibility":"private"}}
```

后续 PUT `/api/servers/vos-demo` 时保留所需配置，将 config.visibility 改为 public 或 group；group 共享还需 sharedWithUsers/sharedWithUserGroups，使用真实本地用户名/组标识。通过 `/api/servers/{name}/share-candidates` 获取候选，不猜测身份。private 改 public 会影响所有已认证调用方的访问范围。

## MCP 调用、会话与取消

`/mcp` 聚合，`/mcp/{组或服务}` 限定范围；使用发现到的完整工具名称。身份用用户 VOS token 或 MCPHub 用户 Key。通过 MCP SDK initialize 协商后 tools/list、tools/call，参数和输出以发现结构为准。Streamable HTTP 可返回 JSON 或 SSE，保留 MCP session header 和协商的 protocol version；完成后关闭 transport。配置允许时兼容旧 SSE 和用户作用域路径。

```javascript
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({name:'my-agent',version:'1.0.0'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCPHUB_MCP_URL), {
    requestInit:{headers:{Authorization:`Bearer ${process.env.MCPHUB_USER_KEY}`}}
  }));
  const {tools} = await client.listTools();
  const add = tools.find(t => /(?:^|[-_])add$/.test(t.name));
  if (!add) throw new Error('Configured demo add tool is unavailable');
  console.log(await client.callTool({name:add.name,arguments:{a:7,b:5}}));
} finally {await client.close();}
```

管理辅助接口 `POST /api/tools/call/{server}` 在 VOS 用户鉴权下接收 `{toolName,arguments:{...}}`，不能向此 REST 地址发送原生 JSON-RPC 信封。MCP notifications/cancelled 和关闭连接是协议取消信号，不能保证所有上游进程立即停止；通过其自身工具确认任务状态。工具错误也可能在 HTTP 200 的 isError 内容中返回，超时不要盲目重试非幂等工具。MCPHub 没有模型预算/permit/unload API，推理执行和模型停止由 V-Scheduler 或注册应用负责。

## 错误、网络与实时 OpenAPI

多数管理接口返回 `{success,data,message}`，字段验证、OAuth 等结构不同，须同时检查 HTTP 状态、success 和具体响应。400 参数、401 身份、403 权限、404 对象、409 冲突、429 限流、5xx 服务/上游故障应分别处理；OAuth 可能用标准 error/error_description。任务创建、安装、导入、删除、轮换凭证遇到不确定网络结果，先检查状态再决定重试，日志不暴露 token。

`/api/openapi.json` 和 `/api/{group}/openapi.json` 描述动态暴露的 **MCP 工具**，不是完整 REST 管理接口。支持源码定义的 title、description、version、serverUrl、includeDisabled、group、servers 过滤及 YAML 版本。上游更新后读取实时结构与 tools/list。Mintlify 源码中的 plant-store openapi.json 是样例，不是 MCPHub 管理契约。中国大陆宿主机可能无法连接受限国外 API，先分别排查网络与凭证。

## 全量静态 HTTP 目录

下方从 src/routes/index.ts 全部 169 个静态注册生成。boundary 为 authenticatedRouter/router/app，仍受中间件与 handler 检查。每条绑定字段与响应表达式是 **TypeScript 源码表达式**，不是可直接请求的 JSON，也不是伪造的 JSON Schema。共用委托 handler、可选/动态处理器链接到准确源码；后面的原生章节给出常用操作的请求响应实例，共享类型保留全部声明字段。目录不会赋予内部 hosted/OAuth 接口权限。

### ALL <BetterAuthPath>

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

### ALL <BetterAuthPath>/*

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### POST /oauth/token

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### GET /.well-known/oauth-protected-resource/:resourcePath(*)

`app` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### GET /api/users/:username/credentials

`authenticatedRouter` · `listUserCredentials` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L97)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### POST /api/credentials/:name/copy

`authenticatedRouter` · `copyMyCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L141)

参数/返回委托给关联 handler；见源代码及原生说明。

### GET /api/credentials

`authenticatedRouter` · `listMyCredentials` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L94)

参数/返回委托给关联 handler；见源代码及原生说明。

### PUT /api/credentials/:name

`authenticatedRouter` · `updateMyCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L95)

参数/返回委托给关联 handler；见源代码及原生说明。

### DELETE /api/credentials/:name

`authenticatedRouter` · `updateMyCredential` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/controllers/credentialBindingController.ts#L95)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### DELETE /api/servers/:serverName/tools/:toolName/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

### PUT /api/servers/:serverName/tools/:toolName/hidden-params

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### DELETE /api/servers/:serverName/prompts/:promptName/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### DELETE /api/servers/:serverName/resources/:resourceUri/description

`authenticatedRouter` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### POST /api/auth/register

`router` · `inline middleware/handler` · [Source](https://github.com/ictrektech/mcphub/blob/main/src/routes/index.ts)

参数/返回委托给关联 handler；见源代码及原生说明。

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

参数/返回委托给关联 handler；见源代码及原生说明。

### GET /config

免认证接口 `GET /app/com.ictrek.mcphub/config` 的字符串字段 `data.version` 返回已安装的 VOS 应用包版本，例如 `1.2.3-vos.01`，用于左上角图标旁的版本显示。响应结构及状态码保持一致。

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

## 原生 REST 与 MCP 操作说明

以下独立部署认证说明必须结合前文 VOS 鉴权限制使用。

### servers



















---

### 获取所有服务器

已连接且已启用的 MCP 服务器会返回可选的 `protocolVersion` 字段，表示当前连接实际协商的 MCP 协议版本。断开、禁用、OpenAPI 服务器或版本不可用时省略该字段；此字段与服务器软件版本 `version` 不同。

检索所有已配置的 MCP 服务器的列表，包括其状态和可用工具。

- **端点**: `/api/servers`
- **方法**: `GET`
- **响应**:
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
            "description": "工具1的描述"
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

### 创建一个新服务器

将一个新的 MCP 服务器添加到配置中。

- **端点**: `/api/servers`
- **方法**: `POST`
- **正文**:
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
  - `name` (string, 必填): 服务器的唯一名称。
  - `config` (object, 必填): 服务器配置对象。
    - `type` (string): `stdio`、`sse`、`streamable-http` 或 `openapi`。
    - `command` (string): `stdio` 类型要执行的命令。
    - `args` (array of strings): 命令的参数。
    - `url` (string): `sse`、`streamable-http` 或 `openapi` 类型的 URL。
    - `openapi` (object): OpenAPI 配置。
      - `url` (string): OpenAPI 模式的 URL。
      - `schema` (object): OpenAPI 模式对象本身。
    - `headers` (object): `sse`、`streamable-http` 和 `openapi` 类型请求要发送的标头。
    - `keepAliveInterval` (number): 远端服务健康检查的间隔（毫秒）。默认为 60000。
    - `enableKeepAlive` (boolean): 是否为远端服务启用周期性健康检查。已断连的远端服务始终会通过有上限的指数退避和随机抖动自动重连。
    - `owner` (string): 服务器的所有者。默认为当前用户或“admin”。

---

### 更新一个服务器

更新现有 MCP 服务器的配置。

- **端点**: `/api/servers/:name`
- **方法**: `PUT`
- **参数**:
  - `:name` (string, 必填): 要更新的服务器的名称。
- **正文**:
  ```json
  {
    "config": {
      "type": "stdio",
      "command": "node",
      "args": ["new_server.js"]
    }
  }
  ```
  - `config` (object, 必填): 更新后的服务器配置对象。详情请参阅“创建一个新服务器”。

---

### 删除一个服务器

从配置中删除一个 MCP 服务器。

- **端点**: `/api/servers/:name`
- **方法**: `DELETE`
- **参数**:
  - `:name` (string, 必填): 要删除的服务器的名称。

---

### 切换一个服务器

启用或禁用一个 MCP 服务器。

- **端点**: `/api/servers/:name/toggle`
- **方法**: `POST`
- **参数**:
  - `:name` (string, 必填): 要切换的服务器的名称。
- **正文**:
  ```json
  {
    "enabled": true
  }
  ```
  - `enabled` (boolean, 必填): `true` 启用服务器，`false` 禁用服务器。

---

### 批量设置工具状态

`POST /api/servers/:serverName/tools/toggle` 在单个请求中启用或禁用当前已发现的工具。需要仪表板身份认证，以及与单工具接口相同的服务器配置管理权限。

```json
{
  "enabled": false,
  "tools": ["create_*", "delete_*", "specific_tool"]
}
```

- `enabled` 必须是布尔值；重复请求设置相同状态。
- `tools` 包含 1–100 个非空名称或模式，每项最多 256 个字符。模式区分大小写并匹配完整名称：`*` 匹配零个或多个字符，`?` 匹配一个字符，其他字符均按字面匹配。
- 精确名称优先解析带服务器前缀的运行时名称，其次解析上游原始名称。模式可匹配这两种形式，前缀使用当前配置的名称分隔符。
- 匹配项去重后一次保存，保留描述和隐藏参数。变更影响所有分组，无需重新连接即对工具发现和后续调用生效。
- 个人 OAuth 或个人凭据绑定服务器使用当前认证用户的工具清单，不会借用其他用户的凭据。无法获取该清单时返回 `409`，不修改工具状态。
- 模式只针对当前清单展开一次，不会保存为约束未来工具的策略。工具清单不可用时返回 `409`；没有匹配项时成功返回且不写入配置。

响应包含匹配的运行时工具名：

```json
{
  "success": true,
  "data": {
    "matchedTools": ["example-create_item", "example-delete_item"],
    "enabled": false
  }
}
```

现有单工具接口继续可用。

---

### 切换一个工具

启用或禁用服务器上的特定工具。

- **端点**: `/api/servers/:serverName/tools/:toolName/toggle`
- **方法**: `POST`
- **参数**:
  - `:serverName` (string, 必填): 服务器的名称。
  - `:toolName` (string, 必填): 工具的名称。
- **正文**:
  ```json
  {
    "enabled": true
  }
  ```
  - `enabled` (boolean, 必填): `true` 启用工具，`false` 禁用工具。

---

### 更新工具描述

更新特定工具的描述。

- **端点**: `/api/servers/:serverName/tools/:toolName/description`
- **方法**: `PUT`
- **参数**:
  - `:serverName` (string, 必填): 服务器的名称。
  - `:toolName` (string, 必填): 工具的名称。
- **正文**:
  ```json
  {
    "description": "新的工具描述"
  }
  ```
  - `description` (string, 必填): 工具的新描述。

---

### 隐藏工具参数

设置模型看不到的工具顶层输入参数。这些参数会从 `tools/list`、`search_tools` 结果、`describe_tool`、智能路由的嵌入文本、生成的 OpenAPI 规范和上下文成本统计中的输入 schema 里移除，并在转发调用前从参数中丢弃，由上游默认值生效。适用于部署无法使用的选项，例如自托管后端的云端专属功能。控制台仍显示完整 schema。

- **端点**: `/api/servers/:serverName/tools/:toolName/hidden-params`
- **方法**: `PUT`
- **参数**:
  - `:serverName` (string, 必填): 服务器的名称。
  - `:toolName` (string, 必填): 工具的名称，可带或不带服务器前缀。
- **正文**:
  ```json
  {
    "hiddenParams": ["profile", "zeroDataRetention"]
  }
  ```
  - `hiddenParams` (string[], 必填): 顶层参数名。空数组表示移除该设置。
- **错误**: 参数名不属于该工具或列在其 `required` 中时返回 `400`。这些检查在服务器已连接时进行；否则按原样保存，且必填参数始终不会被隐藏。

---

### 更新系统配置

更新系统范围的配置设置。

- **端点**: `/api/system-config`
- **方法**: `PUT`
- **正文**:
  ```json
  {
    "openaiApiKey": "sk-...",
    "openaiBaseUrl": "https://api.openai.com/v1",
    "modelName": "gpt-4",
    "temperature": 0.7,
    "maxTokens": 2048
  }
  ```
  - 所有字段都是可选的。只有提供的字段会被更新。

---

### 获取设置

检索所有服务器设置和配置。

- **端点**: `/api/settings`
- **方法**: `GET`
- **响应**:
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

**注意**: 有关详细的提示词管理，请参阅 [提示词 API](/zh/api-reference/prompts) 文档。

### groups












---

### 获取所有群组

检索所有服务器群组的列表。

- **端点**: `/api/groups`
- **方法**: `GET`
- **成功响应**:
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "group-1",
        "name": "我的群组",
        "description": "服务器的集合。",
        "servers": ["server1", "server2"],
        "owner": "admin"
      }
    ]
  }
  ```

---

### 创建一个新群组

创建一个新的服务器群组。

- **端点**: `/api/groups`
- **方法**: `POST`
- **正文**:
  - `name` (string, 必填): 群组的名称。
  - `description` (string, 可选): 群组的描述。
  - `instructions` (string, 可选): 在该群组路由上作为 MCP `initialize` 的 instructions 发送。参见[分组说明](/zh/features/group-management#分组说明)。
  - `servers` (array of strings, 可选): 要包含在群组中的服务器名称列表。
- **请求示例**:
  ```json
  {
    "name": "我的新群组",
    "description": "新群组的描述",
    "servers": ["server1", "server2"]
  }
  ```

---

### 获取一个群组

通过 ID 或名称检索特定群组的详细信息。

- **端点**: `/api/groups/:id`
- **方法**: `GET`
- **参数**:
  - `:id` (string, 必填): 群组的 ID 或名称。

---

### 更新一个群组

更新现有群组的名称、描述或服务器列表。

- **端点**: `/api/groups/:id`
- **方法**: `PUT`
- **参数**:
  - `:id` (string, 必填): 要更新的群组的 ID 或名称。
- **正文**:
  - `name` (string, 可选): 群组的新名称。
  - `description` (string, 可选): 群组的新描述。
  - `instructions` (string, 可选): 群组的新说明；空字符串表示移除。
  - `servers` (array, 可选): 群组的新服务器列表。格式请参阅 [批量更新群组服务器](#批量更新群组服务器)。
- **请求示例**:
  ```json
  {
    "name": "更新后的群组名称",
    "description": "更新后的描述"
  }
  ```

---

### 删除一个群组

通过 ID 或名称删除一个群组。

- **端点**: `/api/groups/:id`
- **方法**: `DELETE`
- **参数**:
  - `:id` (string, 必填): 要删除的群组的 ID 或名称。

---

### 将服务器添加到群组

将单个服务器添加到群组。

- **端点**: `/api/groups/:id/servers`
- **方法**: `POST`
- **参数**:
  - `:id` (string, 必填): 群组的 ID 或名称。
- **正文**:
  - `serverName` (string, 必填): 要添加的服务器的名称。
- **请求示例**:
  ```json
  {
    "serverName": "my-server"
  }
  ```

---

### 从群组中删除服务器

从群组中删除单个服务器。

- **端点**: `/api/groups/:id/servers/:serverName`
- **方法**: `DELETE`
- **参数**:
  - `:id` (string, 必填): 群组的 ID 或名称。
  - `:serverName` (string, 必填): 要删除的服务器的名称。

---

### 批量更新群组服务器

用新的列表替换群组中的所有服务器。该列表可以是简单的字符串或详细的配置对象。

- **端点**: `/api/groups/:id/servers/batch`
- **方法**: `PUT`
- **参数**:
  - `:id` (string, 必填): 群组的 ID 或名称。
- **正文**:
  - `servers` (array, 必填): 服务器名称（字符串）或服务器配置对象的数组。
- **请求示例 (简单)**:
  ```json
  {
    "servers": ["server1", "server2"]
  }
  ```
- **请求示例 (详细)**:
  ```json
  {
    "servers": [
      { "name": "server1", "tools": "all" },
      { "name": "server2", "tools": ["toolA", "toolB"] }
    ]
  }
  ```

服务器配置对象还可以包含 `pinnedTools`：不带前缀的工具名数组，这些工具会在分组的 `$smart/{group}` 端点中与元工具一同列出（参见 [固定工具](/zh/features/smart-routing#固定工具)）。只有同时在 `tools` 中选中的固定工具才会生效。

---

### 获取群组服务器配置

检索群组内所有服务器的详细配置，包括启用了哪些工具。

- **端点**: `/api/groups/:id/server-configs`
- **方法**: `GET`
- **参数**:
  - `:id` (string, 必填): 群组的 ID 或名称。
- **成功响应**:
  ```json
  {
    "success": true,
    "data": [
      {
        "name": "server1",
        "tools": "all"
      },
      {
        "name": "server2",
        "tools": ["toolA", "toolB"]
      }
    ]
  }
  ```

---

### 更新群组服务器工具

更新群组内特定服务器的工具选择。

- **端点**: `/api/groups/:id/server-configs/:serverName/tools`
- **方法**: `PUT`
- **参数**:
  - `:id` (string, 必填): 群组的 ID 或名称。
  - `:serverName` (string, 必填): 要更新的服务器的名称。
- **正文**:
  - `tools` (string or array of strings, 必填): 字符串 `"all"` 表示启用所有工具，或一个工具名称数组以指定启用哪些工具。未包含在数组中的工具会被移除固定（`pinnedTools`）。
- **请求示例**:
  ```json
  {
    "tools": ["toolA", "toolC"]
  }
  ```

### 可见性字段

`POST /api/groups`、`POST /api/groups/batch` 中的各组以及 `PUT /api/groups/:id`
支持 `visibility`（`private | group | public`）和 `sharedWithUsers`（非空用户名数组）。
新组默认私有，更新时省略字段则保持原值。`shared` 和 `null` 不是合法的可见性值。
共享用户为空时仅所有者和管理员有权限。

`GET /api/groups/:id/share-candidates` 返回按名称排序的用户名数组（不包含所有者），
仅所有者和管理员可调用。共享允许发现和使用，不赋予管理权限。
组读取响应会隐藏无权访问的服务器；替换服务器列表时保留已有的隐藏条目。
历史组兼容和数据库升级规则见[组管理](/zh/features/group-management)。

### tools



---

### 调用工具

使用给定参数在 MCP 服务器上执行特定工具。

- **端点**: `/api/tools/call/:server`
- **方法**: `POST`
- **参数**:
  - `:server` (字符串, 必需): MCP 服务器的名称。
- **请求正文**:
  ```json
  {
    "toolName": "tool-name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    }
  }
  ```
  - `toolName` (字符串, 必需): 要执行的工具名称。
  - `arguments` (对象, 可选): 传递给工具的参数。默认为空对象。

- **响应**:
  ```json
  {
    "success": true,
    "data": {
      "content": [
        {
          "type": "text",
          "text": "工具执行结果"
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

响应保留 `success` / `data` 包装。`data` 保留工具结果中的字段，包括存在时的 `structuredContent`、`isError` 和 `_meta`，并附带 `toolName` 与类型转换后的 `arguments`。缺少 `content` 时默认返回 `[]`。工具执行失败由 `data.isError: true` 表示；外层的 `success: true` 表示 API 返回了工具结果，并不代表工具执行成功。

**请求示例：**

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

**注意事项：**
- 工具参数会根据工具的输入模式自动转换为适当的类型。
- 如果需要，可以使用 `x-session-id` 请求头在多个工具调用之间维护会话状态。
- 此端点需要身份验证。

---

### 替代方案：OpenAPI 工具执行

有关无需身份验证的 OpenAPI 兼容工具执行，请参阅 [OpenAPI 集成](/api-reference/openapi#tool-execution) 文档。OpenAPI 端点提供：

- **GET** `/api/tools/:serverName/:toolName` - 用于带查询参数的简单工具
- **POST** `/api/tools/:serverName/:toolName` - 用于带 JSON 正文的复杂工具

这些端点专为与 OpenWebUI 和其他 OpenAPI 兼容系统集成而设计。

### prompts







---

### 获取提示词

在 MCP 服务器上执行提示词并获取结果。

- **端点**: `/api/mcp/:serverName/prompts/:promptName`
- **方法**: `POST`
- **身份验证**: 必需
- **参数**:
  - `:serverName` (字符串, 必需): MCP 服务器的名称。
  - `:promptName` (字符串, 必需): 提示词的名称。
- **请求正文**:
  ```json
  {
    "arguments": {
      "arg1": "value1",
      "arg2": "value2"
    }
  }
  ```
  - `arguments` (对象, 可选): 传递给提示词的参数。

- **响应**:
  ```json
  {
    "success": true,
    "data": {
      "messages": [
        {
          "role": "user",
          "content": {
            "type": "text",
            "text": "提示词内容"
          }
        }
      ]
    }
  }
  ```

**请求示例：**

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

### 切换提示词

启用或禁用服务器上的特定提示词。

- **端点**: `/api/servers/:serverName/prompts/:promptName/toggle`
- **方法**: `POST`
- **身份验证**: 必需
- **参数**:
  - `:serverName` (字符串, 必需): 服务器的名称。
  - `:promptName` (字符串, 必需): 提示词的名称。
- **请求正文**:
  ```json
  {
    "enabled": true
  }
  ```
  - `enabled` (布尔值, 必需): `true` 启用提示词, `false` 禁用提示词。

**请求示例：**

```bash
curl -X POST "http://localhost:3000/api/servers/myserver/prompts/code-review/toggle" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"enabled": false}'
```

---

### 更新提示词描述

更新特定提示词的描述。

- **端点**: `/api/servers/:serverName/prompts/:promptName/description`
- **方法**: `PUT`
- **身份验证**: 必需
- **参数**:
  - `:serverName` (字符串, 必需): 服务器的名称。
  - `:promptName` (字符串, 必需): 提示词的名称。
- **请求正文**:
  ```json
  {
    "description": "新的提示词描述"
  }
  ```
  - `description` (字符串, 必需): 提示词的新描述。

**请求示例：**

```bash
curl -X PUT "http://localhost:3000/api/servers/myserver/prompts/code-review/description" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"description": "审查代码的最佳实践和潜在问题"}'
```

**注意**: 提示词是可用于生成标准化请求到 MCP 服务器的模板。它们由 MCP 服务器定义，并且可以具有在执行提示词时填充的参数。

### users













---

### 获取所有用户

检索系统中所有用户的列表。

- **端点**: `/api/users`
- **方法**: `GET`
- **身份验证**: 必需（仅管理员）
- **响应**:
  ```json
  {
    "success": true,
    "data": [
      {
        "username": "admin",
        "role": "admin",
        "servers": ["server1", "server2"],
        "groups": ["group1"]
      },
      {
        "username": "user1",
        "role": "user",
        "servers": ["server1"],
        "groups": []
      }
    ]
  }
  ```

---

### 获取用户

检索特定用户的详细信息。

- **端点**: `/api/users/:username`
- **方法**: `GET`
- **身份验证**: 必需（仅管理员）
- **参数**:
  - `:username` (字符串, 必需): 用户的用户名。
- **响应**:
  ```json
  {
    "success": true,
    "data": {
      "username": "user1",
      "role": "user",
      "servers": ["server1", "server2"],
      "groups": ["group1"]
    }
  }
  ```

---

### 创建用户

在系统中创建新用户。

- **端点**: `/api/users`
- **方法**: `POST`
- **身份验证**: 必需（仅管理员）
- **请求正文**:
  ```json
  {
    "username": "newuser",
    "password": "securepassword",
    "role": "user",
    "servers": ["server1"],
    "groups": ["group1"]
  }
  ```
  - `username` (字符串, 必需): 新用户的用户名。
  - `password` (字符串, 必需): 新用户的密码。至少 6 个字符。
  - `role` (字符串, 可选): 用户的角色。可以是 `"admin"` 或 `"user"`。默认为 `"user"`。
  - `servers` (字符串数组, 可选): 用户可以访问的服务器名称列表。
  - `groups` (字符串数组, 可选): 用户所属的组 ID 列表。

---

### 更新用户

更新现有用户的信息。

- **端点**: `/api/users/:username`
- **方法**: `PUT`
- **身份验证**: 必需（仅管理员）
- **参数**:
  - `:username` (字符串, 必需): 要更新的用户的用户名。
- **请求正文**:
  ```json
  {
    "password": "newpassword",
    "role": "admin",
    "servers": ["server1", "server2", "server3"],
    "groups": ["group1", "group2"]
  }
  ```
  - `password` (字符串, 可选): 用户的新密码。
  - `role` (字符串, 可选): 用户的新角色。
  - `servers` (字符串数组, 可选): 更新的可访问服务器列表。
  - `groups` (字符串数组, 可选): 更新的组列表。

---

### 删除用户

从系统中删除用户。

- **端点**: `/api/users/:username`
- **方法**: `DELETE`
- **身份验证**: 必需（仅管理员）
- **参数**:
  - `:username` (字符串, 必需): 要删除的用户的用户名。

---

### 获取用户统计信息

检索有关用户及其对服务器和组的访问权限的统计信息。

- **端点**: `/api/users-stats`
- **方法**: `GET`
- **身份验证**: 必需（仅管理员）
- **响应**:
  ```json
  {
    "success": true,
    "data": {
      "totalUsers": 5,
      "adminUsers": 1,
      "regularUsers": 4,
      "usersPerServer": {
        "server1": 3,
        "server2": 2
      },
      "usersPerGroup": {
        "group1": 2,
        "group2": 1
      }
    }
  }
  ```

**注意**: 所有用户管理端点都需要管理员身份验证。

### logs







---

### 获取所有日志

检索所有存储的日志。

- **端点**: `/api/logs`
- **方法**: `GET`
- **成功响应**:
  ```json
  {
    "success": true,
    "data": [
      {
        "timestamp": "2023-10-27T10:00:00.000Z",
        "level": "info",
        "message": "服务器成功启动。",
        "service": "system"
      }
    ]
  }
  ```

---

### 清除日志

删除所有存储的日志。

- **端点**: `/api/logs`
- **方法**: `DELETE`
- **成功响应**:
  ```json
  {
    "success": true,
    "message": "日志清除成功"
  }
  ```

---

### 流式传输日志

使用服务器发送事件 (SSE) 实时流式传输日志。连接将保持打开状态，新的日志条目将在发生时发送。

- **端点**: `/api/logs/stream`
- **方法**: `GET`
- **响应格式**: 该流发送带有包含 JSON 对象的 `data` 字段的事件。第一个事件的 `type` 为 `initial`，包含所有历史日志。后续事件的 `type` 为 `log`，包含单个新日志条目。

- **事件示例**:
  ```
  data: {"type":"log","log":{"timestamp":"2023-10-27T10:00:05.000Z","level":"debug","message":"正在处理 /api/some-endpoint 的请求","service":"mcp-server"}}
  ```

### config






---

### 更新系统配置

更新系统配置的各个部分。您只需提供要更新部分的键。

- **端点**: `/api/system-config`
- **方法**: `PUT`
- **正文**: 一个 JSON 对象，包含以下一个或多个顶级键：`routing`、`install`、`smartRouting`、`toolResultCompression`、`mcpRouter`。

### 路由配置 (`routing`)

- `enableGlobalRoute` (boolean): 启用或禁用全局 `/api/mcp` 路由。
- `enableGroupNameRoute` (boolean): 启用或禁用基于群组的路由 (例如 `/api/mcp/group/:groupName`)。
- `enableBearerAuth` (boolean): 为 MCP 端点启用 Bearer 令牌身份验证（默认：`true`）。
- `bearerAuthKey` (string): 旧版 Bearer 密钥（仅用于一次性迁移）。
- `skipAuth` (boolean): 如果为 true，则跳过仪表盘 / Web API 的登录要求，前端可在没有会话令牌的情况下访问 `/api` 路由。未登录的仪表盘用户会被视为内置 `guest` 管理员，因此仅应在受信任环境中启用，但**不会**关闭 MCP 端点认证。

### 安装配置 (`install`)

- `pythonIndexUrl` (string): 用于安装的 Python 包索引 (PyPI) 的基础 URL。
- `npmRegistry` (string): 用于安装的 npm 注册表 URL。
- `baseUrl` (string): 此 MCPHub 实例的公共基础 URL，用于 MCP 请求与 OAuth 回调地址。

### 智能路由配置 (`smartRouting`)

- `enabled` (boolean): 启用或禁用智能路由功能。
- `dbUrl` (string): 用于存储嵌入的数据库连接 URL。
- `llmProviderBaseUrl` (string): 用于生成嵌入的 OpenAI 兼容 API 的基础 URL。
- `llmProviderApiKey` (string): 嵌入服务的 API 密钥。
- `embeddingModel` (string): 要使用的嵌入模型的名称。
- `embeddingDimensions` (number，可选)：对于支持自定义维度的提供方，指定嵌入输出维度；不设置时使用模型默认值。该值同时声明了预期的存储维度，但仅对已知支持 Matryoshka（MRL）表示的模型、或开启 `embeddingDimensionsApiPassthrough` 时，才会作为 `dimensions` 请求参数转发给提供方（issue #1131）。
- `embeddingDimensionsApiPassthrough` (boolean，可选，默认 `false`)：设为 `true` 时，始终将 `embeddingDimensions` 作为 `dimensions` 请求参数转发给提供方。非 MRL 模型/后端（Qwen3-Embedding、BGE、vLLM/sglang 等）会直接拒绝该参数；仅对其它支持 MRL 的模型开启。参见 `EMBEDDING_DIMENSIONS_API_PASSTHROUGH`。

### 工具结果压缩配置 (`toolResultCompression`)

- `enabled` (boolean): 是否对成功的工具结果启用透明压缩。
- `minTokens` (number): 单个文本块达到或超过该估算 token 数时才会压缩。默认值：`2000`。
- `maxOutputTokens` (number): 每个压缩后文本块的目标 token 预算。默认值：`1200`。
- `strategy` (string): 压缩策略。允许值：`auto`、`json`、`log`、`search`、`diff`、`text`。默认值：`auto`。

压缩只作用于成功的工具响应。`isError: true` 的响应和非文本内容块会原样返回。活动日志会在压缩前记录上游原始输出。

### MCP 路由器配置 (`mcpRouter`)

- `apiKey` (string): MCP 路由器服务的 API 密钥。
- `referer` (string): 用于 MCP 路由器请求的 referer 头。
- `title` (string): 在 MCP 路由器上显示的此实例的标题。
- `baseUrl` (string): MCP 路由器 API 的基础 URL。

- **请求示例**:
  ```json
  {
    "routing": {
      "enableBearerAuth": true,
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

### 获取所有设置

检索实例的整个设置对象，包括所有服务器配置、群组和系统设置。这是 `mcp_settings.json` 文件的完整转储。

- **端点**: `/api/settings`
- **方法**: `GET`

---

### 获取运行时配置

检索前端应用程序所需的基本运行时配置。此端点不需要身份验证。

- **端点**: `/config`
- **方法**: `GET`
- **成功响应**:
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

### 获取公共配置

检索公共配置，主要用于检查是否跳过身份验证。这允许前端在用户登录前相应地调整其行为。此端点不需要身份验证。

- **端点**: `/public-config`
- **方法**: `GET`
- **成功响应**:
  ```json
  {
    "success": true,
    "data": {
      "skipAuth": false,
      "permissions": {}
    }
  }
  ```

### system









---

### 健康检查

检查 MCPHub 服务器的健康状态。

- **端点**: `/health`
- **方法**: `GET`
- **身份验证**: 不需要
- **响应**:
  ```json
  {
    "status": "ok",
    "timestamp": "2024-11-12T01:30:00.000Z",
    "uptime": 12345
  }
  ```

**请求示例：**

```bash
curl "http://localhost:3000/health"
```

---

### OAuth 回调

用于处理 OAuth 身份验证流程的 OAuth 回调端点。此端点在用户授权后由 OAuth 提供商自动调用。

- **端点**: `/oauth/callback`
- **方法**: `GET`
- **身份验证**: 不需要（公共回调 URL）
- **查询参数**: 因 OAuth 提供商而异（通常包括 `code`、`state` 等）

**注意**: 此端点由 MCPHub 的 OAuth 集成内部使用，客户端不应直接调用。

---

### 上传 MCPB 文件

上传 MCPB（MCP Bundle）文件以导入服务器配置。

- **端点**: `/api/mcpb/upload`
- **方法**: `POST`
- **身份验证**: 必需（仅限管理员）
- **Content-Type**: `multipart/form-data`
- **正文**:
  - `mcpbFile` (文件, 必需): 要上传的 MCPB 文件。

**安全说明：**

- **仅限管理员**：上传的 bundle 代码会被解压到确定性的 `data/uploads/mcpb/server-<name>` 路径，现有的 stdio 服务器配置会从该路径执行代码，因此非管理员上传会在请求体写入磁盘之前被 `403` 拒绝。
- `manifest.json` 中的 `name` 只能包含字母、数字、`.`、`_` 和 `-`。
- 如果清单名称包含路径分隔符、`..` 或其他不安全的路径字符，上传会被拒绝。

**请求示例：**

```bash
curl -X POST "http://localhost:3000/api/mcpb/upload" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "mcpbFile=@bundle.mcpb"
```

---

### 导出 MCP 设置

将当前 MCP 设置配置导出为 JSON 文件。

- **端点**: `/api/mcp-settings/export`
- **方法**: `GET`
- **身份验证**: 必需
- **响应**: 返回 `mcp_settings.json` 配置文件。

**请求示例：**

```bash
curl "http://localhost:3000/api/mcp-settings/export" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o mcp_settings.json
```

**注意**: 此端点允许您下载 MCP 设置的备份，可用于恢复或迁移您的配置。

### auth









---

### 登录

验证用户身份并返回 JWT 令牌及用户详细信息。

- **端点**: `/api/auth/login`
- **方法**: `POST`
- **正文**:
  - `username` (string, 必填): 用户名。
  - `password` (string, 必填): 用户密码。
- **请求示例**:
  ```json
  {
    "username": "admin",
    "password": "your-admin-password"
  }
  ```
- **成功响应**:
  ```json
  {
    "success": true,
    "message": "登录成功",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "username": "admin",
      "isAdmin": true,
      "permissions": { ... }
    }
  }
  ```

- **已禁用密码登录**：当 Better Auth 的 `disablePasswordLogin` 生效时，该端点返回 `403`，正文为 `{"success": false, "message": "..."}`。参见 [仅允许 SSO 登录](/zh/features/authentication)。

---

### 注册

注册一个普通用户并返回 JWT 令牌。

本地自助注册要求 `systemConfig.auth.allowRegistration: true`（默认关闭）且密码登录可用，否则返回 HTTP 403。新账号始终为普通用户；`isAdmin` 参数不生效。密码至少八位，包含字母、数字和特殊字符。

- **端点**: `/api/auth/register`
- **方法**: `POST`
- **正文**:
  - `username` (string, 必填): 新的用户名。
  - `password` (string, 必填): 新的用户密码（至少八位，包含字母、数字和特殊字符）。
  - 不能申请管理员权限；`isAdmin` 参数会被忽略。
- **请求示例**:
  ```json
  {
    "username": "newuser",
    "password": "Password123!"
  }
  ```
- **成功响应**:
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

### 获取当前用户

检索当前通过身份验证的用户的个人资料。

- **端点**: `/api/auth/user`
- **方法**: `GET`
- **身份验证**: 需要承载令牌 (Bearer Token)。
- **成功响应**:
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

### 更改密码

允许通过身份验证的用户更改其密码。

- **端点**: `/api/auth/change-password`
- **方法**: `POST`
- **身份验证**: 需要承载令牌 (Bearer Token)。
- **正文**:
  - `currentPassword` (string, 必填): 用户的当前密码。
  - `newPassword` (string, 必填): 新的密码 (至少6个字符)。
- **请求示例**:
  ```json
  {
    "currentPassword": "oldpassword",
    "newPassword": "newpassword123"
  }
  ```
- **成功响应**:
  ```json
  {
    "success": true,
    "message": "密码更新成功"
  }
  ```

---

### 社交登录 (Better Auth)

MCPHub 通过集成 [Better Auth](https://www.better-auth.com/) 支持社交登录功能（GitHub, Google 等）。

**前提条件**:
1.  **数据库模式**: 必须配置 `DB_URL` 环境变量（Better Auth 需要 PostgreSQL 进行数据持久化）。
2.  **启动配置**: Better Auth 相关设置只会在启动时读取一次，因此改完后需要重启 MCPHub。
3.  **环境变量**:
  *   **全局**: `BETTER_AUTH_ENABLED`、`BETTER_AUTH_URL`、可选 `BETTER_AUTH_BASE_PATH`、可选 `BETTER_AUTH_TRUSTED_ORIGINS`。
  *   **GitHub**: `BETTER_AUTH_GITHUB_ENABLED`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`。
  *   **Google**: `BETTER_AUTH_GOOGLE_ENABLED`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。
  *   **本地 OIDC**: `BETTER_AUTH_OIDC_ENABLED`、可选 `BETTER_AUTH_OIDC_PROVIDER_ID`、`BETTER_AUTH_OIDC_DISCOVERY_URL`（或兼容别名 `OIDC_DISCOVERY_URL`）、可选 `BETTER_AUTH_OIDC_SCOPES`、可选 `BETTER_AUTH_OIDC_PKCE`、可选 `BETTER_AUTH_OIDC_PROMPT`，以及 `OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`。

非敏感的 Better Auth 配置也可以保存在 `systemConfig.auth.betterAuth` 中，但 `BETTER_AUTH_*` 环境变量会优先覆盖它们。

**端点**:
Better Auth API 挂载在 `${BASE_PATH}${betterAuthConfig.basePath}`。默认路径是 `/api/auth/better`；可以用 `BETTER_AUTH_BASE_PATH` 在启动时覆盖，也可以把 `systemConfig.auth.betterAuth.basePath` 作为后备值。构建回调 URL 时，`BETTER_AUTH_URL` 会优先于 `systemConfig.install.baseUrl` 生效。主要端点包括：

- **发起登录**:
  - `GET /api/auth/better/signIn/social?provider=github`
  - `GET /api/auth/better/signIn/social?provider=google`

- **会话管理**:
  - `GET /api/auth/better/session` (获取当前会话)
  - `POST /api/auth/better/signOut` (登出)

如需完整的端点列表和使用详情，请参阅 [Better Auth API 文档](https://www.better-auth.com/docs)。

**禁用 Better Auth**:

如果未配置 `DB_URL`、设置了 `BETTER_AUTH_ENABLED=false`，或者没有任何提供商在满足凭据条件后真正启用，Better Auth 都会自动禁用。

### openapi

### OpenWebUI 集成的 OpenAPI 生成

MCPHub 现在支持从 MCP 工具生成 OpenAPI 3.0.3 规范，实现与 OpenWebUI 和其他 OpenAPI 兼容系统的无缝集成，无需 MCPO 作为中间代理。

### 功能特性

- ✅ **自动 OpenAPI 生成**：将 MCP 工具转换为 OpenAPI 3.0.3 规范
- ✅ **OpenWebUI 兼容**：无需 MCPO 代理的直接集成
- ✅ **实时工具发现**：动态包含已连接 MCP 服务器的工具
- ✅ **双参数支持**：支持 GET（查询参数）和 POST（JSON 正文）进行工具执行
- ✅ **无需身份验证**：OpenAPI 端点公开，便于集成
- ✅ **完整元数据**：具有适当模式和文档的完整 OpenAPI 规范

### API 端点

### OpenAPI 规范



```bash GET /api/openapi.json
curl "http://localhost:3000/api/openapi.json"
```

```bash GET /api/openapi.yaml
curl "http://localhost:3000/api/openapi.yaml"
```

```bash 带参数
curl "http://localhost:3000/api/openapi.json?title=我的 MCP API&version=2.0.0"
```



生成并返回所有已连接 MCP 工具的完整 OpenAPI 3.0.3 规范。`.json` 和 `.yaml` 版本接受相同的查询参数。

**查询参数：**


  自定义 API 标题



  自定义 API 描述



  自定义 API 版本



  自定义服务器 URL



  包含禁用的工具



  要包含的服务器名称列表（逗号分隔）


### 组/服务器特定的 OpenAPI 规范



```bash GET /api/:name/openapi.json
curl "http://localhost:3000/api/mygroup/openapi.json"
```

```bash GET /api/:name/openapi.yaml
curl "http://localhost:3000/api/mygroup/openapi.yaml"
```

```bash 带参数
curl "http://localhost:3000/api/myserver/openapi.json?title=我的服务器 API&version=1.0.0"
```



为特定组或服务器生成并返回 JSON 或 YAML 格式的 OpenAPI 3.0.3 规范。如果存在具有给定名称的组，则返回该组中所有服务器的规范。否则，将名称视为服务器名称并仅返回该服务器的规范。

**路径参数：**


  组 ID/名称或服务器名称


**查询参数：**

与主 OpenAPI 规范端点相同（title、description、version、serverUrl、includeDisabled）。

### 可用服务器



```bash GET /api/openapi/servers
curl "http://localhost:3000/api/openapi/servers"
```



返回已连接的 MCP 服务器名称列表。

<ResponseExample>

```json 示例响应
{
  "success": true,
  "data": ["amap", "playwright", "slack"]
}
```

</ResponseExample>

### 工具统计



```bash GET /api/openapi/stats
curl "http://localhost:3000/api/openapi/stats"
```



返回有关可用工具和服务器的统计信息。

<ResponseExample>

```json 示例响应
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

### 工具执行



```bash GET /api/tools/{serverName}/{toolName}
curl "http://localhost:3000/api/tools/amap/amap-maps_weather?city=Beijing"
```

```bash POST /api/tools/{serverName}/{toolName}
curl -X POST "http://localhost:3000/api/tools/playwright/playwright-browser_navigate" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```



通过 OpenAPI 兼容端点执行 MCP 工具。

**路径参数：**


  MCP 服务器的名称



  要执行的工具名称


### OpenWebUI 集成

要将 MCPHub 与 OpenWebUI 集成：


  
    确保 MCPHub 正在运行，并且已配置 MCP 服务器
  
  
    ```bash
    curl http://localhost:3000/api/openapi.json > mcphub-api.json
    curl http://localhost:3000/api/openapi.yaml > mcphub-api.yaml
    ```
  
  
    在 OpenWebUI 中导入 OpenAPI 规范文件或直接指向 URL
  


### 配置示例

在 OpenWebUI 中，您可以通过以下方式将 MCPHub 添加为 OpenAPI 工具：

<CardGroup cols={2}>
  
  
</CardGroup>

### 生成的 OpenAPI 结构

生成的 OpenAPI 规范包括：

### 工具转换逻辑

- **简单工具**（≤10 个原始参数）→ 带查询参数的 GET 端点
- **复杂工具**（对象、数组或 >10 个参数）→ 带 JSON 请求正文的 POST 端点
- **所有工具**都包含完整的响应模式和错误处理

### 生成操作示例

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

### 安全性

- 定义了 Bearer 身份验证但不对工具执行端点强制执行
- 支持与各种 OpenAPI 兼容系统的灵活集成

### 相比 MCPO 的优势

<CardGroup cols={2}>
  
  
  
  
</CardGroup>

### 故障排除


  
    确保 MCP 服务器已连接。检查 `/api/openapi/stats` 查看服务器状态。
  

  
    验证工具名称和参数是否与 OpenAPI 规范匹配。检查服务器日志以获取详细信息。
  

  
    确保 MCPHub 可从 OpenWebUI 访问，并且 OpenAPI URL 正确。
  

  
    检查您的 MCP 服务器配置中是否启用了工具。使用 `includeDisabled=true` 查看所有工具。
  


### mcp-http

MCPHub 为您的所有 MCP 服务器提供统一的可流式 HTTP 接口。这使您可以向任何配置的 MCP 服务器发送请求并实时接收响应。

**安全提示**：MCP 端点默认需要身份验证，以避免暴露已连接的工具和数据。若需对 MCP 端点开放匿名访问，请在密钥设置中关闭 **启用 Bearer 认证**。**免登录开关**仅影响仪表盘登录。

### 统一端点

此端点提供对所有已启用的 MCP 服务器的访问。

- **端点**: `http://localhost:3000/mcp`
- **方法**: `POST`

### 特定群组的端点

要定向访问特定的服务器群组，请使用基于群组的 HTTP 端点。

- **端点**: `http://localhost:3000/mcp/{group}`
- **方法**: `POST`
- **参数**:
  - `{group}`: 群组的 ID 或名称。

### 特定服务器的端点

要直接访问单个服务器，请使用特定于服务器的 HTTP 端点。

- **端点**: `http://localhost:3000/mcp/{server}`
- **方法**: `POST`
- **参数**:
  - `{server}`: 服务器的名称。

> **注意**: 如果服务器名称和群组名称相同，则群组将优先。

### 协议兼容矩阵

同一个 `/mcp` URL 同时服务旧版 `2025-11-25` 和新版 `2026-07-28` 客户端。
群组和服务器端点使用相同的协议处理方式。仅将 URL 从 `/sse` 改成 `/mcp`，
不会自动升级客户端的协议版本。

| 行为             | 旧版 HTTP+SSE（`/sse`）        | HTTP `2025-11-25`（`/mcp`）            | HTTP `2026-07-28`（`/mcp`）                            |
| ---------------- | ------------------------------ | -------------------------------------- | ------------------------------------------------------ |
| 支持状态         | 已弃用，仍受支持               | 保留兼容支持                           | 已支持，迁移工作仍在继续                               |
| 启动             | 通过 SSE 传输执行 `initialize` | 通过 Streamable HTTP 执行 `initialize` | 无需 `initialize` 握手，使用 SDK 发现机制              |
| 下游会话         | SSE 连接及会话消息端点         | `Mcp-Session-Id`                       | 不创建下游传输会话                                     |
| 路由请求头       | 使用旧版传输行为               | 使用旧版传输行为                       | `Mcp-Method`；具名调用和资源读取还需 `Mcp-Name`        |
| 有状态工具       | 使用已有会话生命周期           | 使用已有会话生命周期                   | Bearer 认证及显式状态 ID 或 OpenAI 会话元数据          |
| MCP Apps 能力    | 初始化时声明                   | 初始化时声明                           | 每次请求在 `params._meta` 中声明                       |
| 列表缓存提示     | 保留已有旧版响应结构           | 保留已有旧版响应结构                   | 上游剩余 TTL，最长 5 秒，私有；否则为零                |
| 资源读取缓存提示 | 保留已有上游提示               | 保留已有上游提示                       | 有效的上游剩余 TTL，范围收紧为 `private`；其他情况为零 |

MCP Apps 透传还取决于请求路由和可见的上游服务器；`$smart` 路由仍按普通 MCP
路由处理。参见 [MCP Apps](/zh/features/mcp-apps)。上游 Streamable HTTP 默认自动协商：先探测 `server/discover`，支持时使用
`2026-07-28` 无状态 HTTP，否则按 SDK 规则回退旧版握手。
上下游协议互相独立。服务器配置中的 `protocolNegotiation: "legacy"` 可跳过探测。
stdio 和旧 SSE 上游继续使用旧版协商。

| 上游行为                       | 新版 Streamable HTTP                        | 旧版上游                           |
| ------------------------------ | ------------------------------------------- | ---------------------------------- |
| 建立连接                       | `server/discover`，无传输 session 和 GET 流 | `initialize`，保留现有传输生命周期 |
| 列表更新                       | 原始上游 TTL 到期后按需刷新，合并并发刷新   | 保留列表变更通知                   |
| TTL 缺失、为零或列表分页未完成 | 下一次相关请求重新获取                      | 保留现有发现行为                   |
| 健康检查（需启用）             | 发起网络 `server/discover`，不依赖工具能力  | `ping`，保留方法不存在时的回退     |
| 启用 elicitation 的隔离连接    | relay 仍依赖旧版请求，因此继续使用旧版协商  | 保留现有转发支持                   |

工具调用、prompt 获取和资源读取之前也会重验证对应列表，使新增和删除项及时影响路由。
资源模板按需获取。刷新失败只在当前请求中排除该上游，健康上游和内置内容仍可用；
部分列表返回零 TTL，后续请求会重试失败的上游。
不增加后台轮询；没有相关请求时不会刷新列表。共享列表刷新后若发生变化，会通知已连接的
旧版下游客户端；个人列表仍限定在各自运行时中。上游发现继续保留单页行为，带
`nextCursor` 的响应不提供正 TTL。

配置 `passthroughHeaders` 的新版上游使用请求内独立客户端和快照，即使 TTL 为正或请求头
缺失，也不跨请求共享列表或刷新任务。每次相关请求增加一次 discovery 往返；个性化快照
不更新全局描述、向量索引或列表变更广播。

自动协商不意味着所有错误都回退：HTTP 探测超时、网络故障和认证错误可能导致连接失败。
详见[上游协议协商配置](/zh/configuration/mcp-settings#上游协议协商)。

### Elicitation 转发

旧协议客户端调用工具时，若上游服务器启用了 `perSessionClient: true`，MCPHub 会转发
form 和 URL 模式的 `elicitation/create` 请求。独立连接只声明下游客户端支持的模式；
旧式空能力 `elicitation: {}` 仅表示支持 form。accept、decline 和 cancel 响应原样返回
上游，URL 完成通知仅发送给所属下游会话。普通工具调用和智能路由的 `call_tool` 均支持。

旧协议没有可移植的父调用标识，因此同一会话内、启用 elicitation 的上游连接会串行执行
工具调用；不同会话使用不同连接。取消调用、结束会话或超时会中止等待中的交互。请求
抛出异常时会丢弃上游连接，不自动重放调用；下次调用重新连接，上游会话状态需要重新
建立。正常返回的 `isError` 工具响应仍按原样交付。

首期不支持共享上游连接、个人凭据/OAuth 运行时、提示词或资源操作，也不支持新版
`2026-07-28` 多轮 elicitation；这些路径不会声明 elicitation 能力。
新版客户端即使携带 `X-MCPHub-State-Id` 也不会启用 elicitation。

form 模式用于普通结构化输入。密码、API Key 和访问令牌必须使用 URL 模式，在上游
服务页面收集，不能通过 MCP 表单传递。交互界面由连接的 MCP 客户端提供，MCPHub
不会新增控制台输入弹窗。

### 客户端迁移

1. 将旧 SSE 客户端传输改为 HTTP 传输，将 `/sse` 改为 `/mcp`，保留原有群组、
   服务器或用户路由范围，以及 Bearer 凭据。旧版 HTTP 客户端可以先完成传输迁移，
   继续使用原有初始化和会话生命周期。
2. 要采用 `2026-07-28`，需使用支持新版 HTTP 发现机制及逐请求元数据的客户端。
   SDK v2 HTTP 客户端会自动设置协议和路由请求头。自定义客户端需发送常规
   JSON-RPC 请求体，将 `params._meta["io.modelcontextprotocol/protocolVersion"]`
   设为 `2026-07-28`，并在
   `params._meta["io.modelcontextprotocol/clientCapabilities"]` 中声明客户端能力。
   同时发送一致的 `MCP-Protocol-Version` 和 `Mcp-Method` 请求头；`tools/call`
   和 `prompts/get` 需要与 `params.name` 一致的 `Mcp-Name`，`resources/read`
   则需要与 `params.uri` 一致。工具名称应使用该路由列表响应中的名称。
3. 使用 `perSessionClient` 或 OpenAPI `cookieSession` 工具时，为每个独立工作流
   生成 UUID v4，并通过工具调用的 `X-MCPHub-State-Id` 请求头发送。无法设置该
   扩展的已认证 OpenAI/ChatGPT 工具调用，在显式请求头缺失时也可复用客户端声明的
   `_meta["openai/session"]` 会话提示。MCPHub 会先对该提示做哈希；它只用于状态
   关联，不用于认证。显式状态请求头一旦存在但非法，将直接失败而不会回退。无状态
   工具无需这两个值。只有相同 Bearer 凭据、用户和路由才能复用状态。状态仅保存在
   当前进程中，闲置 30 分钟后过期，多副本部署需要粘性路由。进程重启、状态过期或
   凭据、路由变化后需要重新建立应用状态。参见
   [显式状态配置](/zh/configuration/mcp-settings#mcp-2026-07-28-的有状态工具)。
4. 使用实际权限验证工具列表和调用，再验证所用的资源读取及 MCP Apps 功能。
   新版 Apps 宿主需在每次请求中声明 UI 能力。新版调用不依赖 `Mcp-Session-Id`
   或 `enableSessionRebuild`，这两者仍属于旧版机制。

### 缓存行为

现代列表把上游发现快照与实时配置、权限和每次请求的客户端能力组合起来。
正向提示始终为私有，取所有上游剩余新鲜时间的最小值，并受最长 5 秒的投影
窗口限制。保留发现快照的年龄，重复网关列表请求不会续期；空上游列表也参与
计算。缺失／无效 TTL、未完整分页、失败或不完整的发现、网关生成的智能路由
条目、内置提示词／资源，以及无法确定新鲜度的托管权限均使用零 TTL。

每个请求重新生成投影。投影期间检测到配置、成员、权限或运行时变更时归零。
列表刷新在等待新响应之前撤销旧快照的新鲜度；失败、断连或替换不能建立新的
新鲜度。资源模板列表使用该请求实际获取的响应。不增加网关响应缓存。

本地配置／权限改变后，客户端可能继续保留已获得的列表最多 5 秒，服务端失效
不能撤回客户端缓存。缓存必须按端点、认证身份和每次请求的客户端能力隔离。
缓存列表不代表调用权限：MCPHub 在每个请求上重新检查访问权。上游无法提供
可信新鲜度时使用零 TTL。

现代资源读取仍绕过 SDK 响应缓存，从有效上游 TTL 扣除处理耗时，并限制为
请求认证上下文内的私有共享。缺失／无效 TTL、内置资源和网关生成的读取错误
均使用零。旧版响应形状和会话行为保持不变。

### 旧版 SSE 弃用计划

公开通知随包含本计划的下一次版本发布。发布说明必须记录实际通知日期
**N** 和最早可移除日期 **N 加 12 个日历月**。本页面和 ADR 不构成更早的
通知日期。在该发布说明发布之前，通知日期和移除日期均未公布。

计划在达到上述日期且满足下方迁移就绪条件后的第一个主版本中移除 SSE。
条件未满足时延后移除并公布调整后的目标，不缩短通知窗口。至少提前 90 天
公布确切的目标版本和日期，提前 30 天再次提醒，每次公告附迁移说明。
实际移除必须通过独立代码评审。

### 保留路由范围和认证

部署配置了基础路径时，为下表所有 URL 加上该前缀。建议使用分组 ID；
保留原来的路由标识以及 bearer 请求头名称和值。分组名与服务器名相同时，
分组优先。

| 原 SSE 连接            | Streamable HTTP 替代地址 | 将退役的 SSE 消息端点 |
| ---------------------- | ------------------------ | --------------------- |
| `/sse`                 | `/mcp`                   | `/messages`           |
| `/sse/{group}`         | `/mcp/{group}`           | `/messages`           |
| `/sse/{server}`        | `/mcp/{server}`          | `/messages`           |
| `/{user}/sse`          | `/{user}/mcp`            | `/{user}/messages`    |
| `/{user}/sse/{group}`  | `/{user}/mcp/{group}`    | `/{user}/messages`    |
| `/{user}/sse/{server}` | `/{user}/mcp/{server}`   | `/{user}/messages`    |

同时保留 `$smart/{group}` 等智能路由后缀。SSE 客户端使用服务端公布的
消息 URL 和会话查询参数；不要把消息 URL 转换成 HTTP 新端点。替换连接
URL，让 HTTP transport 管理后续请求。

先独立迁移传输方式，再考虑升级协议。例如使用旧版 TypeScript SDK
（`@modelcontextprotocol/sdk` 1.29.0，与 MCPHub 独立兼容性测试一致）：

```typescript
const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://hub.example.com/alice/mcp/my-group-id'), {
    requestInit: { headers: { Authorization: 'Bearer YOUR_EXISTING_KEY' } },
  }),
);
const tools = await client.listTools();
// 使用返回的工具名；在整个工作流中复用此客户端。
await client.close();
```

此迁移保留旧版初始化和 `Mcp-Session-Id` 生命周期。有状态工具仍按会话
隔离，单纯迁移传输方式不需要 `X-MCPHub-State-Id`。现代协议发现和显式
状态是上文描述的独立升级。SSE 会话 ID 不能跨传输方式复用：建立新的
HTTP 工作流，重新执行登录或工具初始化。

### 就绪条件和移除边界

公布确切移除目标之前，维护者必须记录：

- 包含公开通知的版本、实际发布日期，以及移除时已满 12 个日历月的依据。
- 整个窗口内旧版 SSE 和 Streamable HTTP 兼容性测试持续通过，覆盖认证后的
  全局、分组、服务器和用户路由，会话续接／重建及有状态工具隔离。
- 每个文档列出的客户端集成的迁移清单：HTTP transport、保留路由／认证、
  列表和调用成功，以及实际使用的资源、Apps 或有状态工作流。记录测试版本
  和未解决阻碍；阻碍发布的迁移缺陷必须为零。可补充部署者确认，不能把
  缺少遥测当作无人使用 SSE 的证据。
- 中英双语发布说明和文档、提前 90 天和 30 天的提醒，以及仍使用 SSE 的
  部署的支持渠道。

移除清单仅包括 SSE GET 路由、对应 POST 消息路由、`handleSseConnection`、
`handleSseMessage`、SSE transport 创建以及 SSE 专用测试／导入。删除共享
辅助函数前必须检查所有调用方。保留 `/mcp` POST/GET/DELETE、旧版 HTTP
初始化、会话映射与清理、创建／重建锁、bearer／分组认证、`perSessionClient`
隔离、OpenAPI cookie jar 和现代显式状态。`server-legacy` 还提供共享的
旧版 HTTP／OAuth 功能，不能仅因 SSE 退役就删除该依赖。

本计划由 [#1272](https://github.com/samanhappy/mcphub/issues/1272) 跟踪。
发布通知的版本必须建立独立移除任务，记录实际日期、客户端清单和删除清单。
旧版 `2025-11-25` Streamable HTTP 支持独立保留。

### mcp-sse

旧版 HTTP+SSE 端点已弃用，但迁移期间仍受支持。新接入请使用 [MCP HTTP 端点与迁移指南](/zh/api-reference/mcp-http)。目前尚未公布移除版本或日期。

分阶段升级 ADR 要求至少 12 个月的弃用窗口。移除前需要公布时间计划并验证迁移路径。这不代表弃用旧版 `2025-11-25` HTTP 客户端的会话生命周期：旧版和新版 HTTP 继续受支持。

**安全提示**：MCP 端点默认需要身份验证，以避免暴露已连接的工具和数据。若需对 MCP 端点开放匿名访问，请在密钥设置中关闭 **启用 Bearer 认证**。**免登录开关**仅影响仪表盘登录。

### 统一端点

- **端点**: `http://localhost:3000/sse`
- **方法**: `GET`

### 特定群组的端点

- **端点**: `http://localhost:3000/sse/{group}`
- **方法**: `GET`
- **参数**:
  - `{group}`: 群组的 ID 或名称。

### 特定服务器的端点

- **端点**: `http://localhost:3000/sse/{server}`
- **方法**: `GET`
- **参数**:
  - `{server}`: 服务器的名称。

### smart-routing

智能路由是 MCPHub 的智能工具发现系统，它使用向量语义搜索来自动为任何给定任务找到最相关的工具。

### HTTP 端点

- **端点**: `http://localhost:3000/mcp/$smart`
- **方法**: `POST`

### SSE 端点 (已弃用)

- **端点**: `http://localhost:3000/sse/$smart`
- **方法**: `GET`

### 工作原理

1.  **工具索引**: 所有 MCP 工具都会自动转换为向量嵌入并存储在带有 pgvector 的 PostgreSQL 中。
2.  **语义搜索**: 用户查询被转换为向量，并使用余弦相似度与工具嵌入进行匹配。
3.  **智能过滤**: 动态阈值可确保相关结果而无噪音。
4.  **精确执行**: 找到的工具可以通过适当的参数验证直接执行。

### 设置要求

- 带有 pgvector 扩展的 PostgreSQL
- OpenAI API 密钥（或兼容的嵌入服务）
- 在 MCPHub 设置中启用智能路由

### 诊断与维护 API

以下管理端点位于已认证的 Dashboard API 下，与其它 `/api/*` 路由一样，需要有效的 Dashboard 会话（JWT）或系统级 All-Access Bearer Key（`Authorization: Bearer mcphub_...`）。两个端点还额外**仅限管理员**：已认证但非管理员的身份会收到 `403 Admin privileges required`。

### 索引状态与性能

返回智能路由配置、数据库连接状态、向量库规模（tool/server 行数、去重服务器数、维度）、按模型/按服务器的统计、同步新鲜度以及索引覆盖率。

```bash
curl http://localhost:3000/api/smart-routing/performance \
  -H "Authorization: Bearer YOUR_JWT_OR_BEARER_KEY"
```

### 重新索引

全量强制重建向量索引：先清空 `vector_embeddings`，再对全部已启用服务器重新生成嵌入。同步执行并返回汇总；重建进度会通过 SSE `embedding-sync-progress` 事件实时推送。

需要**个人凭据**（`credentialTemplate`）的服务器不会参与全局连接，因此会以已绑定凭据的用户身份（服务器所有者优先）建立连接，并把这些用户可见工具的**并集**写入索引；没有任何用户绑定凭据的服务器会被跳过，并在响应的 `results` 中给出原因。

同一时间只允许一次重建：若已有重建在执行，新的调用会收到 `409 A reindex pass is already running`。`GET /api/smart-routing/performance` 的返回中通过 `reindexing` 暴露同一状态，前端可据此在执行期间禁用按钮。

```bash
curl -X POST http://localhost:3000/api/smart-routing/reindex \
  -H "Authorization: Bearer YOUR_JWT_OR_BEARER_KEY"
```

## 共享 TypeScript 数据类型

可选字段用 ? 标记；类型声明不能代替 handler 的权限与字段验证。

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
