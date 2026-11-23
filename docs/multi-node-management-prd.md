# 多节点 MCP 服务管理 — 需求文档

状态：v2.4 评审稿（2026-11-23，最终口径：mcphub 不部署容器、不管镜像，只做发现与接入）
适用项目：MCPHub（`/home/wr/mcphub`）
关联任务原文：`mcphub：管理其他节点的 mcp server（从 v-scheduler 自动发现其他节点，并且 profile 能够对应）`

## 0. 已确认的边界（最终口径）

1. **mcphub 不部署容器**。镜像和容器是谁部署的、怎么部署的，与 mcphub 无关（管理员/运维经 v-scheduler 界面或既有流程自行处理）。mcphub 不调 backend-deployments，不碰任何容器生命周期 API。
2. **跨节点通道统一走 v-scheduler**：mcphub 只调它的**读接口**（节点清单），不 SSH 节点、不持节点凭据。
3. **mcphub 的"启停" = 中心侧接入开关**：某节点的 MCP server 接入中心（注册为上游、工具可调用）或摘除。服务进程/容器本身不受影响。
4. **"向节点启动相应 mcp server"的最终解读**：节点上的 MCP server 由别人负责跑起来；mcphub 的职责是把"已在运行的服务"**纳入中心统一管理与调用**。
5. 节点上的服务地址（`http://{节点IP}:{端口}`）是 mcphub 的输入：由 admin 登记提供（P1）；后续可选从 v-scheduler 只读获取（见 §3.3）。
6. v-scheduler 非本方项目，只用其现有公开 API。

> **v1 废弃说明**：v1 假设"每个节点跑一个 MCPHub 实例"并做了 hub-to-hub 直连（宿主机端口 31888 +
> `MCPHUB_INTEGRATION_TOKEN` + 调远端 `/api/integration/discovery`）。拓扑假设错误。v1 的
> `managed-nodes` 发现与白名单导入保留，其余见 §6。

## 1. 拓扑

```
┌──────────────────┐        ┌────────────────────────────┐
│ 中心服务器         │        │ SSH 算力节点 ×N              │
│ · VOS 平台        │        │ （Jetson Orin、DGX Spark、   │
│ · V-Scheduler ───┼─ SSH ─→│  amd-cuda 机器…）            │
│ · MCPHub（中心）   │        │ · 有 Docker，上面有 MCP server│
└──────────────────┘        │   （部署与容器管理不归 mcphub） │
                             └────────────────────────────┘
```

mcphub 与节点的关系只有一条：**知道节点存在（v-scheduler 告诉它）→ 知道节点上有哪个服务、地址是什么（admin 登记或后续台账）→ 直连地址调用（streamable-http 上游）**。

## 2. 功能需求

### P0 — 白名单自动发现（先做）

1. 调 `GET /managed-nodes` 获取节点清单，映射为节点卡片数据。**注意字段口径**：submitter 凭据拿到的是脱敏视图，节点地址字段是 `address`（解析后的 IP）+ `hostname`，**没有 `host`**（admin 凭据才有）；取值统一用 `address ?? hostname ?? host` 兜底（`remoteNodeService.ts` 已按此修正，原实现 filter `item.host` 会导致 submitter 下列表为空）。
2. admin 从候选中勾选导入白名单（存 `mcp_settings.json` 的 `remoteNodes`），支持手动增删改。
3. 节点卡片展示：名称、address、arch、GPU、profile、`status`、`last_checked_at`。**P0 不做连通性预检**——节点清单里没有端口、服务地址 P1 才登记，P0 无从预检；连通性验证挪到 P1（登记地址后对该地址做可达性检查）。
4. 白名单外节点不发现、不展示；接口层过滤，非 admin 不可见。

### P1 — 节点服务的接入与中心侧启停

1. admin 在节点下**登记 MCP server**：服务名 + 访问地址（`http://{节点IP}:{端口}`，路径按服务实际 MCP 路径）；登记即建绑定记录（服务 ↔ 节点，见 §5.1）。
2. 登记后可一键**接入**：注册为 streamable-http 上游（命名 `<server>@<node>`，归入分组 `远程节点 · {节点名}`），工具进入 mcphub 聚合工具表——**开关开了，harness 就能调用；没开就调用不到**。调用方是 harness（经 mcphub 聚合暴露）。
3. **启停（中心侧）**：上游 enabled 开关——"停止"= 摘除路由（工具从聚合表消失，harness 调用不到；服务还在节点上跑），"启动"= 恢复接入。开关切换经 `broadcastToolListChanged` 广播，客户端实时感知。二次确认 + 审计。
4. 健康展示：接入前验证地址可达；不可达/调用失败明确标注，不伪造在线。

### P2 — profile 对应（另评）

节点的 profile 作为展示与筛选属性。"MCP server 调用节点相应 profile 算力"（按算力派任务/路由）依赖 V-Scheduler 远端控制契约（当前 501），**另立项**，本期不做。

## 3. v-scheduler API 使用（只读，全部现有公开接口）

| 端点 | 用途 | 凭据 |
|---|---|---|
| `GET /managed-nodes` | 节点清单（脱敏：id/name/status/**address/hostname**/arch/gpu_model/profile/compatible_profiles；无 `host` 字段） | **当前登录用户的 VOS token**（转发请求头） |
| `GET /managed-nodes?profile=x` | 按档位筛节点（compatible 语义由平台保证） | 同上 |

### 3.1 凭据模式（2026-11-23 定稿：用户 token 转发，与 v-harness/v-office 同款）

静态服务凭据方案（`MCPHUB_VSCHEDULER_TOKEN`）**废弃**。采用平台既有模式（源码依据：v-harness `gateway/scheduler.mjs` 注释 "VOS bearer tokens remain in the gateway / management credentials are never used"；v-office `ictrek.app/src/docker-compose.yml`）：

1. **应用包声明依赖**：`ictrek.app/src/manifest.yml` 加 `dependencies.apps: - id: com.ictrek.v-scheduler`，VOS 保证两应用同容器网络；
2. **地址写死 compose**：`V_SCHEDULER_URL: ${V_SCHEDULER_URL:-http://v-scheduler:8080}`（容器网络直连）；
3. **凭据 = 当前登录用户的 VOS token**：VOS 模式下浏览器请求头本就携带用户 token，mcphub 后端转发给 v-scheduler 即可——v-scheduler 对已登录 VOS 用户放行脱敏节点清单（`identity::verified_account`）。

效果：admin 打开页面点"同步"→ 后端取当前请求的 `x-vos-token`（VOS 前端实际发出的头；兼容 `Authorization: Bearer`）并转发给 v-scheduler → 返回节点清单。**零凭据创建、零管理员操作、零静态密钥保管**。代码侧：`discoverNodesFromScheduler(userToken)` 由控制器传入；未登录/非 admin 已被路由层拦截。请求路径统一为 `{V_SCHEDULER_URL}/scheduler/api/v1/managed-nodes`，该路径在 8080 网关与 38120 controller 上均可用。

### 3.2 可选增强（不阻塞）：从台账只读获取服务地址

若不想手工登记地址，可后续只读 `GET /backend-deployments`，从台账提取服务的 endpoint 回填绑定记录。该接口不是 `managed-nodes` 的公开只读视图：VOS 普通用户 token 无法读取台账，管理员 token 才能读全量，submitter 服务凭据只能读自身 `app_id`。若启用此增强，需要单独确定凭据口径（另配 admin/submitter 凭据或与运维约定）；本期不做。该接口属 v-scheduler 0.0.120 新增的部署生命周期 API——**mcphub 只读消费，不调用其部署/启停端点**。

### 3.3 明确不做

- ~~部署容器 / backend-deployments 写操作~~（边界 1）
- ~~容器 start/stop~~（边界 3：启停仅指中心侧开关）
- ~~直连远端 MCPHub / 集成 token / 暴露 31888~~（v1 遗留，见 §6）
- ~~mcphub 自持 SSH 凭据~~

## 4. mcphub 侧改造清单

| 层 | 位置 | 改动 |
|---|---|---|
| 应用包 | `ictrek.app/src/manifest.yml` | 加 `dependencies.apps: - id: com.ictrek.v-scheduler`（§3.1） |
| 应用包 | `ictrek.app/src/docker-compose.yml` | 加 `V_SCHEDULER_URL: ${V_SCHEDULER_URL:-http://v-scheduler:8080}` |
| 类型 | `src/types/index.ts` | `RemoteNodeConfig` 改为算力节点语义：去 `baseUrl/token`，加 `schedulerNodeId/address/profile/arch/gpuModel` |
| 节点服务 | `src/services/remoteNodeService.ts` | `discoverNodesFromScheduler` 去掉 MCPHub baseUrl 拼接、地址字段改 `address ?? hostname ?? host`（已修）；新增服务登记/绑定管理；登记地址的可达性检查 |
| 上游注册 | `src/services/remoteServerRegistrationService.ts` | 上游 URL 取登记地址；命名/分组保留；`enabled` 开关复用 `mcpService` 现有 toggle |
| 控制器/路由 | `remoteNodeController.ts`、`routes/index.ts` | 服务登记/接入/摘除端点，`requireAdminMiddleware` |
| 前端 | `RemoteNodesPage.tsx` | 节点卡片（profile/GPU/可达性）；服务登记表单；接入/摘除按钮；i18n |

**可复用**：streamable-http 上游注册全链路、Group 机制、`mcp_settings.json` 整存整取、上游 toggle。

### 5.1 服务↔节点绑定记录

`ServerConfig` 不加部署字段（本期无部署概念）；v1 的 `nodeId/nodeName/nodeProfile` 降级为只读回显。新增 `remoteServerBindings`（`mcp_settings.json`）：

```ts
interface RemoteServerBinding {
  id: string;
  serverName: string;      // 登记时指定的服务名（接入后才生成上游名 <server>@<node>）
  schedulerNodeId: string; // 来源节点
  address: string;         // admin 登记的完整 URL，含 MCP 路径（如 http://1.2.3.4:8080/mcp），非仅 host:port
  profile?: string;        // 所属节点 profile（回显）
  upstreamName?: string;   // 接入后固定，节点改名不影响路由
  reachable?: boolean;     // 中心侧地址预检结果
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
}
```

接入/摘除复用 `mcpService.toggleServerStatus`：禁止时 `closeServer`、清空工具缓存并广播；恢复时由 `initializeClientsFromSettings` 在工具加载完成后广播。服务登记/切换/删除写结构化审计日志，前端摘除与删除要求二次确认。

存量无绑定记录的服务行为不变；无需 migration。

## 6. 摘除清单（v1 遗留）

| v1 产物 | 处置 |
|---|---|
| `MCPHUB_INTEGRATION_TOKEN` 鉴权分支 + 单测 | **已删除**（与代码一致） |
| `MCPHUB_HOST_PORT` / compose 端口映射 31888 | **回退** |
| `discoverRemoteServers`（调远端 MCPHub） | 移除；P0 服务表隐藏，P1 换登记制 |
| `remoteServerRegistrationService` 远端 URL 拼接 | 改为登记地址 |
| `MCPHUB_REMOTE_PATH/PORT` 常量 | 随摘除清理 |

## 7. 实施计划

- **P0（1-2 天）**：节点语义改造（地址字段 `address ?? hostname`）+ V-Scheduler 应用依赖与 compose 地址 + 发现接口对接（用户 token 转发，§3.1）+ 白名单 UI + 服务表隐藏。验收：admin 在 VOS 环境打开页面能列出 SSH 节点，白名单生效。
- **P1（1-2 天）**：服务登记 + 登记地址可达性检查 + 接入/摘除（上游注册 + enabled 开关）。验收：登记节点上的 MCP server 地址后，中心可调用其工具、可摘除恢复；不可达明确报错。
- **P2（另评）**：profile 算力调度（依赖上游 501 契约）；可选的台账只读回填（§3.3）。

## 8. 风险与开放问题

1. **服务地址的记录处（已定，非开放问题）**：**mcphub 自己就是登记处**——P1 的服务登记表单 + `remoteServerBindings` 绑定记录即中心的服务台账，admin 获知地址后录入一次即可。v-scheduler backend-deployments 台账的 endpoint 仅作为可选的自动回填源（§3.3，mcphub 只读），是否启用看登记体验，不影响方案成立。
2. **网络可达性**：调用走节点裸端口直连，不经网关。P1 登记地址时做可达性检查；不可达的登记项允许保存，但接入调用会失败——UI 明确标注，不阻塞登记。
3. **profile 的作用边界**：本期 profile 仅展示/筛选。真正"按算力派任务"依赖上游远端控制契约（501），已划入 P2 另立项。
4. **与 v-harness 任务一致性**：节点 ID 以 V-Scheduler 为准；v-harness 的排障任务独立推进，不与本任务耦合。
