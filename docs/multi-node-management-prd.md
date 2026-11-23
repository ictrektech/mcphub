# 多节点 MCP 服务统一管理 — 需求文档

状态：待评审
适用项目：MCPHub（`/home/wr/mcphub`）
关联任务原文：`mcphub：管理其他节点的 mcp server（从 v-scheduler 自动发现其他节点，并且 profile 能够对应）`

## 1. 背景与术语

### 1.1 现状

部署拓扑：多台服务器，每台运行 VOS 平台，所有 App（包括 MCPHub）都装在 VOS 上。因此**每台服务器上都有一个 MCPHub 实例**，各自管理本机的 MCP server。目前只能在每台机器上单独管理，缺少统一视图与统一操作入口。

MCPHub 当前是单实例聚合网关：

- 配置以扁平 `mcpServers` 形式存储在 `mcp_settings.json`，`ServerConfig` 没有 `node` / `profile` 字段（`src/types/index.ts:502-524`）。
- 已支持远程上游 `type: sse | streamable-http` + `url`，但远程只表示"一个带 URL 的上游 MCP server"，不是被纳管的节点（`docs/configuration/mcp-settings.mdx:64-112`）。
- 多副本（`MCPHUB_REPLICA_MODE`）只是同一套 hub 共享 PostgreSQL 的无状态副本，不是被管理的远程实例（`docs/configuration/replicas.mdx`）。
- 仓库内没有 v-scheduler / dsh 集成代码；仅有文档说明"MCPHub 没有调度 API，由 V-Scheduler 负责"。

### 1.2 术语定义

| 术语 | 定义 |
|---|---|
| **节点（node）** | 一台运行 VOS 的服务器/机器。不是 MCP server，也不是 MCPHub 进程。一台节点上可装有 MCPHub 实例。 |
| **profile** | V-Scheduler 的硬件档位标签，取值 `amd-cpu` / `amd-cuda` / `arm-cpu` / `arm-cuda` / `jetson-thor` / `jetson-orin` / `dgx-spark` / `sophon-bm1688`（`/home/wr/V-Scheduler/backend/platform/components/modelinfer/backend/src/nodes/profile.rs:3-17`）。用途是为 MCP server 选择匹配的算力节点。 |
| **白名单** | admin 维护的、允许被本系统发现与管理的节点/MCP 服务清单。未列入白名单的节点不发现、不展示、不操作。 |
| **纳管** | 在中心 MCPHub 中登记节点，并能查询其状态、对其上的 MCP server 执行操作。 |

### 1.3 任务解读（分阶段）

派活人原话："可以先做支持的白名单自动发现，然后再加上向节点启动相应 MCP server 或者 MCP server 调用节点相应 profile 算力的能力"。

拆解为三个递进阶段：

1. **P0 白名单自动发现**：从 V-Scheduler 自动获取节点清单，仅对 admin 配置的白名单节点做发现与统一管理（只读为主）。
2. **P1 远程启停服务**：中心可向指定节点下发"启动/停止/重载该节点上的某个 MCP server"。
3. **P2 算力 profile 对应**：MCP server 执行时可声明所需算力 profile，系统按 profile 把任务匹配到硬件兼容的节点上执行。

## 2. 目标与非目标

### 2.1 目标

- P0：admin 配置白名单；自动发现白名单节点及其 MCPHub 上的 MCP server；集中展示状态；按用户权限控制可见范围。
- P1：对白名单节点上的 MCP server 执行启动/停止/重载，操作结果与状态回传中心。
- P2：MCP server 可按所需算力 profile 匹配节点并调用其算力。

### 2.2 非目标

- 不修改 V-Scheduler 的数据模型或调度算法；V-Scheduler 作为节点信息与能力的上游。
- 不实现任意远程 shell / 容器编排 / 应用部署流水线。
- 不在本需求中解决"节点侧 MCPHub 的可达通道"的部署问题（见 §6 开放问题），仅定义接口契约。
- 不改变现有单机 MCP server 的 CRUD、分组、工具裁剪、鉴权语义。

## 3. 用户与权限

复用 MCPHub 现有授权模型，不另起一套：

- `isAdmin`：admin 看全部节点与全部服务，拥有白名单维护、远程操作、profile 配置权限。
- 普通用户：只能看到被授权的节点/服务。现有 `owner`、`visibility`、`sharedWithUsers`、`sharedWithUserGroups` 语义保持一致（`src/services/authorizationService.ts:43-62`）。
- 全局管理闸门沿用 `requireAdmin`（`src/utils/requireAdmin.ts:6-16`）。

建议区分两个授权动作（与现有 `server.discover` / `server.manage` 对齐）：

| 动作 | 含义 | 默认 |
|---|---|---|
| `node.discover` | 能否在列表中看见该节点及其服务 | admin + 被授权用户 |
| `node.manage` | 能否对该节点的服务做启停/重载/配置 | 仅 admin 或 owner |

"只给 admin 配置的节点"= `visibility: private` + `owner: admin` 的节点，普通用户不可见。

## 4. 功能需求

### P0 — 白名单自动发现（先做）— 已实现

1. **节点自动发现（V-Scheduler）— 已实现**
   - 后端 `GET /api/remote-nodes/discover` 用服务端凭据调用 V-Scheduler `GET /api/v1/managed-nodes`。
   - 配置项（环境变量，服务端）：`MCPHUB_VSCHEDULER_URL`（默认 `http://v-scheduler:38120`）、`MCPHUB_VSCHEDULER_TOKEN`。**token 只在服务端，绝不下发浏览器。**
   - 字段自动映射（无需手填）：`host → baseUrl`（`http://{host}:{MCPHUB_REMOTE_PORT}/app/com.ictrek.mcphub`，默认端口 3000，路径可由 `MCPHUB_REMOTE_PATH` 覆盖）、`profile`（优先 `profile`，退回 `detected_profile`）、`name / status / arch / gpu_model`。
   - 宿主机端口可配置：各节点 compose 用 `MCPHUB_HOST_PORT` 发布（默认 3000，容器内部仍监听 3000）；中心用 `MCPHUB_REMOTE_PORT` 指向同一端口。这样 3000 被占用时可统一换端口，避免冲突。
   - 返回 `alreadyManaged` 标记已导入的节点，前端默认只勾选未导入的。
2. **白名单导入 — 已实现**
   - 前端「从 V-Scheduler 同步节点」列出候选（带 profile、状态），admin 勾选并填集成 token，`POST /api/remote-nodes/import` 自动写入白名单（地址 + profile 都自动带过来）。
   - 也支持 `POST /api/remote-nodes` 手动增删（旧能力保留）。
   - 待补：白名单变更的审计记录。
3. **服务发现**
   - 对白名单内每个节点，访问其 MCPHub 的 `/api/integration/discovery` 或 `/api/servers`，获取服务清单（name/description/visibility/status/mcp_path），不取 `command`/`env`/`url` 等配置细节到中心列表。
   - 探测失败时标记节点为"不可达"，保留最近一次成功缓存，不伪造状态。
3b. **远端服务接入本地（已实现，按节点分类）**
   - 节点卡片的「接入到本地」按钮 → `POST /api/remote-nodes/:id/register`：发现该节点的服务后，把每个服务注册为中心 `mcpServers` 里的 `streamable-http` 上游。
   - **命名**：`{服务名}@{节点短名}`（如 `amap@192-orin-nx`），避免跨节点同名冲突。
   - **URL**：`http://{host}:{MCPHUB_REMOTE_PORT}/app/com.ictrek.mcphub/mcp/{服务名}`，header 带集成 token。
   - **分类**：自动建一个以节点命名的 Group（`远程节点 · {节点名}`，visibility=private），把该节点的服务全部归入，与本地服务清晰分开。
   - 重复接入不会重复创建服务，只会补齐分组。接入后立即 `registerAllTools` 注册工具。
   - 端到端实测：Self Test 节点接入后，本地服务列表出现 `amap@self-test`/`gitea@self-test`，分组 `远程节点 · Self Test` 正确。
4. **集中视图**
   - 前端新增节点列表页；展示节点、硬件 profile、在线状态、服务数量、最近检查时间。
   - 点节点进入其 MCP server 列表，展示状态与可见性。
   - 刷新策略：后端定时拉取 + 前端手动刷新，避免浏览器直连各节点。
5. **权限过滤**
   - 列表按 §3 授权动作过滤；普通用户无权限的节点在 API 层就过滤掉，不只做前端隐藏。

### P1 — 向节点启动相应 MCP server

1. 对有 `node.manage` 权限的用户，可对白名单节点上的服务执行：启动、停止、重载。
2. 操作经中心后端代理到节点侧 MCPHub 的现有管理接口（`POST /api/servers/:name/toggle`、`/reload`）。
3. 操作需二次确认；结果实时返回，成功后异步刷新该节点的服务状态。
4. 节点不可达 / 目标服务不存在 / 越权时，返回明确错误，不伪装成功。
5. 审计记录：操作人、节点、服务、动作、时间、结果。

### P2 — MCP server 调用节点相应 profile 算力

1. 服务可声明所需算力 profile（如 `amd-cuda`、`jetson-thor`），作为服务配置的新字段 `required_profile`。
2. 按 profile 匹配节点时使用 V-Scheduler 的 `compatible_profiles` 语义：
   - `dgx-spark` 兼容 `jetson-thor`（单向）；查询 `?profile=jetson-thor` 会同时返回 DGX Spark 节点（`/home/wr/V-Scheduler/backend/platform/components/modelinfer/backend/src/nodes/profile.rs:67-73`）。
   - **同名 profile 不等于等价执行能力**：跨机器匹配必须再核验执行器契约版本与实测资源（`/home/wr/V-Scheduler/docs/design.md:22`）。
3. 服务执行需要算力时，经中心向 V-Scheduler 申请资源许可/任务，由匹配节点执行。
4. 约束：当前 V-Scheduler 对远端节点控制返回 501 `VOS_NODE_CONTROL_PENDING_VERIFICATION`（`/home/wr/V-Scheduler/docs/node-management.md:54`），观察节点不可调度。P2 依赖该能力就绪或由节点侧代理补齐，需在实施前确认。

## 5. 涉及模块（初步）

| 层 | 位置 |
|---|---|
| 类型/存储 | `src/types/index.ts`（`ServerConfig` / `McpSettings` 增字段）、`src/dao/*Dao.ts`、`src/db/entities/*`、migration、`mcp_settings.json` |
| 节点发现 | 新增 `src/services/vSchedulerDiscoveryService.ts`；路由注册 `src/routes/index.ts` |
| 鉴权 | 复用 `src/middlewares/auth.ts`、`src/services/authorizationService.ts`、`src/utils/requireAdmin.ts` |
| 远程连接 | 复用 `sse` / `streamable-http` 上游客户端（`src/services/mcpService.ts`、`src/clients/`） |
| 前端 | `frontend/src/pages/ServersPage.tsx` 增节点维度；新增节点列表页；`ServerContext` / `useServerData` |

## 6. 验收标准

- P0：admin 配置白名单后，中心能列出白名单节点及其服务；非白名单节点不出现；普通用户看不到未授权节点；admin 服务凭据不出现在浏览器请求中。
- P1：admin 在中心启停某节点服务成功，该节点 Agent 侧工具表同步收敛；越权与不可达场景返回明确错误。
- P2：声明 `required_profile=amd-cuda` 的服务被匹配到 CUDA 节点；DGX Spark 对 `jetson-thor` 的兼容语义正确；profile 相同的节点若实测资源不足，不会被误判为可执行。

## 7. 如何拿到别的机器上的 MCP 服务（访问通道调研）

### 7.1 结论

V-Scheduler 全仓库没有任何 MCP 代码，不暴露 `/mcp`，也不上报"其他节点上服务的访问地址"。**不能直接拿到，只能间接**：V-Scheduler 作为"节点清单 + 每节点 VOS 入口 + 已安装应用清单"的数据源，MCPHub 侧完成发现与直连。

### 7.2 V-Scheduler 现有可复用机制

| 机制 | 证据 | 能力 / 限制 |
|---|---|---|
| 每节点 VOS Endpoint（`url/token`） | `backend/src/model.rs:409-417`；`backend/src/vos.rs:10-48,123-160` | 底层具备跨节点调 VOS API 的能力，但路径写死、无 HTTP 对外暴露 |
| `/v1000/app/list` 应用清单 | `backend/src/vos.rs:98-114,142-155` | 逐节点拿到 `app_id / installed_app_id / version / state`；**无地址**；仅在 admin 的 `/api/v1/nodes` 中暴露 |
| `app/detail → configs_json → port` 推导地址范式 | `.../modelinfer/backend/src/platform/mod.rs:198-203`；`.../vrouter/mod.rs:524-539,575-597` | 从 app_id 读端口拼地址的现成做法，但只对写死的几个 app_id 实现 |
| V-Router upstream + 跨节点 `base_url` | `backend/src/router/registry.rs:21-32`；`proxy.rs:114-147` | 能反代到任意主机，但只认模型协议路径，`/mcp` 会 404 |
| Managed nodes + SSH 执行器 | `.../ssh/mod.rs:168-227` | 底层能跑任意远程命令，但无对外接口，文档明确排除"任意远程 shell" |
| Worker 心跳上报 | `backend/src/agent.rs:284-308,344-392` | report 只有 CPU/RAM/GPU/架构/健康，没有服务清单字段 |

### 7.3 推荐路径：Scheduler 当清单源，MCPHub 自己发现并直连

```
① MCPHub 读 V-Scheduler GET /api/v1/nodes → 节点清单 + vos_applications
② 从 vos_applications 找出装有 MCPHub 的节点（app_id / installed_app_id）
③ 经该节点 VOS 入口调 /v1000/app/detail?app_id=... → 从 configs_json 读端口
④ 拼出 http://<node-host>:<port>/mcp → 用现有 streamable-http 客户端直连接入
```

- **依赖**：各节点 `nodes[].vos.url/token` 已配置；MCPHub 把端口写进 `configs_json`；VOS token 具备 `platform:app:read` / `list` 权限。
- **改动量**：V-Scheduler 零改动；MCPHub 侧小到中等。
- **备选**：若不让 MCPHub 直调各节点 VOS，可在 V-Scheduler 新增 `GET /api/v1/nodes/{id}/apps/{app_id}/endpoint` 由它代查地址——中等改动，需处理跨节点地址/凭据白名单。
- **不推荐**：借 V-Router 反代 `/mcp`（协议不支持）或借 SSH 中转（安全边界明确排除，改动大）。

### 7.4 部署前置条件：暴露宿主机端口（下个版本）

实机排障发现：VOS 应用默认只通过 traefik 标签暴露 `/app/com.ictrek.mcphub` 的集群内路由，容器端口 `3000/tcp` **不映射到宿主机**，因此其他节点无法直连该 MCPHub 的 `/mcp` 与 `/api`。

已在 `ictrek.app/src/docker-compose.yml` 的 `x-mcphub-base` 增加固定端口映射：

```yaml
ports:
  - '3000:3000'
```

VOS 每台机器只装一个 MCPHub 实例，固定宿主机端口在各机器间不冲突；原有 traefik 集群内路由保持不变。此改动需随下个版本镜像/应用包发布才能生效——**当前已部署的旧版本仍需手动映射端口或用 host 网络才能测试跨节点发现**。

## 8. 风险与开放问题

1. **app_id / configs_json 契约待确认**：MCPHub 的 VOS `app_id` 是什么、是否把 `/mcp` 端口写进 `configs_json`，仓库内无资料，需实机验证（这是 §7.3 的关键前提）。
2. **跨节点 token 权限**：`nodes[].vos.token` 是否对远端节点 `/v1000/app/detail` 有权限，需实机验证。
3. **管理权限边界**：`vos_applications` 仅在 admin 的 `/api/v1/nodes` 暴露；授权应用可读的 `/managed-nodes` 不含它。若 MCPHub 只有 submitter 身份，需新增授权读取通道或调整部署形态（与 V-Scheduler 同机/共享配置）。
4. **"管理"边界**：P1 仅启停/重载，还是包含创建/删除/改配置？后者涉及任意命令执行与凭据表单，需单独评估。
5. **名称冲突**：跨节点 server 同名时中心如何命名与路由；现有 `nameSeparator` 仅处理 server/tool 命名。
6. **节点失效**：节点离线时服务状态呈现、缓存有效期、重试策略。
7. **profile 语义边界**：只按硬件档位匹配是否足够，是否需要纳入 executor 版本与实测资源（见 §4 P2.2）。
8. **（已解决）VOS 模式下静态 token 不可用**：实机验证发现，VOS 部署（`VOS_AUTH_ENABLED=true`）下 `auth.ts:117-130` 的分支只接受 VOS 用户 token（短期、浏览器持有），Bearer Key / `x-auth-token` 静态凭据那套完全不执行。

   **解决方案**：新增 `MCPHUB_INTEGRATION_TOKEN` 环境变量。设置后，请求携带匹配的 Bearer token 且目标是 dashboard API（`/api/*`）时直接以 admin 放行，不走 VOS 校验；MCP 工具路由不受影响，未设置时行为不变。中心白名单存该 token，远端 MCPHub 的环境变量配同一个值。

   端到端验证（2026-11-23，本机自指测试）：白名单添加节点指向自身 + 集成 token → `POST /api/remote-nodes` 200；`GET /api/remote-nodes/:id/servers` 200，返回 `amap`/`gitea` 服务清单。错误 token 仍 401。26 项相关单测通过（含原有鉴权测试无回归）。

   部署注意：环境变量需在 MCPHub 进程启动前注入（entrypoint 或 compose）。当前线上通过修改容器内 entrypoint 热修，版本发布时应正式加入 `ictrek.app/src/docker-compose.yml` 的 `x-mcphub-env`。
