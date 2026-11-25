# MCPHub 节点互联 — 需求背景、接口契约与分工

状态：执行稿（2026-11-25）
范围：**只改 MCPHub（本仓库）**。v-harness、V-Scheduler 不在范围内。
负责人：主 Agent（契约冻结、冲突裁决、最终验收）
执行方：三个并行 Agent（A / B / C），文件边界互斥
交付物：本文档。文中代码块是**参考实现示例**（§3.8），用于说明调用方式与字段来源，不是最终代码

---

## 1. 需求背景

### 1.1 现在是什么状态

每个 VOS 节点上都跑着一个 MCPHub。它是这台机器上 MCP 服务的注册中心与连接器：

- MCP 服务在这里登记（`amap`、`gitea`、`playwright` 这类），可以是本地子进程（`stdio`）、也可以是远端地址（`sse` / `streamable-http`）；
- Agent 通过 MCPHub 看到工具列表、调用工具；
- MCPHub 知道每个服务的连接状态、类型、配置，也保存了各自的诊断输出（stdio 的 stderr 已被捕获，见 `src/services/mcpService.ts:2063-2071`）。

**但每台节点的 MCPHub 只认识自己。**

### 1.2 由此产生的三个具体问题

**问题一：A 节点看不到 B 节点有什么服务**

运维在 A 上想知道“B 那台机器现在能提供哪些工具”，今天没有任何办法：MCPHub 的 `/api/servers` 只返回本机注册表。要么登到 B 上打开它的界面，要么靠记忆。

**问题二：想用 B 的服务，只能手工在 A 上再配一遍**

要在 A 的 Agent 里调 B 上的 `playwright`，必须在 A 的 MCPHub 里手填一条远端绑定：地址、transport、headers。地址一变、B 一换机器，这条配置就废了；而且 A 上这份配置和 B 上那份没有任何关联，谁也不知道两边是否一致。

**问题三：B 的服务出问题，只能登到 B 上处理**

某个服务开始报错、卡死、或者就是要临时下线，今天的动作是：登录 B → 打开 MCPHub → 停掉它。全程手动，且 A 侧对此一无所知——A 的 Agent 还在照常调用，一直失败。

### 1.3 我们要的

让 MCPHub 之间可以互相问一句话、下一条指令：

1. **可见**：A 能拿到 B 的 MCP 服务清单（名字、类型、状态、地址）。
2. **可控（软）**：A 能让某个服务在**自己这边**接上或摘掉；摘掉之后 A 的 Agent 不再看到它，B 上的进程不受影响。
3. **可迁移**：把 A 上的服务定义导出，交给 B 导入并启用；定义等价、地址由 B 侧给出。
4. **可取证**：A 能读到 B 上这个服务的诊断输出（MCPHub 已记录的那部分）。

一句话：**把“每台机器一个孤岛”，变成“可以互相托管的注册中心”，但只在连接层面，不动进程。**

### 1.4 为什么是“软”的（这条必须在实现时守住）

| 今天能做的（本方案） | 明确不做的 |
|---|---|
| 断开连接 → 从列表消失、Agent 不再可见 | 杀进程、`docker stop`、`rm` 容器 |
| 重新连接 → 恢复可见；连不上如实报不可达 | 起容器、挂 `/var/run/docker.sock` |
| 导出/导入定义 → 服务换一台机器跑 | 删除服务定义、清空数据 |

不做的理由不是“做不了”，而是**代价与收益不成比例**：

- 要真正启停容器，MCPHub 必须拿到宿主机的 Docker socket，那等于把整台机器的 root 交给一个会被 Agent 调用的进程；
- “服务卡死”这类故障，正确答案是服务自己保活，而不是让注册中心去当 supervisor；
- 而 90% 的运维诉求（“先别让 Agent 用它了”“换台机器重来一遍”）用软模型就能满足。

### 1.5 边界

- 鉴权不用 VOS token：那是人的凭据，1 小时过期、带超管权限、撤销影响面大。用一条**仅限节点间使用的 token**，并限定它能触发哪些动作。
- 只新增接口，不改任何既有路径与语义，现有 Agent 工具与界面照旧工作。

---

## 2. 名词

| 名词 | 含义 |
|---|---|
| node token | 节点之间互相调用用的凭据，`Authorization: Bearer <nodeToken>` |
| 软停止 | 断开连接，对端服务继续存活 |
| 定义（definition） | 一个 MCP 服务的可移植描述：stdio 为 `command/args/env`，http 型为 `url/headers/transport` |
| 对端 | 调用方 MCPHub 眼中的另一台节点 |

---

## 3. 实现方案

### 3.1 总体结构

一条通道（`/node-ops`）+ 七个动作，全部落在 MCPHub 仓库内，**不新增状态机、不碰容器、不引入 SSH**。每个动作直接复用仓库现有函数：

| 需求 | 接口 | 底层复用 |
|---|---|---|
| 可见：拿到对端清单 | `GET /node-ops/servers` | `getServerDao().findAll()` + `getServersInfo()` |
| 可控：在对端接上/摘掉 | `POST /node-ops/servers/:name/enable` / `disable` | `toggleServerStatus(name, bool)` + 三个 `broadcast*` |
| 可迁移：导出 / 导入 | `GET /node-ops/servers/:name/definition` / `POST /node-ops/servers` | `presentServerForPrincipal` / `addServer` + `normalizeServerConfigForPersistence` + `notifyToolChanged` |
| 可取证：读诊断输出 | `GET /node-ops/servers/:name/logs?tail=` | `logService.getLogs()` 按 serverName 过滤 |
| 对端地址与身份 | `GET /node-ops/health` | `config.mcpHubVersion` / `config.basePath` / `config.port` |

节点清单本身**不由本方案实现**：仓库已有 `discoverNodesFromScheduler`（`src/services/remoteNodeService.ts`，读 `/scheduler/api/v1/nodes`），继续用它；`/node-ops` 只回答"我这台机器有什么"。

### 3.2 挂载与路由

```
http://<host>:<port><BASE_PATH>/node-ops/...
例：http://10.0.0.21:31888/app/com.ictrek.mcphub/node-ops/servers
```

- 在 `src/routes/index.ts` 的 `initRoutes(app)` 内追加 `app.get/post(`${config.basePath}/node-ops/...`, nodeOpsRateLimiter, requireNodeToken(...), handler)`。
- **不挂到 `authenticatedRouter`，不进 `${BASE_PATH}/api`**：`${BASE_PATH}/api` 在 `src/middlewares/index.ts:106` 被全局 `auth` 整段接管，node token 的中间件在那里永远执行不到。
- 顺序安全：SPA 通配 `${BASE_PATH}/*` 在 `findAndServeFrontend()` 里注册，晚于 `initRoutes`（`src/server.ts:136-137` 与 `:237-253`）；`/:user/mcp`、`/:user/sse` 不匹配 `/node-ops/...`。
- 副本模式下 `replicaRequestContext` 是 app 级中间件（`src/server.ts:71`），drain 时的 503 自动生效，无需额外处理。
- 控制面加密（mTLS 端口、证书、环境变量、拒绝行为）见 §4「Agent A · A-2」；默认 `MCP_NODE_OPS_REQUIRE_TLS=true`，HTTP 端口上的 `/node-ops` 一律 403。

#### 3.2.1 跨节点连通性（部署侧要求，代码不解决）

两个节点的 MCPHub 要互相调用，**被调用方的容器端口必须从调用方可达**。这件事不由本方案的代码解决，但必须写清楚，否则接口写对了也连不上：

| 部署形态 | 对端 URL | 说明 |
|---|---|---|
| 容器端口已发布到宿主机 | `http://<节点host>:<宿主端口><BASE_PATH>/node-ops` | 最常见。宿主端口由部署决定，**不是固定的 3000** |
| 同一台宿主机 / 同一 docker 网络 | `http://<容器别名>:3000<BASE_PATH>/node-ops` | 例如 v-harness 现在就是这么访问 mcphub 的 |
| 节点自带网关（Traefik/反代）按路径转发 | `http://<节点host>:<网关端口><BASE_PATH>/node-ops` | 不需要额外发布容器端口，路径保持 `<BASE_PATH>/node-ops` |

URL 的三段来源分开看，不要混：

| 段 | 来源 |
|---|---|
| 节点 host | V-Scheduler 的节点清单（mcphub 已有 `discoverNodesFromScheduler`，取 `address \|\| hostname \|\| host`） |
| 入口端口 / 路径前缀 | 部署侧（宿主端口映射、或节点网关的路由规则） |
| `<BASE_PATH>` | 被调用方自己回报：`GET /node-ops/health` 的 `basePath` |

实测对照（本机两个 MCPHub 容器并存）：

```
...-mcphub-amd-without-cuda-1   0.0.0.0:31888->3000/tcp   ← 跨节点可达：http://<host>:31888/app/com.ictrek.mcphub
...-mcphub-amd-without-cuda-1   3000/tcp                  ← 未发布，跨节点不可达，只能走容器别名 mcphub:3000
```

因此"`http://<节点>:3000`"这一种写法必然有一半节点打不通；**端口必须来自部署记录，不能从节点地址推导**。

调用方自检（在 A 上执行，`B` 换成对端地址）：

```bash
# 期望 401 + {"code":"node-token-missing"}：链路和挂载都通了
curl -s -w '\n%{http_code}\n' "http://$B/app/com.ictrek.mcphub/node-ops/health"

# 期望 200：token 与动作都对
curl -s -H "Authorization: Bearer $TOKEN" "http://$B/app/com.ictrek.mcphub/node-ops/health"
```

判读方式：`connection refused` / 超时 = 端口没发布或被防火墙挡；返回 HTML = 打到了别的服务（端口被占用）；401 且带 `code` = 链路正常，剩下只是凭据问题。

### 3.3 鉴权

token 只从环境变量读取（配置文件这条路走不通，见 §8 第 2 条）：

```bash
MCP_NODE_TOKENS='[
  {"name":"node-a","token":"<>=32 字符随机串","actions":["read","logs","definition","control","import"],"scope":"admin"},
  {"name":"node-c","token":"<32+ 字符>","actions":["read"],"scope":"node"}
]'
```

- 启动时解析校验：必须是 JSON 数组；`name` 唯一且匹配 `^[A-Za-z0-9._:-]{1,64}$`；`token` 长度 ≥ 32 且无空白；`actions` ⊆ 6 个已知动作；`scope` ∈ `node|admin`（缺省 `node`）。
- 校验失败：**整表作废 + 打一条不含 token 值的错误日志**，不阻塞进程启动，所有 `/node-ops` 请求返回 401。
- 内存只保留 `sha256(token)`，用 `crypto.timingSafeEqual` 比较。
- token 不写日志、不进响应、不进审计。
- 轮转 = 改环境变量后重启；吊销 = 从数组移除。

动作集合（最小授权）：

| action | 允许 |
|---|---|
| `read` | 看服务清单 |
| `logs` | 读某服务的诊断输出 |
| `definition` | 导出服务定义（含 env/headers 等密钥，必须单独授权） |
| `control` | enable / disable 服务 |
| `import` | 导入非 stdio 定义 |
| `import-stdio` | 导入 stdio 定义（等于允许在目标节点跑命令，必须单独授权） |

`GET /health` 只要 token 有效即可，不占 action。

peer 身份：`principal = { username: peer.name, userGroups: [], isAdmin: peer.scope === 'admin' }`，之后所有可见性/归属判断都复用它，不另写一套规则。

### 3.4 接口

统一响应：成功 `{ success: true, data: … }`；失败 `{ success: false, code, message }`（`code` 必填，用于区分"自己拒的 401"和"全局 auth 拒的 401"）。

#### (1) `GET /node-ops/health`

```json
{ "success": true, "data": {
  "name": "node-b-mcphub", "version": "1.9.4", "uptimeSeconds": 81234,
  "basePath": "/app/com.ictrek.mcphub", "port": 3000,
  "capabilities": ["read","logs","definition","control","import"]
} }
```

- `name` = `process.env.MCPHUB_NODE_NAME || os.hostname()`
- `version` = `config.mcpHubVersion`（已有 `getPackageVersion()`，不要自己读 package.json）
- `basePath` / `port` 来自 `config.basePath` / `Number(config.port)`：给调用方拼对端 URL 用，省掉两次猜测
- `capabilities` = 本 token 的 actions

#### (2) `GET /node-ops/servers` — 需 `read`

```json
{ "success": true, "data": { "truncated": false, "servers": [
  { "name":"playwright","type":"stdio","enabled":true,"status":"connected",
    "owner":"admin","visibility":"private","description":"浏览器自动化" },
  { "name":"gitea","type":"streamable-http","enabled":true,"status":"connected",
    "owner":"admin","visibility":"public","endpoint":"http://10.0.0.9:8080/mcp/gitea" }
] } }
```

- 配置来自 `getServerDao().findAll()`，状态来自 `getServersInfo()` 的 name→status 映射。
- 输出前先过 `dataService.filterData(records, principal)`，保证 peer 只看到它有权看到的服务。
- `status` ∈ `connected | connecting | disconnected | oauth_required`；`enabled` 取自持久化配置。
- `endpoint` 仅当 token 含 `definition` **且** 该服务 `server.config.read` 通过时输出（HTTP 类才有）；否则字段省略。
- 上限 500 条，超出 `truncated: true`。

#### (3) `GET /node-ops/servers/:name/logs?tail=200` — 需 `logs`，且该服务 `server.discover` 通过

```json
{ "success": true, "data": {
  "text": "[2026-11-25T11:20:03.114+08:00] [ERROR] [main] Upstream server stderr {\"serverName\":\"playwright\",\"message\":\"…\"}",
  "truncated": true, "matched": 37, "partial": true } }
```

- `tail` 1..2000，缺省 200，越界 400 `invalid-tail`。
- 过滤算法（写死，避免各自发挥）：逆序扫描 `logService.getLogs()`，保留满足任一条件的记录：
  `entry.source === name` 或 `entry.message.includes('"serverName":"' + name + '"')` 或 `entry.message.includes("serverName: '" + name + "'")`；取最后 `tail` 条。
- 每行格式 `[ts] [LEVEL] [source] message`。
- `matched` = 过滤后总条数；`matched: 0` 时 `text` 为空串，**仍然 200**。`partial: true` 恒为 true，表示这是运行日志的子集（MCPHub 只记录经过自己的那部分），不是采集器。

#### (4) `GET /node-ops/servers/:name/definition` — 需 `definition`，且 `server.config.read` 通过

```json
{ "success": true, "data": { "name": "playwright", "definition": {
  "type": "stdio", "command": "npx", "args": ["-y","@playwright/mcp"],
  "env": {"PLAYWRIGHT_BROWSERS_PATH":"/ms-playwright"}, "description": "浏览器自动化"
} } }
```

- 取 `getServerDao().findById()` 的持久化配置，先过 `presentServerForPrincipal(config, principal)`；**视图不是 `full` 一律 403**（`node-scope-forbidden`），不自行脱敏。
- 字段白名单（其余剔除）：`type, url, command, args, env, headers, passthroughHeaders, description, protocolNegotiation, enableKeepAlive, keepAliveInterval, startOnDemand, idleTimeoutMs, options, openapi, tools, prompts, resources`。
- 明确排除：`oauth`（含 accessToken/refreshToken/clientSecret）、`credentialTemplate`、`proxy`、`id`、`owner`、`visibility`、`sharedWithUsers/Groups`、`nodeId/Name/Profile`。
- **不展开环境变量**：`${VAR}` 原样搬运，由目标节点自行展开，避免把本机密钥带到别处。
- 每次导出写一条审计（这是密钥外带动作）。

#### (5) `POST /node-ops/servers/:name/enable` — 需 `control`，且 `server.manage` 通过

```json
{ "success": true, "data": { "name":"playwright", "enabled": true, "status": "connecting" } }
```

- 实现：`toggleServerStatus(name, true)`，再从 `getServersInfo()` 取真实 `status` 返回；**不硬编码 `connected: true`**。
- `oauth_required` 属业务状态，返回 200，由调用方决定下一步。
- 幂等：对已启用的服务重复调用返回 200 + 当前状态。

#### (6) `POST /node-ops/servers/:name/disable` — 需 `control`，且 `server.manage` 通过

```json
{ "success": true, "data": { "name":"playwright", "enabled": false, "status": "disconnected" } }
```

- 实现：`toggleServerStatus(name, false)` + `broadcastToolListChanged()` / `broadcastPromptListChanged()` / `broadcastResourceListChanged()`（照 `serverController.ts:1514-1518`，缺一不可）。
- stdio 服务会因此停止本地子进程，这是 MCPHub 既有语义；接口不承诺"上游仍活着"，文档与界面文案都不要这么写。
- 幂等：对已停用的服务重复调用返回 200 + `disconnected`。

#### (7) `POST /node-ops/servers` — 需 `import`（stdio 另需 `import-stdio`）

```json
{ "name": "playwright",
  "definition": { "type":"stdio", "command":"npx", "args":["-y","@playwright/mcp"], "env":{...} },
  "enable": true, "owner": "node-a", "visibility": "public" }
```

```json
{ "success": true, "data": { "name":"playwright", "created": true, "enabled": true, "status": "connecting" } }
```

规则：

- 请求体 ≤ 256 KB（`Buffer.byteLength(JSON.stringify(definition))`，给 openapi schema 留量），超限 400 `definition-too-large`。
- `name` 必填（导出端就带这个名字，两边必须一致），`^[\w.$~%-]{1,128}$`（与 `remoteServerBindingService.NAME_PATTERN` 一致）。
- `definition.type` ∈ `sse | streamable-http | openapi`；`stdio` 必须 `import-stdio`，否则 403 `stdio-import-forbidden`。
- `definition` 内出现 `oauth` / `credentialTemplate` / `proxy` / `id` / `owner` / `visibility` / `nodeId` 任一键 → 400 `invalid-definition`（禁止借导入伪造归属或夹带 OAuth 令牌）。
- 必填校验与 `serverController.createServer`（`:640-730`）同构：type 枚举、http 类必须有 `url`、stdio 必须有 `command`、openapi 必须有 `openapi.url|schema`、`headers` 不得用于 stdio。
- 重名：先 `findById` 预检 → 409 `server-duplicate`；并发窗口内 `addServer` 失败 → 400 `invalid-definition` 并附原文，不吞错、不重试。
- 写入：`normalizeServerConfigForPersistence(definition)` → `addServer(name, config)`。
- 之后：`enable !== false` 时 `toggleServerStatus(name, true)`；无论启停都 `notifyToolChanged(name, { reportEmbeddingProgress: true }).catch(logger.error)`。
- 归属：`owner` 缺省 = peer 名；`visibility` 缺省 `public`（迁移就是为了让目标节点的用户用上它），只接受 `public|private|group`。

### 3.5 权限矩阵与错误码

| 接口 | action | 追加校验 |
|---|---|---|
| `GET /health` | —（有效 token） | — |
| `GET /servers` | `read` | `filterData(principal)` |
| `GET /servers/:name/logs` | `logs` | `server.discover` |
| `GET /servers/:name/definition` | `definition` | `server.config.read`（full 视图） |
| `POST /servers/:name/enable` | `control` | `server.manage` |
| `POST /servers/:name/disable` | `control` | `server.manage` |
| `POST /servers` | `import`（stdio 加 `import-stdio`） | 名称/字段/体积校验 |

| HTTP | `code` | 触发 |
|---|---|---|
| 400 | `invalid-name` / `invalid-tail` / `invalid-body` / `invalid-definition` / `definition-too-large` | 参数问题 |
| 401 | `node-token-missing` / `node-token-invalid` | token 缺失 / 不匹配 |
| 403 | `node-action-forbidden` | action 不在白名单 |
| 403 | `node-scope-forbidden` | `discover` / `config.read` / `manage` 未通过 |
| 403 | `stdio-import-forbidden` | 无 `import-stdio` 却导 stdio |
| 403 | `tls-required` | `MCP_NODE_OPS_REQUIRE_TLS=true`（默认）时从 HTTP 端口访问 `/node-ops` |
| 403 | `node-peer-unknown` | 客户端证书 CN 不在 `MCP_NODE_TOKENS` 里 |
| 403 | `node-peer-mismatch` | 证书 CN 与该 Bearer token 所属 peer 不一致 |
| 403 | `readonly` | `READONLY=true` 时执行写动作 |
| 404 | `server-not-found` | 服务不存在 |
| 409 | `server-duplicate` | 导入重名 |
| 429 | `rate-limited` | 超限 |

### 3.6 审计

`enable` / `disable` / `import` / `definition` 各写一条，复用 `logger`：

```ts
logger.info('[node-ops] audit', JSON.stringify({
  peer, action, server, ok, code: code ?? null, ts: new Date().toISOString(),
}));
```

落在既有 `logService`（内存 1000 条环形缓冲，重启即失，会混进 `/api/logs`）。**这是运行日志级审计**，合规审计不在本方案范围。禁止记录 token、完整 definition、env 值。

### 3.7 复用与禁止

必须复用：`getServerDao` / `getServersInfo` / `dataService.filterData` / `presentServerForPrincipal` / `toggleServerStatus` + 三个 `broadcast*` / `notifyToolChanged` / `normalizeServerConfigForPersistence` / `addServer` / `authorizationService` / `logService.getLogs` / `createStandardRateLimiter`。

禁止：

- 新增任何 `child_process` / `docker` / `SIGTERM` / `kill` 调用。
- 修改 `src/middlewares/index.ts`、`src/middlewares/auth.ts`、`src/services/betterAuthConfig.ts`、任何既有 controller。
- 在 `${BASE_PATH}/api` 下新增路由。
- 给 `mcp_settings.json` 增加新顶层键（见 §8 第 2 条）。

其他约束：

- **只读模式**：写动作在 `config.readonly` 为真时返回 403 `readonly`；开关是环境变量 `READONLY=true`（`src/config/index.ts:23`）。本接口组不走 `auth` 的 `checkReadonly`，必须自己判。
- **限流**：`createStandardRateLimiter({ windowMs: 15*60*1000, max: 600 })` 加在 `/node-ops` 路由组上，`max` 可用 `MCPHUB_NODE_OPS_RATE_LIMIT_MAX` 覆盖。
- **请求体**：全局 `express.json` 默认 1 MB（`src/utils/bearerAuth.ts:7`），import 另按 256 KB 二次校验。

---

### 3.8 参考实现（示例代码，不是最终交付代码）

> 本节代码只用于说明调用方式、字段来源与顺序，**以 §3.4 契约为准**，执行 Agent 可按仓库风格调整；不得借示例扩大改动面（§3.7 的禁止项优先）。

#### 3.8.1 路由挂载（`src/routes/index.ts`，仅追加）

```ts
// 追加在各既有 authenticatedRouter.* 之后、app.use(`${config.basePath}/api`, router) 之前
app.get(`${config.basePath}/node-ops/health`,
  nodeOpsRateLimiter, requireNodeToken(null), nodeHealth);
app.get(`${config.basePath}/node-ops/servers`,
  nodeOpsRateLimiter, requireNodeToken('read'), nodeListServers);
app.get(`${config.basePath}/node-ops/servers/:name/logs`,
  nodeOpsRateLimiter, requireNodeToken('logs'), nodeServerLogs);
app.get(`${config.basePath}/node-ops/servers/:name/definition`,
  nodeOpsRateLimiter, requireNodeToken('definition'), nodeServerDefinition);
app.post(`${config.basePath}/node-ops/servers/:name/enable`,
  nodeOpsRateLimiter, requireNodeToken('control'), nodeEnableServer);
app.post(`${config.basePath}/node-ops/servers/:name/disable`,
  nodeOpsRateLimiter, requireNodeToken('control'), nodeDisableServer);
app.post(`${config.basePath}/node-ops/servers`,
  nodeOpsRateLimiter, requireNodeToken('import'), nodeImportServer);
```

#### 3.8.2 鉴权（`src/middlewares/nodeToken.ts`）

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { createStandardRateLimiter } from '../utils/rateLimit.js';
import type { RequestPrincipal } from '../services/authorizationService.js';
import { logger } from '../utils/logger.js';

export type NodeAction = 'read' | 'logs' | 'definition' | 'control' | 'import' | 'import-stdio';
export interface NodePeer { name: string; actions: NodeAction[]; scope: 'node' | 'admin' }

const ACTIONS: NodeAction[] = ['read', 'logs', 'definition', 'control', 'import', 'import-stdio'];

interface StoredPeer { name: string; hash: Buffer; actions: Set<NodeAction>; scope: 'node' | 'admin' }

/** 解析 MCP_NODE_TOKENS；任何一条不合法则整表作废（保持空表 = 全部 401）。 */
const loadPeers = (raw = process.env.MCP_NODE_TOKENS ?? ''): StoredPeer[] => {
  if (!raw.trim()) return [];
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('not an array');
    const seen = new Set<string>();
    return rows.map((row: any) => {
      if (typeof row?.name !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.name)) throw new Error('bad name');
      if (seen.has(row.name)) throw new Error('duplicate name');
      seen.add(row.name);
      if (typeof row.token !== 'string' || row.token.length < 32 || /\s/.test(row.token)) throw new Error('bad token');
      if (!Array.isArray(row.actions) || row.actions.length === 0) throw new Error('bad actions');
      if (row.actions.some((a: unknown) => !ACTIONS.includes(a as NodeAction))) throw new Error('unknown action');
      const scope = row.scope === 'admin' ? 'admin' : 'node';
      return { name: row.name, hash: createHash('sha256').update(row.token).digest(),
               actions: new Set(row.actions as NodeAction[]), scope };
    });
  } catch (error) {
    logger.error('[node-ops] MCP_NODE_TOKENS rejected; all node-ops requests will answer 401',
      error instanceof Error ? error.message : String(error));
    return [];
  }
};

const PEERS = loadPeers();

const deny = (res: any, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });

export const nodeOpsRateLimiter = createStandardRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.MCPHUB_NODE_OPS_RATE_LIMIT_MAX ?? 600) || 600,
});

/** action 为 null 表示只要求 token 有效（/health）。 */
export function requireNodeToken(action: NodeAction | null): RequestHandler {
  return (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return deny(res, 401, 'node-token-missing', 'Node token is required');
    const digest = createHash('sha256').update(token).digest();
    const peer = PEERS.find((row) => row.hash.length === digest.length && timingSafeEqual(row.hash, digest));
    if (!peer) return deny(res, 401, 'node-token-invalid', 'Node token is not recognized');
    if (action !== null && !peer.actions.has(action)) {
      return deny(res, 403, 'node-action-forbidden', `Action '${action}' is not allowed for this token`);
    }
    (req as Request & { nodePeer?: NodePeer }).nodePeer = {
      name: peer.name, actions: [...peer.actions], scope: peer.scope,
    };
    next();
  };
}

export const nodePeerOf = (req: Request): NodePeer =>
  (req as Request & { nodePeer?: NodePeer }).nodePeer as NodePeer;

export const peerPrincipal = (peer: NodePeer): RequestPrincipal => ({
  username: peer.name, userGroups: [], isAdmin: peer.scope === 'admin',
});
```

#### 3.8.3 审计（`src/utils/nodeAudit.ts`）

```ts
import { logger } from '../utils/logger.js';

export function auditNodeAction(entry: {
  peer: string; action: string; server: string; ok: boolean; code?: string | null;
}): void {
  // 只记录判定结果，不记录 token / definition / env 值
  logger.info('[node-ops] audit', JSON.stringify({ ...entry, ts: new Date().toISOString() }));
}
```

#### 3.8.4 控制器（`src/controllers/nodeOpsController.ts`，节选三个以示范模式）

```ts
import type { Request, Response } from 'express';
import config from '../config/index.js';
import os from 'node:os';
import { getServerDao } from '../dao/DaoFactory.js';
import { getDataService } from '../services/services.js';
import { authorizationService } from '../services/authorizationService.js';
import { presentServerForPrincipal } from '../services/serverConfigPresenter.js';
import {
  broadcastPromptListChanged, broadcastResourceListChanged, broadcastToolListChanged,
  getServersInfo, notifyToolChanged, toggleServerStatus,
} from '../services/mcpService.js';
import { addServer } from '../services/mcpService.js';
import { normalizeServerConfigForPersistence } from '../utils/serverConfigPersistence.js';
import logService from '../services/logService.js';
import { nodePeerOf, peerPrincipal } from '../middlewares/nodeToken.js';
import { auditNodeAction } from '../utils/nodeAudit.js';

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, code, message });

export const nodeHealth = (req: Request, res: Response): void => {
  const peer = nodePeerOf(req);
  res.json({ success: true, data: {
    name: process.env.MCPHUB_NODE_NAME || os.hostname(),
    version: config.mcpHubVersion,
    uptimeSeconds: Math.round(process.uptime()),
    basePath: config.basePath,
    port: Number(config.port),
    capabilities: peer.actions,
  } });
};

export const nodeListServers = async (req: Request, res: Response): Promise<void> => {
  const peer = nodePeerOf(req);
  const principal = peerPrincipal(peer);
  const [records, runtime] = await Promise.all([getServerDao().findAll(), getServersInfo()]);
  const status = new Map(runtime.map((info) => [info.name, info]));
  const visible = getDataService().filterData(records, principal as any);
  const servers = visible.slice(0, 500).map((record: any) => {
    const info = status.get(record.name);
    const mayReadConfig = authorizationService.can('server.config.read', record, principal);
    const endpoint = peer.actions.includes('definition') && mayReadConfig && record.url ? record.url : undefined;
    return {
      name: record.name,
      type: record.type ?? 'stdio',
      enabled: record.enabled !== false,
      status: info?.status ?? 'disconnected',
      owner: record.owner,
      visibility: record.visibility ?? 'private',
      ...(record.description ? { description: record.description } : {}),
      ...(endpoint ? { endpoint } : {}),
    };
  });
  res.json({ success: true, data: { truncated: visible.length > 500, servers } });
};

export const nodeDisableServer = async (req: Request, res: Response): Promise<void> => {
  const peer = nodePeerOf(req);
  const principal = peerPrincipal(peer);
  const name = req.params.name;
  const record = await getServerDao().findById(name);
  if (!record) return fail(res, 404, 'server-not-found', 'Server not found');
  if (!authorizationService.can('server.manage', record, principal)) {
    return fail(res, 403, 'node-scope-forbidden', 'This token may not manage that server');
  }
  if (config.readonly) return fail(res, 403, 'readonly', 'MCPHub is running in read-only mode');
  const result = await toggleServerStatus(name, false);
  if (!result.success) return fail(res, 400, 'invalid-body', result.message ?? 'Failed to disable');
  broadcastToolListChanged();
  broadcastPromptListChanged();
  broadcastResourceListChanged();
  auditNodeAction({ peer: peer.name, action: 'disable', server: name, ok: true });
  res.json({ success: true, data: { name, enabled: false, status: 'disconnected' } });
};
```

其余三个（`logs` / `definition` / `import`）按同一模式：

- `logs`：`authorizationService.can('server.discover', record, principal)` → 逆序过滤 `logService.getLogs()` → `{ text, truncated, matched, partial: true }`。
- `definition`：`presentServerForPrincipal(record, principal)`，`view !== 'full'` 直接 403；再按 §3.4(4) 白名单取字段；成功写审计。
- `import`：体积 → 名称 → transport 白名单（stdio 需 `import-stdio`）→ 禁键检查 → `findById` 预检 409 → `normalizeServerConfigForPersistence` → `addServer` → 可选 `toggleServerStatus` → `notifyToolChanged`。

#### 3.8.5 手工验收（curl，示例）

```bash
BASE=http://127.0.0.1:3000/app/com.ictrek.mcphub
TOK=<node token>

# 1) 无 token：必须是自己的 401，而不是全局 auth 的
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/node-ops/health"          # 401
curl -s "$BASE/node-ops/health" | head -c 200                             # {"success":false,"code":"node-token-missing",...}

# 2) 有 token：能力集与 token 配置一致
curl -s -H "Authorization: Bearer $TOK" "$BASE/node-ops/health"
curl -s -H "Authorization: Bearer $TOK" "$BASE/node-ops/servers" | head -c 400

# 3) 既有鉴权未受影响
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/servers"               # 仍是 401

# 4) 未知路径返回 JSON，而不是 SPA 的 index.html
curl -s -i "$BASE/node-ops/nope" | head -5                                # 404 + application/json

# 5) 软开关 + 日志 + 定义
curl -s -X POST -H "Authorization: Bearer $TOK" "$BASE/node-ops/servers/amap/disable"
curl -s -H "Authorization: Bearer $TOK" "$BASE/node-ops/servers/amap/logs?tail=50"
curl -s -H "Authorization: Bearer $TOK" "$BASE/node-ops/servers/amap/definition"
```

---

## 4. 分工（文件边界互斥）

### Agent A —— 接口与控制面

**只准改**（A-1 已交付 + A-2 新增）：

- 新增 `src/controllers/nodeOpsController.ts`（已交付）
- `src/routes/index.ts`（仅追加 import 与 `app.*` 行）
- `src/types/index.ts`（仅追加类型）
- **A-2 新增** `src/services/nodeOpsTls.ts`
- **A-2 新增** `scripts/gen-node-certs.sh`
- **A-2 追加** `src/server.ts`（仅追加"证书存在时另起 TLS 监听"的十余行，不改既有 HTTP 行为）
- **A-2 移交** `src/middlewares/nodeToken.ts`（本任务期间由 A 维护；B 不再改动，见 B 节）

**DoD（A-1）**：§3.4 七个接口字段一致；权限矩阵逐条生效；`pnpm backend:build` 通过；`git diff --stat` 不越界。

**禁止**：改既有 controller / `auth.ts` / `middlewares/index.ts` / `betterAuthConfig.ts`；加依赖；自己实现状态机。

---

#### A-2 控制面加密（mTLS）—— 本轮必须交付

**问题**：现在 A 调 B 是明文 HTTP + `Authorization: Bearer` 头，谁抓到包谁就能以该 peer 身份读定义（含 env 密钥）、启停、导入、上传代码。内网 + 防火墙是权宜，不能作为设计。

**目标**：控制面单独一个 mTLS 端口；证书证明"你是哪个节点"，token 只负责"你能做哪些动作"。传输加密与授权分离。

**契约（冻结）**

| 项 | 值 |
|---|---|
| 端口 | `MCP_NODE_OPS_PORT`，默认 **31890** |
| 证书 | 由 `MCP_NODE_OPS_TLS_CERT` / `..._KEY` / `..._CA` 指向三个文件；三者缺一 → 不启用 TLS 监听，打一条 warn，且 HTTP 端口上的 `/node-ops` 全部 403 |
| 身份 | 对端 **client cert 的 CN** = peer 名（`^[A-Za-z0-9._:-]{1,64}$`） |
| 第二因子 | 默认仍要求 `Authorization: Bearer <token>` 且该 token 的 peer 名必须与证书 CN 一致；`MCP_NODE_MTLS_ONLY=true` 时只认证书 |
| 明文回退 | `MCP_NODE_OPS_REQUIRE_TLS=true`（默认）时，`/node-ops` 在 HTTP 端口上 403 `tls-required`，不得降级 |
| 证书目录（部署侧） | `/app/data/certs/{ca.pem,server.crt,server.key,client.crt,client.key}`，在持久卷内 |
| 端口发布 | **31890 必须发布到宿主**：`ictrek.app/src/docker-compose.yml` 增加 `'${VOS_MCPHUB_NODE_OPS_PORT:-31890}:31890'`。只发布 31889 的话控制面从别的节点连不上 |
| 破坏性变更 | `REQUIRE_TLS` 默认 true，升级后 HTTP 端口的 `/node-ops` 立即 403。必须在发布说明里写清 |
| 审计 | 每条审计追加 `certFingerprint`（client cert 的 sha256 前 16 位 hex）；token 与私钥永不入日志 |

**拒绝行为（逐条要有测试）**

| 场景 | 结果 |
|---|---|
| HTTP 端口访问 `/node-ops/*`（REQUIRE_TLS=true） | 403 `tls-required` |
| TLS 端口、无 client cert | TLS 握手阶段拒绝（`rejectUnauthorized`），连接不到 handler |
| 证书 CN 未在 `MCP_NODE_TOKENS` 登记 | 403 `node-peer-unknown` |
| 证书 CN 与 Bearer token 所属 peer 不一致 | 403 `node-peer-mismatch` |
| 证书 CN 正常、token 的 action 不足 | 403 `node-action-forbidden`（沿用既有 code） |
| 证书 + token 均正常 | 200，行为与 A-1 完全一致 |

**实现要点**

- `nodeOpsTls.ts` 负责：读证书、`https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true }, app)`、`getPeerCertificate()` 取 CN 与指纹、缺文件时的降级判定。复用同一个 express `app`，不另写业务路由。
- `server.ts` 只加"若证书齐全则 `listen(MCP_NODE_OPS_PORT)`"，并在启动日志里打一行 `node-ops control plane listening on :31890 (mTLS)`。
- `nodeToken.ts` 调整：优先用证书 CN 定位 peer；`requireNodeToken` 增加明文来源拦截；保持既有导出签名不变（`nodePeerOf` / `peerPrincipal` / `nodeOpsRateLimiter` / `auditNodeAction` 不改形状）。
- `gen-node-certs.sh`：一条命令生成 CA + 每节点 server/client 证书（`CN=<节点名>`，server SAN 含 `IP:<地址>,DNS:<主机名>`），并打印对应的环境变量与挂载路径。有效期默认 365 天，脚本支持 `--days`。

**DoD**

- 六个拒绝场景逐条有自动化测试；证书 + token 的正常链路与 A-1 行为一致。
- `pnpm backend:build`、`pnpm test -- tests/node-ops`、`node scripts/verify-dist.js` 全过。
- 手写验证：`curl --cert --key --cacert https://B:31890/.../node-ops/health` → 200；同一请求去掉证书 → 握手失败；换成 `http://B:31889/.../node-ops/health` → 403 `tls-required`。
- 文档补一节：证书生成、分发、轮转（换文件 + 重启）、吊销（从 `MCP_NODE_TOKENS` 删 peer）。

**不做**：自研加密、应用层 HMAC 签名、token 加密传输（TLS 已覆盖）；不做 mTLS 的自动降级。

**后续（不在本轮）**：`PUT /node-ops/packages/...`（复用 `/api/mcpb/upload` 的 handler，动作 `package`）必须挂在这同一个 TLS 监听器上，不允许给 `/api` 开机器凭据口子。

### Agent B —— 鉴权、限流、审计

**只准改**：新增 `src/middlewares/nodeToken.ts`、`src/utils/nodeAudit.ts`。

> **A-2 期间的文件移交**：`src/middlewares/nodeToken.ts` 转由 Agent A 维护（mTLS 的 CN 识别、明文拦截都在这个文件里）。B 不再改动它；若 B 需要调整审计字段，只改 `src/utils/nodeAudit.ts`，不得与 A 同时改 `nodeToken.ts`。

**冻结签名**

```ts
export type NodeAction = 'read' | 'logs' | 'definition' | 'control' | 'import' | 'import-stdio';
export interface NodePeer { name: string; actions: NodeAction[]; scope: 'node' | 'admin' }

export const nodeOpsRateLimiter: RequestHandler;
export function requireNodeToken(action: NodeAction | null): RequestHandler; // null = health
export function nodePeerOf(req: Request): NodePeer;
export function peerPrincipal(peer: NodePeer): RequestPrincipal;             // {username, isAdmin, userGroups: []}
export function auditNodeAction(entry: {
  peer: string; action: string; server: string; ok: boolean; code?: string | null;
}): void;
```

**DoD**：`MCP_NODE_TOKENS` 未配置 / JSON 非法 / token 不匹配 → 401 且 `code` 正确，绝不静默放行；action 不足 → 403；`READONLY=true` 时写动作 403；token 明文不入日志/响应；内存只留 sha256。

**禁止**：改 `auth.ts`、`middlewares/index.ts`、`betterAuthConfig.ts`、既有路由。

### Agent C —— 测试、验证与文档

**只准改**：新增 `tests/node-ops/*.test.ts`（Jest 的 `roots` 已含 `<rootDir>/tests`，见 `jest.config.cjs:4`）；新增 `scripts/verify-node-ops.sh`；`README.md` 末尾追加一节。

**必测**：①无 token → 401 `node-token-missing`（**断言 code**）；②错 token → 401 `node-token-invalid`；③action 不足 → 403；④`scope:node` 看不到他人 private，`scope:admin` 看得到；⑤非 owner 导出 → 403 `node-scope-forbidden`；⑥无 `import-stdio` 导 stdio → 403；⑦definition 带 `oauth` 键 → 400；⑧重名 → 409；⑨`disable` 后 `enabled:false` / `disconnected`；⑩`logs` 无匹配 → 200 + `matched:0`；⑪`definition → import` 往返白名单字段一致。

**DoD**：`pnpm test -- tests/node-ops` 全绿；脚本对运行中的 MCPHub 逐条打印 PASS/FAIL。

**禁止**：改 `src/` 下任何文件；发现 bug 报 A 或 B。

---

## 5. 实施顺序

```
第 0 步  负责人亲做：最小闭环（目标半天）
         只做 nodeToken.ts + GET /node-ops/health + GET /node-ops/servers
         通过标准：
           a) curl 无 token → 401 且 body 里 code=node-token-missing（证明是自己拒的）
           b) curl 带 token → 200，capabilities = token.actions
           c) 未登录访问 /api/servers → 仍是既有行为，证明没碰坏原有鉴权
           d) curl /node-ops/nope → 404 JSON，而不是 index.html
          **不过就停：说明挂载方式要改，不要继续铺接口。**

第 1 步  B：nodeToken 补齐 action / scope / 限流 / 只读      A：/servers 的可见性过滤
第 2 步  A：logs、enable、disable                          （依赖 B 的中间件）
第 3 步  A：definition、import                             C：同步补测试与脚本
第 4 步  负责人：按 §6 验收
```

A 与 B 可同时开工（签名已冻结）；C 从第 1 步起按契约写测试（用 stub）。
**要改契约：停手报负责人**，由负责人改本文档并通知另外两人。

前置条件（已就绪）：无关改动已 `git stash`（`stash@{0}`），`src/routes/index.ts`、`src/types/index.ts` 都是 HEAD 版本；**验收结束前不要 `git stash pop`**，否则与 A 的追加行冲突。

### 5.1 风险与预案

| 症状 | 大概率原因 | 处置 |
|---|---|---|
| `/node-ops/*` 返回 HTML | 被 SPA 通配 `${BASE_PATH}/*` 抢先 | 路由必须在 `initRoutes` 里注册（早于 `findAndServeFrontend`） |
| 配了 token 仍 401 | `MCP_NODE_TOKENS` 非合法 JSON / token < 32 字符 / 进程未重启 | 先看 `/health` 是否也 401；查启动日志里的校验失败行（不含 token 值） |
| `enabled:true` 但 `status:disconnected` | `startOnDemand` 服务的正常态 | 不是 bug，如实返回，不要改成 connected |
| definition 里 `env` 是 `${VAR}` | 正常：导出不展开变量 | 目标节点自己展开，避免密钥跨机搬运 |
| `logs` 恒 `matched:0` | 该服务没有经 MCPHub 记录的输出 | 正常，不要去改 `logService` 造日志 |
| 导入并发同名 | 预检与写入之间有窗口 | 预检 409；写入失败 400 并附原因，不重试 |

---

## 6. 验收清单（负责人执行）

- [ ] 第 0 步四项断言全过（401 带 code、health 200、既有 `/api` 行为不变、未知路径 404 JSON）。
- [ ] 七个接口与 §3.4 逐字段一致（路径、字段名、错误码、缺省 tail）。
- [ ] 401/403/404/409 与 `stdio-import-forbidden` 均有可复现实证。
- [ ] `scope:node` 的 peer 看不到他人 private 服务；非 owner 导出 403。
- [ ] `disable` 后 `/node-ops/servers` 中 `enabled:false`、`disconnected`，且对端进程未被本方案代码触碰（新增代码不含 kill / SIGTERM / docker / child_process）。
- [ ] `definition → import` 往返后白名单字段等价；`env` 保留；`oauth` 不出现在导出里。
- [ ] `logs` 无匹配返回 200 + `matched:0`。
- [ ] token 不出现在日志、响应、审计记录中。
- [ ] `pnpm backend:build`、`pnpm test -- tests/node-ops`、`node scripts/verify-dist.js` 全过。
- [ ] 三个 Agent 改动文件互不重叠；无 TODO、无未使用导出。

---

## 7. 回滚

全部为新增文件 + `routes/index.ts` / `types/index.ts` 的追加行：

```bash
git checkout -- src/routes/index.ts src/types/index.ts
rm -f src/controllers/nodeOpsController.ts src/middlewares/nodeToken.ts src/utils/nodeAudit.ts
rm -rf tests/node-ops scripts/verify-node-ops.sh
```

既有接口、面板与 Agent 工具不受影响；不配置 `MCP_NODE_TOKENS` 时该接口组等同于不存在（全部 401）。

---

## 8. 附录：相对原 §3 契约的修正与依据

需求未变，只改实现层面的七处：

| # | 原契约 | 改成 | 依据 |
|---|---|---|---|
| 1 | 基址 `.../api/node/*` | `.../node-ops/*`，挂 `app` | `${BASE_PATH}/api` 在 `src/middlewares/index.ts:106` 被全局 `auth` 接管，node token 的中间件执行不到；且"无 token 401"是假绿灯 |
| 2 | token 存配置（环境变量或配置文件） | 只走 `MCP_NODE_TOKENS` 环境变量 | `config.saveSettings → dataService.mergeSettings` 只回填 6 个顶层键，新顶层键写入被静默丢弃（实测：`createRemoteNode` 返回成功、盘上未变；DB 模式的 `DaoConfigService` 同样没有该分支） |
| 3 | import 请求 `{definition, enable}` | `{name, definition, enable, owner?, visibility?}` | 原契约没有 `name`，与导出返回的 `{name, definition}` 接不上，往返链断 |
| 4 | `export` / `import` 命名 | `definition` / `POST /servers` | 前者是幂等读取，后者是创建；与 `enable/disable` 一起回归 REST 语义 |
| 5 | `connect`/`disconnect` 返回 `{connected:true/false}` | 返回真实 `status` | `status` 有四种取值（含 `connecting`、`oauth_required`），硬编码会撒谎 |
| 6 | `logs` 返回 `source:'recorded'\|'unsupported'`，不支持时 501 | 恒定 200 + `matched` / `partial` | `logService` 的 `source` 恒为 `main`（stdio stderr 以 `"Upstream server stderr" + JSON{serverName,message}` 记录），只能文本匹配；"没记录"不等于"不支持" |
| 7 | 单个 `nodeToken` | 多 peer + action 白名单 + `scope` | 需求要"限定能触发哪些动作"；`scope` 决定能否读/导出"别人建的"服务，默认只能动自己的 |

未纳入本方案的既有问题（单独记录，不在本次范围）：

- `remoteNodes` / `remoteServerBindings` 在文件模式下写不进去（`mergeSettings` 丢键），影响已有的节点登记功能。
- 对端 MCPHub 的宿主端口无法从 Scheduler 推导（其 `NodeView` 无端口字段；带 `host_port` 的是算力后端部署），需调用侧按部署记录配置；`/health` 已回报 `basePath`/`port` 以减少猜测。
