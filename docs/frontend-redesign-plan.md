# MCPHub 前端体验优化方案（需求 · 思路 · 实施）

| 项 | 值 |
| --- | --- |
| 状态 | 待评审 |
| 版本 | v1.2（补充 VOS 部署、登录 token 与用户隔离约束） |
| 日期 | 2026-11-13 |
| 基线提交 | `d364b48` |
| 部署目标 | **VOS 应用**（`BASE_PATH=/app/com.ictrek.mcphub`，`VOS_AUTH_ENABLED=true`），普通独立部署仍要兼容 |
| 隔离模型 | **单实例多用户**（非多租户）：服务端按请求强制隔离；前端账号切换靠 reload 兜底但持久化数据不隔离，见 `1.8` |
| 关键约束 | VOS 登录 token 链路（`1.7`）与用户隔离（`1.8`）为一等约束；两种部署形态必须同时通过验收 |
| 文档类型 | 内部技术方案（不是用户文档） |
| 面向读者 | 前端开发、执行 agent、评审人 |

本文不进入 Mintlify 导航。`pnpm docs:validate` 只编译 `docs/` 下的 `.mdx`（`scripts/validate-docs.js:21-31`），本文件为 `.md`，不参与该校验，也不影响文档站构建。

文中所有路径、行号与统计来自 2026-11-13 对 `d364b48` 的静态调研；行号会随代码变化失效，结论以当前实现为准。相对排期按 1 人投入估算，不是交付承诺。

---

## 1. 需求

### 1.1 问题陈述

用户反馈：**「前端又难用、又难看、体验感差」**。

调研确认这不是主观审美问题，而是三类可举证的结构问题叠加：一套做到一半的设计系统迁移、缺失的服务端状态层，以及零 UI 回归保护。仓库自带截图可以直接看出「同一个产品里像三个系统」：`assets/dashboard.png` 是黑白极简、大留白、侧栏标题被截断成 `MCPHub Dashb...`；`assets/market.zh.png` 是亮蓝按钮加彩色标签；`assets/smart-routing.zh.png` 是旧式灰蓝表单、每个字段各挂一个蓝色「保存」。

**部署前提**：本项目要部署到 VOS 平台，前端嵌在 VOS 应用容器内，登录使用 **VOS 平台签发的登录 token**，而不是 MCPHub 自己的密码登录。因此本方案不是一次纯粹的「换皮」：任何涉及请求层、路由、Provider、登录态、i18n、地址展示的改动，都必须同时保证 VOS 模式与普通模式两条路径成立。VOS 模式的完整链路与绝对不能改的边界见 `1.7`。

### 1.2 现状基线（量化）

| 分类 | 指标 | 当前值 | 证据 |
| --- | --- | --- | --- |
| 规模 | 页面 / 组件 | 15 个页面、98 个 `.tsx` | `frontend/src/App.tsx:52-102`、`frontend/src/pages/`、`frontend/src/components/` |
| 规模 | 最大文件 | `SettingsPage.tsx` 4633 行、`ServerForm.tsx` 2618 行、`SettingsContext.tsx` 1347 行、`ServerCard.tsx` 1146 行 | 同上 |
| 样式 | 全局 CSS | 仅 `frontend/src/index.css` 一个文件，1179 行 | `index.css:1-1179` |
| 样式 | `!important` | 213 处，集中在 `index.css:354-1137`，主体为 485-948 行的旧类覆盖段 | `index.css:534` 注释 `Retrofit legacy utility classes` |
| 样式 | inline style | 32 个文件、约 418 处 `style={{` | `ServerCard.tsx`、`SettingsPage.tsx`、`GroupCard.tsx` 等 |
| 样式 | 遗留色类 | 45 个 `.tsx` 仍用旧灰/蓝 Tailwind 类（`SettingsPage.tsx` 约 290 处、`ServerForm.tsx` 约 100 处） | 同上 |
| 样式 | 设计尺度 | `theme.extend: {}`，无 spacing / fontSize / radius / shadow / z-index token；圆角散落 4/5/6/7/8/10/12/999px | `frontend/tailwind.config.js:7-9` |
| 样式 | 字体 | 声明 `Geist Mono` / `JetBrains Mono`，但无 `@font-face`、无 CDN link | `index.css:30-31`、`frontend/index.html` |
| 样式 | 暗色 | `.dark` 只覆盖 11 个变量，缺 `--hub-accent/ok/warn/err`，靠逐类 `oklch()` + `!important` 补 | `index.css:34-47` |
| 响应式 | 媒体查询 | 2 个（1440px、1200px），**无 <768px 断点**；侧栏固定 232px 且无移动抽屉 | `index.css:410`、`:1144`、`Sidebar.tsx:139` |
| 响应式 | 横向溢出 | 服务器卡片 10 列 `minmax(Npx,...)` 合计约 878px 最小宽，内容区未局部 `overflow-x-auto` | `index.css:277-289`、`Content.tsx:8-11` |
| 状态 | 服务端状态层 | 无 react-query / SWR / Zustand / Redux；7 个 Context + 手写 `refreshKey` | `package.json` 依赖表、`ServerContext.tsx:192-198` |
| 状态 | 重复请求 | `/groups` 在 `Sidebar`、`GroupsPage`、`Dashboard`、`SettingsPage` 四处各发一份 | `Sidebar.tsx:46`、`GroupsPage.tsx:25`、`Dashboard.tsx:67`、`SettingsPage.tsx:589` |
| 状态 | 轮询 | 顶层 Provider 递归 `setTimeout`，快速期 2s / 稳定期 30s；数据未变也 `setServers`，无 `visibilitychange` 暂停 | `ServerContext.tsx:85-178`、`utils/serverPolling.ts:1-41` |
| 反馈 | 吞异常 / 401 | `apiRequest` 把异常吞成 `{success:false}`；401 只清 token / 清 VOS 会话，跳转登录被注释 | `fetchInterceptor.ts:143-161`、`interceptors.ts:53-62` |
| 反馈 | 成功反馈 | 新增/编辑 server、group/user 的 CRUD 成功时静默，只有失败才 `setError` | `AddServerForm.tsx:87-88`、`EditServerForm.tsx:43`、`GroupsPage.tsx:141-166`、`UsersPage.tsx:220-250` |
| 反馈 | Toast | 单例、无队列、无 `role="status"` / `aria-live`；页面级使用仅 2 个页面 | `ToastContext.tsx:23-42`、`Toast.tsx:93-103` |
| 反馈 | 按钮 loading | 全局监听 click 给「最近点击的 button」加 class 的 DOM hack（100ms 窗口）；刷新按钮固定 `setTimeout(400)` 假转圈 | `fetchInterceptor.ts:21-39`、`ServersPage.tsx:141-149` |
| 表单 | 校验 | `ServerForm` 错误统一堆在表单顶部，无字段级错误、无必填 `*`、无脏数据保护，关闭即丢全部输入 | `ServerForm.tsx:591-595,635-639,2606-2609` |
| 弹窗 | 键盘 | `index.css:520` 用 `outline:0 !important` 抹掉焦点样式；表单弹窗无 Escape / 焦点陷阱；13+ 处手写 `fixed inset-0`；`ConfirmDialog.tsx:109-144` 的 Enter 会同时触发确认与取消 | `index.css:520`、`ConfirmDialog.tsx:106-144` |
| 导航 | 深链 | 仅 `/market/:serverName` 一个参数路由，编辑/详情全是弹窗；筛选、页码、展开项不进 URL | `App.tsx:80-100` |
| 测试 | 前端 | `frontend/` 下 0 个 `*.test.tsx`；Jest 为 node 环境、无 jsdom / Testing Library / Playwright / 视觉回归；**无 VOS 登录 E2E** | `jest.config.cjs:3-9,29-46` |
| CI | 构建 | `build` 与 `integration-test` job 被整段注释；`format` 脚本不含 `.tsx` 与 `frontend/`；ESLint 无 jsx-a11y / react-hooks | `ci.yml:57-121`、`package.json:28`、`eslint.config.mjs:20,33-46` |
| 品牌 | 颜色 | 前端 `--hub-accent` 为蓝色系，文档站主色为绿色 `#16A34A` | `index.css:25`、`docs/docs.json:7` |
| **VOS** | 部署形态 | `BASE_PATH=/app/com.ictrek.mcphub`、`VOS_AUTH_ENABLED=true`，traefik `PathPrefix` 路由；Docker `vos` target | `ictrek.app/src/docker-compose.yml:4-7,25-26`、`Dockerfile:74-84` |
| **VOS** | 模式开关 | 后端 `/config` 无鉴权下发 `vosAuthEnabled` → `window.__MCPHUB_CONFIG__` → `isVosMode()` 是唯一前端判定入口 | `configController.ts:39-57`、`runtime.ts:53-108`、`main.tsx:18-22`、`vosAuthService.ts:52` |
| **VOS** | token 存储 | `window.vos_platform` PKCE 取得，**只存模块内存**，不进 localStorage / Cookie / URL；会话上限 270s，支持 refresh_token | `frontend/src/services/vosAuthService.ts:1,42-50,81-166` |
| **VOS** | 请求双通道 | 管理 API 用 `x-vos-token`（同源 `${basePath}/api/`、排除 `/auth/vos`）；登录端点用 `Authorization: Bearer`；VOS 模式不发 `x-auth-token` | `interceptors.ts:32-41`、`vosAuthService.ts:137-145`、`auth.ts:119-120` |
| **VOS** | 后端校验 | 每个 `/api` 请求向 `VOS_USERINFO_URL` 远程 introspect，角色实时回写；无本地 JWT 验签、无网关注入 | `src/services/vosAuthService.ts:26-110`、`auth.ts:117-130` |
| **VOS** | 401 语义 | 拦截器只 `clearVosSession()`，不跳转；失败展示在 `ProtectedRoute` → `VosSignIn`（重试 = reload） | `interceptors.ts:53-62`、`ProtectedRoute.tsx:23-25`、`VosSignIn.tsx:3-14` |
| **VOS** | 耦合面 | 17 个前端文件带 `VOS adaptation` 注释，覆盖 fetch、路由、Provider、i18n、设置页、地址展示 | 见 `1.7` 与附录 A |

### 1.3 目标与验收指标

| 编号 | 目标 | 可验证指标 |
| --- | --- | --- |
| G1 | 视觉一致性 | 全站单一 token 来源、单一组件层；`!important` 补丁归零；inline style 从约 418 处降到 <30 处；light/dark 各一套完整语义色 |
| G2 | 反馈确定性 | 每个写操作具备 success / error / pending 三态；**401 按部署形态分叉处理**：普通模式跳本地登录页并提示，VOS 模式清会话 + 展示 `VosSignIn`，不得跳 `/login`；401 / 403 / 404 分别处理；错误条可重试；Toast 队列 + `aria-live` |
| G3 | 界面稳定性 | 同一资源在单页面只发 1 个请求；后台标签页 0 轮询；数据未变不触发消费者重渲染；删除 400ms 假转圈与 DOM loading hack |
| G4 | 可用性 | 390 / 768 / 1024 / 1440 四档无横向溢出与重叠；键盘可达所有控件；`axe` 扫描 0 critical；焦点样式可见 |
| G5 | 可维护性 | 前端组件测试 + 3 条 E2E + 视觉基线进入 CI；`pnpm build` 恢复为必需 job；巨型文件拆分到可维护规模 |
| G6 | 可分享性 | 主要视图的筛选、页码、展开项、选中项进 URL，刷新不丢、浏览器后退可用；所有深链带 `BASE_PATH` |
| **G7** | **VOS 部署零回归** | VOS 模式下 `x-vos-token` 注入三条件不变、token 只在内存、`/auth/vos` 仍走 Bearer、introspect 与角色钳制不变、`VosSignIn` 可达、语言跟随 VOS 可用；普通模式与 VOS 模式 E2E 均绿；发布前 VOS 烟测通过 |
| **G8** | **用户隔离零回归** | 服务端按请求的 owner / visibility / group / app 凭据过滤不变；前端账号切换后不残留上一个用户的数据、`auth.user`、query cache、SSE 连接或表单草稿；queryKey 含用户维度；A/B 双账号 E2E 通过 |

### 1.4 非目标与边界

- **不改后端 API 契约**、不重构后端、不动数据库与鉴权逻辑。前端单向改造，可随时回滚。
- **不改 VOS 鉴权链路**：不改 `VOS_AUTH_ENABLED` / `VOS_USERINFO_URL` 语义、不改远程 introspect、不改 token 存储方式、不改 `/auth/vos` 与 `x-vos-token` 双通道、不恢复 VOS 模式的密码登录/注册。
- **不引入多租户改造、也不削弱现有隔离**：现有模型是单实例多用户（`1.8`），本方案不做租户分片，但禁止把 `isAdmin` / `permissions` 缓存到前端当授权依据、禁止绕过服务端过滤、禁止让新增缓存跨账号复用。
- **不做品牌重塑、不做官网 / 落地页**。那是 `design-taste-frontend` 的场景，其 gate 要求 hero 一屏一节、真实照片、无图注，与管理面板冲突，不进入本方案。
- **不引入 shadcn 全套**。依赖虽声明 `@shadcn/ui` / radix，但 `components.json` 未初始化，与现有 `hub-*` 类会形成第三套体系。
- **不全量重写** 4633 行设置页与 2618 行表单，按 section 逐个搬迁并保留旧路由重定向。
- **不手改生成物**：`dist/`、`frontend/dist/`、`coverage/`（`AGENTS.md`）。
- 不新增语言，但所有文案变更必须同步现有 6 个 locale；VOS 模式语言选项只有 auto / en / zh（见 `1.7`）。

### 1.5 约束

- 工具链：`pnpm@10.12.4`、Node ≥22（本机 `v22.23.1`）、Vite 6 / React 19 / Tailwind v4 / react-router 7。
- 前端依赖声明在根 `devDependencies`（`package.json`）。
- 新增翻译键必须同步 `locales/{en,zh,vi,fr,tr,es}.json`，并在 `frontend/src/i18n.ts` 与 `LanguageSwitch.tsx` 登记（`docs/agents/typescript-and-frontend.md:10`）。
- 保存 / 重载设置与相关管理操作需在真实浏览器验证，PR 附截图（`docs/agents/typescript-and-frontend.md:16`）——本方案把这条既有约定落实为 CI 检查。
- **VOS 登录 token 是硬性约束，不是可选的适配项**：`x-vos-token` 链路、VOS 登录态、17 个 `VOS adaptation` 文件与双模式行为不得回归；完整边界见 `1.7`。每个阶段的验收都必须同时跑普通模式与 VOS 模式。
- 代码注释使用英文、两空格缩进、单引号（`docs/agents/typescript-and-frontend.md:3-6`）。

### 1.6 决策待确认项

| 编号 | 待定决策 | 影响 | 建议 |
| --- | --- | --- | --- |
| D1 | 视觉方向（3 稿选 1） | M2 起所有页面的样式基线 | 由 `huashu-design` 出稿后由需求方定稿，未定稿不启动 M3 |
| D2 | 品牌主色：前端蓝 or 文档站绿 | token、图标、文档站 | 统一为一个值，写进 `@theme`；VOS 容器内需实机确认对比度 |
| D3 | 是否真正加载 `Geist Mono` / `JetBrains Mono` | 字体体积与观感 | 二选一：加载字体文件或删除 `--hub-mono` 声明，不留空声明 |
| D4 | 状态层选 TanStack Query 还是 SWR | M1 全部实现 | 建议 TanStack Query：需要 mutation 三态、`invalidateQueries`、可控轮询 |
| D5 | 组件层是否用 Radix 原语 | Modal 无障碍实现 | 建议只用 Radix 的 Dialog 原语，不引入完整 shadcn |
| D6 | 起手式：M0 先行还是先看 M1 效果 | 首周节奏 | 建议 M0 先行；若要演示效果可临时跳过，但 M2 前必须补齐 |
| **D7** | **VOS 401 / 登出语义** | M1、M4 | 现状 `UserProfileMenu` 登出只清内存 + 跳 `/login`，reload 后会被 PKCE 自动重新登录，并不等于退出 VOS 平台；需产品确认是隐藏登出、还是改为「账户由 VOS 平台管理」提示 |
| **D8** | **270s 会话上限与轮询节奏** | M1 | 前端把 `expires_in` 截到 300s 再减 30s，每约 4.5 分钟重走一次 `/auth/vos` 或 refresh；需与平台侧确认 `refresh_token` 有效期，以及新的轮询/`refetchInterval` 是否要对齐该节奏 |
| **D9** | **VOS E2E 的模拟方式** | M0 起全程 | 轻量方案：Playwright 注入 `window.__MCPHUB_CONFIG__` + `window.vos_platform` stub；完整方案：以 `VOS_AUTH_ENABLED=true` + `tests/fixtures/vos-userinfo.mjs` 起真实后端。建议两者都要，见 `3.1` |
| **D10** | **owner 显示与命名空间用户名** | M3 / M4 | VOS 本地用户名是 `vos-<preferred>-<hash>`，界面显示 `displayName`；`GroupCard.tsx:49` 的 owner 比较与私有资源归属需确认是否要展示映射 |
| **D11** | **持久化 key 的分区策略** | M0 / M1 / M4 | `mcphub_tool_form_*` / `mcphub_prompt_form_*` 草稿、主题、每页条数、语言偏好目前都是全局单值 key；需确认哪些允许跨用户保留、哪些必须按 `subject` / `username` 分区。建议：含凭据或输入内容的一律分区，纯外观偏好可保留 |
| **D12** | **账号切换时是否强制 reload** | M1 | 现状 `user-change` 靠 reload 兜底，但 401 / logout 不 reload，导致 `auth.user` 与 SSE 残留。需确认改为显式 `resetForUser()` 后仍保留 reload 兜底，还是允许「无刷新切换」 |
| **D13** | **上游 MCP 连接是否要按用户隔离** | 本方案之外，需产品确认 | 默认 `perSessionClient=false` 时所有下游会话共享同一个上游进程/浏览器；有状态服务（Playwright、OpenAPI cookie jar）可能跨用户串状态。属后端配置，本方案不改，但要提示部署方 |

### 1.7 VOS 部署形态与登录 token（一等约束）

#### 1.7.1 模式识别与链路

```text
VOS 平台容器（iframe）
  └─ traefik PathPrefix(/app/com.ictrek.mcphub)
       └─ 后端：VOS_AUTH_ENABLED=true / VOS_USERINFO_URL / BASE_PATH
            └─ GET /config（无鉴权）→ { vosAuthEnabled, basePath, ... }
                 └─ 前端 loadRuntimeConfig() → window.__MCPHUB_CONFIG__ → isVosMode()
                      └─ window.vos_platform（PKCE S256）→ access_token
                           ├─ POST /api/auth/vos  ← Authorization: Bearer <token>（换取 user，不签发 dashboard token）
                           └─ 其余 /api/*          ← x-vos-token: <token>
                                └─ 后端每个请求向 VOS_USERINFO_URL 远程 introspect → principal / 角色
```

关键事实（代码确认）：

- **唯一开关**是后端环境变量 `VOS_AUTH_ENABLED === 'true'`（`src/services/vosAuthService.ts:7`），前端不读环境变量，只读 `/config` 下发的 `vosAuthEnabled`（`src/controllers/configController.ts:39-57` → `frontend/src/utils/runtime.ts:53-108` → `main.tsx:18-22` → `frontend/src/services/vosAuthService.ts:52`）。`runtime.ts:95-99` 的兜底配置**不含** `vosAuthEnabled`，即 `/config` 全部失败时 VOS 会被判定为关闭——改 Vite 代理或 SPA 入口时必须保证 `/config` 可达（`frontend/viteProxy.ts:8-22`）。
- **token 只在模块内存**：`frontend/src/services/vosAuthService.ts:1` 明确 `PKCE fastpath tokens stay in memory, never in browser storage or URLs`；`session` / `pending` / `epoch` 三个模块变量（`:42-50`）实现并发去重、refresh 回退 PKCE、账号切换防陈旧写回。普通模式的 `localStorage['mcphub_token']` 在 VOS 启动时会主动清掉（`AuthContext.tsx:41`）。
- **会话有效期**：`expiresAt = min(expires_in ?? 300, 300) - 30` ⇒ 最多 270s（`:150-155`）；`user-change` 或 `getUser().sub` 变化 → `clearVosSession()` + `window.location.reload()`（`:88-93,168-180`）。
- **双通道**（`frontend/src/utils/interceptors.ts:32-41`、`frontend/src/services/vosAuthService.ts:137-145`、`src/middlewares/auth.ts:119-120`）：

| 用途 | 头 | 目标 | 备注 |
| --- | --- | --- | --- |
| 管理 API | `x-vos-token` | 同源 `${basePath}/api/`，且路径不以 `/auth/vos` 结尾 | VOS 模式不发 `x-auth-token`；后端 `x-vos-token` 优先于 Bearer |
| 登录校验 | `Authorization: Bearer` | `POST /api/auth/vos` | 只接受 Bearer，不读 `x-vos-token`、不读 Cookie；用原生 `fetch` 避免递归触发拦截器；`credentials:'same-origin'` 仅为 Safari 设备证书兼容 |
| 集成 / MCP（外部应用） | `Authorization: Bearer <VOS_TOKEN>` | `/api/integration/discovery`、`/whoami`、`/mcp` | 应用凭据恒为非管理员、只能访问 public 资源 |

- **远程 introspect**：`src/services/vosAuthService.ts:30-44` 对每个 `/api` 请求向平台 `VOS_USERINFO_URL` 验签（5s 超时、禁止重定向、verifier URL 只来自环境变量），只信平台返回的 `sub` / `enable` / `role_code`，并把角色实时回写本地用户（`:105-108`）。**不是**本地 JWT 验签、不是网关注入、不是共享密钥。
- **VOS 模式跳过**普通模式的 forward-auth JWKS、静态 bearer key、Better Auth 会话、`x-auth-token` 本地 JWT（`src/middlewares/auth.ts:117-130`）；`/api/auth/login`、`/register` 直接 403（`authController.ts:29-32,116-119`）；禁止写入 `skipAuth=true` / `enableBearerAuth=false`（`serverController.ts:2161-2163`）。

#### 1.7.2 401 / 403 / 404 的分模式语义（本方案最易踩雷处）

| 场景 | 普通模式 | VOS 模式 |
| --- | --- | --- |
| 401 | `removeToken()` → 跳 `${getBasePath()}/login` + 明确提示 | **不得跳 `/login`**：`clearVosSession()`（保留现状）→ 下一次请求由 `getVosSession()` 自动重新 PKCE / refresh；仍失败则由 `ProtectedRoute` 渲染 `VosSignIn`（提示检查 VOS 会话 + reload 重试） |
| 403 | 权限不足提示，不触发登录态清理 | 同左；应用凭据访问管理 API、非 admin 创建服务等属预期 403 |
| 404 | 对象不存在 | **可能用于隐藏无权资源**，不得当作登录失效、不得试图「移除权限以发现问题」（`docs/vos-api-reference.zh.md:21,89`） |

**为什么 VOS 模式不能跳 `/login`**：VOS 没有本地密码登录页，`LoginEntry` 在 VOS 模式下渲染的是 `VosSignIn`（`LoginPage.tsx:518`），跳过去并不能重新取 token；后端 `/api/auth/login` 必返 403；注释里的 `/login` 还硬编码了根路径，忽略 `BASE_PATH` 后在 `/app/com.ictrek.mcphub` 下会 404；SPA 嵌在 VOS iframe 中，顶层 `window.location.href` 跳转会破坏平台容器；后端 401 一律 JSON、**无 `Location`、无重定向、无 refresh 端点**（`src/middlewares/auth.ts:127`、`vosAuthController.ts:27`）。因此本方案 v1 中「401 统一跳登录」的表述已在 `1.3 / 3.2 / 3.8` 全部修正为分叉处理。

另注意：现状 `fetchInterceptor.ts:143-151` 会给任何非 2xx 响应体补 `success:false` 与 `HTTP 404: ...` message，即**后端 404 并非字节原样透传**；重构请求层时保持语义分层即可，不要声称存在「原样透传」契约。

#### 1.7.3 绝对不能改的清单

1. `x-vos-token`（管理 API）与 `Authorization: Bearer`（`/auth/vos` 登录、集成/MCP）双通道；登录端点不读 `x-vos-token`、不读 Cookie；VOS 模式不得发送或依赖 `x-auth-token`。
2. 每次请求远程 introspect；不得把角色缓存到前端、不得用 `decodeJwt` 的 claim 授权、不得允许浏览器指定 verifier URL。
3. token 只在内存：不进 localStorage / Cookie / URL / 日志 / 上游透传头（`src/utils/passthroughHeaders.ts:6-29` 已把 `x-vos-token`、`authorization`、`cookie` 列入敏感头黑名单；`docs/vos-user-guide.zh-CN.md:33` 也明确「不要把 VOS token 填成上游 API 密钥」）。
4. VOS 模式 401 不跳 `/login`；401 / 403 / 404 分别处理；后端没有可依赖的 401 重定向或 refresh 端点。
5. 应用凭据恒为非管理员、public-only；用户切换 / subject 变化必须清会话 + reload。
6. 不得放开 `skipAuth` / `enableBearerAuth=false`，不得恢复 VOS 模式的密码登录 / 注册。
7. `Accept-Language`（取自 `i18n.resolvedLanguage`）、`credentials:'include'`、`x-vos-token` 注入的三个条件（VOS 模式 / 同源 app API / 排除 `/auth/vos`）必须保留（`interceptors.ts:26-51`）。
8. 保持「包装链」而非全局 `fetch` 劫持：`fetchInterceptor.ts:61-120` 是显式包装函数，全前端没有 `window.fetch =` 赋值。改成全局替换会污染 `/auth/vos`、VOS 日志流（`logService.ts:130-141` 自己手写 `x-vos-token`）、Better Auth 原生 fetch 与 `loadRuntimeConfig()`。
9. **不得削弱用户隔离**：不得把 `isAdmin` / `permissions` 缓存到前端当授权依据、不得绕过服务端 `filterData` / `findVisibleToUserPaginated`、不得让新增的 query cache / 表单草稿跨账号复用；完整边界见 `1.8`。

#### 1.7.4 受 VOS 耦合的改动面

| 组 | 主要文件 | 必须保留 |
| --- | --- | --- |
| 请求层 | `interceptors.ts`、`fetchInterceptor.ts`、`setupInterceptors.ts`、`services/vosAuthService.ts`、`services/logService.ts`、`services/configService.ts`、`services/authService.ts`、`services/betterAuthClient.ts` | 注入条件、双通道、内存会话、两套 SSE/日志重连、`/public-config` 不注入 |
| 启动 / 路由 / Provider | `main.tsx`（`loadRuntimeConfig` → 写配置 → `initializeVosLocale()` → render 的**顺序**）、`App.tsx`（`basename={getBasePath()}`、`ProtectedRoute`、`/integration-guide` 同级页）、`contexts/AuthContext.tsx`、`components/ProtectedRoute.tsx`、`components/VosSignIn.tsx`、`pages/LoginPage.tsx` | VOS 启动分支、`watchVosUser()`、`logout → clearVosSession()`、VOS 渲染 `VosSignIn` 而非 `<Navigate to="/login">` |
| i18n | `services/vosLocaleService.ts`、`components/ui/LanguageSwitch.tsx`、`i18n.ts`、`interceptors.ts:29-30`、`locales/*.json` 的 `vos` 段 | VOS 只提供 auto / en / zh 且切换语言**不 reload**；普通模式 6 语言 + `i18nextLng` + reload；`Accept-Language` 随请求 |
| 权限 / 菜单 | `Sidebar.tsx`、`components/PermissionChecker.tsx`、`utils/navigationPermissions.ts`、`constants/permissions.ts`、`components/ui/UserProfileMenu.tsx` | 权限判断复用普通模式，勿按 VOS 拆两套；`isAdmin` 来自平台 `role_code`；显示名用 `displayName` |
| 页面 / 地址 | `pages/SettingsPage.tsx`（`vos.compression*` 双语选项、`isHosted` 门控）、`components/ServerForm.tsx`、`components/ServerCard.tsx`、`components/GroupCard.tsx`、`pages/Dashboard.tsx`、`pages/IntegrationGuidePage.tsx`、`utils/runtime.ts`（`getPublicBaseUrl()` 的 VOS 分支） | 复制出的网关地址、VOS PKCE 示例、`owner` 比较、双语标签 |
| 构建 / 部署 | `frontend/vite.config.ts`、`viteBasePath.ts`、`viteProxy.ts`（`/config` 必须被代理）、`frontend/index.html`、`Dockerfile:74-84`、`ictrek.app/src/manifest.yml:17-31` | `BASE_PATH`、PKCE 客户端 `com.ictrek.mcphub`、VOS target |

带 `VOS adaptation` 注释的 17 个前端文件：`App.tsx`、`utils/runtime.ts`、`utils/interceptors.ts`、`contexts/AuthContext.tsx`、`services/vosLocaleService.ts`、`services/logService.ts`、`services/vosAuthService.ts`、`components/ui/LanguageSwitch.tsx`、`components/ProtectedRoute.tsx`、`components/ServerForm.tsx`、`components/ServerCard.tsx`、`components/GroupCard.tsx`、`components/layout/Sidebar.tsx`、`main.tsx`、`pages/LoginPage.tsx`、`pages/SettingsPage.tsx`、`layouts/MainLayout.tsx`。另有 VOS 行为但无注释的 `VosSignIn.tsx`、`IntegrationGuidePage.tsx`、`Dashboard.tsx:108`、`McpbUploadForm.tsx:85`。

#### 1.7.5 已有回归网（可直接复用，不要重复造）

- 后端：`tests/integration/vos-auth.test.ts`（真实 HTTP userinfo 模拟器，覆盖伪造 token / Cookie / 重定向、login 403、角色实时校验、owner 与 404 隐藏、discovery 白名单、MCP transport）、`tests/utils/passthroughHeaders.test.ts:78-90`。
- 前端：`tests/frontend/vosAuthService.test.ts`（PKCE/state、`same-origin` + Bearer、并发去重、账号切换 reload）、`runtimeVos.test.ts`、`vosLocaleService.test.ts`、`logStreamBackoff.test.ts`。
- 部署烟测：`scripts/verify-vos-runtime.py`（env、`x-vos-token`、app Bearer、whoami、discovery）、`ictrek.app/scripts/test_vos_package.py:31`（compose 变量断言）、`.github/workflows/vos-release.yml:34-40`。
- **缺口**：没有 VOS 登录路径的 Playwright E2E，也没有 VOS 模式下的截图基线——由 M0 补齐（`3.1`）；没有账号 A/B 切换的 E2E，也没有持久化数据的隔离用例——同样由 M0 补齐（`1.8`）。

### 1.8 用户隔离（服务端有，前端有缺口）

#### 1.8.1 结论速览

| 层 | 是否隔离 | 机制 / 证据 |
| --- | --- | --- |
| 请求身份 | **有，按请求** | VOS introspect → `req.user`（`src/middlewares/auth.ts:117-130`，`verifiedVosUsers` 是 `WeakMap<Request,...>`）→ `UserContextService` 的 `AsyncLocalStorage` 每请求独立 store（`src/services/userContextService.ts:41-43`）；普通模式走 `x-auth-token` / Better Auth 后进同一 ALS。并发隔离有测试 `tests/services/userContextService.test.ts:33-56` |
| 数据可见性 | **有，服务端强制** | `src/services/dataService.ts:7-34` `filterData`：`applicationId` 仅 public、`item.owner === username`、public、`group` 的 `sharedWithUsers` / `sharedWithUserGroups` + `isAdmin`；server 配置读取比可见性更严，仅 owner/admin 且对共享用户脱敏（`serverController.ts:112-149,1430-1454`） |
| 分实体 | **有** | server：`ServerRepository.ts:118-143` SQL 过滤 + `findVisibleToUserPaginated`；group：`groupService.ts:65-77,92-105,128-134`；tool/prompt/resource 继承所属 server 可见性（`mcpService.ts:1041-1055`）；用户凭据按 `[serverName, username]` 作加密 AAD（`credentialBindingService.ts:89-99,153-157`）；bearer key / OAuth 授权按 owner / username（`bearerKeyController.ts:108-127`、`oauthApprovalController.ts:40-58`）；内置 prompt/resource 是**实例级共享**（读需登录、写需 admin） |
| VOS 专属 | **有** | 稳定身份 `ssoUserId = vos:sha256(sub)` + `sso_user_id` 唯一约束（`db/entities/User.ts:29-30`）、角色每请求实时回写、app 凭据恒 `isAdmin:false` + public-only、`skipAuth` 强制关闭、敏感头不透传、discovery 字段白名单 |
| MCP 上游连接 | **按会话，不按用户** | 默认 `perSessionClient=false` 时所有下游会话**共享同一个上游进程 / 浏览器 / 缓存**；开启后按 `sessionId` 隔离（`mcpService.ts:1058-1063`）；无状态 MCP 的 `clientStateScope = sha256([token, username, group])`。每次工具调用经 `principalServerScope` 绑定可见 server 快照（`:1037,6009,6454`），所以**列表不串**，但有状态上游服务（Playwright 标签页、OpenAPI cookie jar）可能跨用户串状态（D13） |
| 隔离模型 | **单实例多用户，不是多租户** | 一个容器、共享 `mcp_settings.json`（`ictrek.app/src/docker-compose.yml:1-9,18`），无 `tenantId` / `organizationId` 数据模型。边界：平台 admin 全放行（`filterData:10-11`）、public 对实例内所有已认证用户可见、内置项与 systemConfig 实例级共享 |
| 前端内存态 | **部分** | `user-change` / `sub` 变化靠 **`window.location.reload()`** 销毁整个 JS 上下文（`vosAuthService.ts:88-92,168-180`）；但 **401 / logout 不 reload**，`SettingsContext`（bearerKeys / toolPolicies / OAuth 配置）、`ServerContext`（servers）、`logStreamManager`（SSE 单例）、`auth.user` / `isAdmin` / `permissions` 残留 |
| 前端持久化 | **无** | 全部是全局单值 key，切换/登出不清；仓库内**没有** `localStorage.clear()` / `sessionStorage.clear()` / 任何按用户清缓存函数；`mcphub_token` 是唯一被主动清理的 key |
| 服务端 A/B 测试 | **有** | `tests/services/dataService.test.ts:87-152`、`tests/integration/vos-auth.test.ts:184-229,272-350`、`tests/controllers/serverController.test.ts:2466-2488,2696`、`tests/services/groupService-authorization.test.ts:255-283`、`tests/integration/personal-credentials.test.ts:585-727`、`tests/services/mcpService-group-visibility.test.ts:384-485` |

**一句话**：服务端隔离是「读时过滤 + 每请求身份」，前端隔离是「切账号时整页重载」。前端无法通过本地缓存提权，但**会把上一个用户的数据显示给下一个用户**。

#### 1.8.2 前端缺口清单（代码确认）

| 缺口 | 位置 | 后果 |
| --- | --- | --- |
| 草稿 key 无用户维度 | `mcphub_tool_form_<server>_<tool>`（`ToolCard.tsx:127`）、`mcphub_prompt_form_<server>_<prompt>`（`PromptCard.tsx:78`），写入 `DynamicForm.tsx:153,213` | 新用户打开同名工具时 `DynamicForm.tsx:118-124` 自动回填上一个用户的参数；参数可能含 API key / 密钥 |
| 草稿提交后不清 | `ToolCard.tsx:253-254`、`PromptCard.tsx:164-165` 的 `clearStoredFormData()` 被注释；仅「取消」时清（`ToolCard.tsx:132`、`PromptCard.tsx:83`） | 凭据长期驻留浏览器 |
| 偏好类 key 全局 | `theme`（`ThemeContext.tsx:24,33`）、`mcphub_servers_per_page`（`ServerContext.tsx:10,19,429`）、`mcphub.vos.language`（`vosLocaleService.ts:6,38-39`）、`i18nextLng`（`LanguageSwitch.tsx:60`、`i18n.ts:52-54`）、`mcphub.dismissedUpdateVersion`（`changelogService.ts:4,24`） | 切换后原样读到，需按 D11 明确策略 |
| 401 / logout 不 reload 且不清内存 | `interceptors.ts:53-62`、`AuthContext.tsx:213-221` | `SettingsContext` / `ServerContext` / Toast / EmbeddingSync / `interceptors[]` / i18n 单例残留；`ServerContext` 仅在 `isAuthenticated=false` 时清列表 |
| `auth.user` 不同步 | `AuthContext.tsx:42-45` 只在挂载时 `setAuth`；401 后 `session=null` 使 `vosAuthService.ts:88` 的 `sub` 校验不成立、不 reload；重新 PKCE 拿到的 `result.user` 是新用户但无同步逻辑 | 菜单 / 权限 / 显示名停留在上一个用户，直到手动 reload |
| SSE 单例不重建 | `logService.ts:51-56,198-207`；`App.tsx:53` 的 `EmbeddingSyncAlertListener` 常驻使 `subscribers.size > 0`，`close()` 不执行 | 已建立的 VOS 流用建连时的旧 token，最长 240000ms（`:134`）才 abort 重连；后端 SSE 只在建连时鉴权（`logController.ts:35`） |

#### 1.8.3 本方案会放大的风险（必须改设计）

1. **全局 `queryClient` 跨账号**：M1 引入 TanStack Query 后，按现有 Provider 层级（`App.tsx:47-52`）放在顶层，唯一全清机制是 reload；而 `1.7.2` 明确 401 不 reload、现有 logout 也不 reload → 旧用户 cache 会保留到 `gcTime` 结束，新用户直接命中。敏感数据正是 `SettingsContext.tsx:448-460,599-600,1206-1208`（bearerKeys / toolPolicies / OAuth 配置）与 `ServerContext.tsx:143`（servers）。
2. **queryKey 缺用户维度**：`3.2` 原约束只禁 token 进 queryKey，未强制用户维度；`['servers']`、`['settings']` 会跨用户复用。
3. **queryFn 与 `getVosSession` 竞态**：`vosAuthService.ts:48-50` 的 `pending` / `epoch` 只能防陈旧**登录**写回，防不了已发出的 queryFn 在切换后把旧用户响应写进新 cache；401 后 query 自动重试时 `auth.user` 仍陈旧。
4. **SSE 不在 Query 管辖内**：`logStreamManager` 单例必须单独设计按账号 disconnect / reconnect 生命周期。
5. **草稿持久化放大**：若按 `3.5` 给 `ServerForm.tsx` 也加 localStorage 草稿，会把上游 headers / API key / OAuth client secret 写进同一全局命名空间，新用户编辑同名 server 时直接读到。
6. **偏好类 key 需显式策略**：不能默认继承现状（D11）。

#### 1.8.4 必须落进实施的硬约束

1. **queryKey 一律含用户维度**（`subject` 或 `username` 的稳定哈希），禁止 `['servers']` 这类全局 key；`queryClient` 在 `user-change` / `sub` 变化 / logout / 401 时执行 `cancelQueries()` + `clear()`，且必须在 reload 兜底**之前**执行。
2. **提供统一 `resetForUser()`**：清 queryClient、把 `auth.user` 同步到 `getVosSession()` 的最新 `result.user`、重置 `SettingsContext` / `ServerContext` / Toast / EmbeddingSync 状态、取消 in-flight 请求、`logStreamManager.disconnect()` 并用新 token 重连、清 `useCostData` 重试定时器与轮询定时器；必须覆盖 **401 与 logout 这两条不 reload 的路径**（D12）。
3. **持久化 key 按用户分区**（D11）：草稿类 key 含用户维度、提交成功即删、**禁止把 Bearer / API key / OAuth secret 写入全局 localStorage**；`reload()` 不能当作「清理」的同义词。
4. 保留 `clearVosSession() + window.location.reload()` 作为账号切换兜底，但 reload 之前先执行 1–3 的清理。
5. **不得把 `isAdmin` / `permissions` 缓存到前端当授权依据**；不得绕过服务端 `filterData` / `authorizationService` / `findVisibleToUserPaginated`；404 用于隐藏无权资源，不得改成错误提示或登录失效。注意 `filterData()` 无 user 且 ALS 为空时返回全部（`dataService.ts:10-11`）——本方案不改后端，新增前端代码也不得依赖「后端返回了就一定可见」。
6. **M0 建 A/B 双账号 E2E**：A 建私有 server、写工具草稿、改设置 → 切到 B → 断言 B 看不到 A 的 server、草稿不回填、query cache 已清空、SSE 用 B 的 token、菜单权限随 B 刷新；普通 / VOS 两个 project 都跑。
7. **复用服务端既有 A/B 测试**（`1.8.1` 末行清单），不重复造；前端新增用例覆盖 `tests/frontend/vosAuthService.test.ts` 尚未覆盖的持久化与 SSE 清理。

---

## 2. 思路

### 2.1 根因归纳

1. **半成品设计系统迁移**：`index.css:12` 注释 `redesign tokens`、`:148` `only used in redesigned screens`、`:534` `Retrofit legacy utility classes` 说明 Dashboard / Servers / Sidebar 已换成 `hub-*`，而 Settings、各类表单与弹窗仍是旧 Tailwind 灰蓝风。因为缺设计交付与 UI 规范（`*.fig` 0 个、39 个 md 无视觉规范），没有人能对齐剩余页面，于是用 213 处 `!important` 把旧类强行刷成新色。
2. **缺失服务端状态层与统一反馈层**：无缓存、无去重、无失效策略；`refreshKey` 全量重拉；错误被请求层吞掉；成功操作普遍静默；按钮 loading 靠 DOM 打补丁。用户感知为「点一下没反应、过一会儿自己变了、偶尔还抖一下」。
3. **零回归保护**：`frontend/` 0 个组件测试、CI 不跑 build、格式检查不含 `.tsx`。任何视觉或交互改动都没有安全网，这是「越改越难看」的机制，也是本方案必须先修的东西。
4. **双部署形态放大了改动成本**：VOS 与普通模式在登录态、请求头、路由前缀、语言选项、地址展示上都不同，17 个文件带 VOS 分支。任何「统一」都可能顺手抹掉一个分支，因此 VOS 必须在 M0 就进入回归网，而不是等上线前再验证。

五者互相放大：因为没网，所以不敢删 `!important`；因为两套样式，所以每个交互要改两遍；因为状态混乱，所以反馈更不可信；因为双模式，所以每遍改动要验两次；因为隔离靠读时过滤，所以新增的前端缓存必须按用户分区。

### 2.2 五条原则

- **P1 后端契约不变、每阶段可独立上线与回滚。** 不改接口，按里程碑切 PR，任一阶段出问题可单独 revert。
- **P2 单一事实来源。** 一套 token、一套组件、一套请求/反馈规范、一套验收清单。禁止再出现「第三套按钮」。
- **P3 每一刀都带回归网。** 先有测试/截图基线，再改行为；每个 PR 用同一组命令和同一份 checklist 验收。
- **P4 双模式是默认前提。** 普通模式与 VOS 模式同时设计、同时实现、同时验收；请求层、路由、登录态、i18n 的任何改动都要回答「VOS 下会怎样」。`1.7` 的 9 条「绝对不能改」是硬边界，不属于可取舍范围。
- **P5 用户隔离不降级。** 服务端隔离保持原样；前端任何缓存、草稿、单例、身份状态都必须带用户生命周期，账号切换后不得残留上一个用户的数据。完整边界见 `1.8`。

### 2.3 两条并行线，在逐页迁移处汇合

```text
线 A（体感 / 工程）   M0 安全网 ──> M1 数据与反馈 ──────────────┐
                                                              ├──> M3 逐页迁移 ──> M4 信息架构 ──> M5 防回退
线 B（观感 / 设计）   M2 视觉定稿 ──> M2 token + 组件库 ───────┘

贯穿全程：VOS 双模式回归（M0 建基线 → M1 请求层护栏 → M2/M3 双模式截图 → M4 basename/深链 → M5 固化规范）
```

M1 完全不动样式类名，M2 只建地基不铺开到全站；两条线在 M3 汇合：**每迁移一个页面，同时把该页的交互换到 M1 的新状态/反馈规范和 M2 的新组件上**，避免「先换肤、再改交互」的二次返工。VOS 不作为第三条线，而是前两条线上每个 PR 的验收维度。

### 2.4 顺序与取舍

| 决策 | 理由 |
| --- | --- |
| M0 必须第一 | 没有组件测试 / E2E / build CI 就动 4633 行页面，无法证明改好还是改坏；VOS 双模式基线也要在这里建 |
| M1 先于 M2，且一行 CSS 不改 | 「难用」里体感占比最大的部分（抖动、无反馈、重复请求）只需改约 5 个文件，风险最低、见效最快 |
| **401 必须按模式分叉，不能「统一跳登录」** | VOS 无密码登录页、`/api/auth/login` 返 403、硬编码 `/login` 丢 `BASE_PATH`、iframe 顶层跳转破坏容器；详见 `1.7.2` |
| **请求层保持包装链，不做全局 `fetch` 劫持** | 换成全局替换会污染 `/auth/vos`、VOS 日志流、Better Auth 与 `loadRuntimeConfig()`；新状态层要包在 `fetchWithInterceptors` 之上，而不是替换它 |
| 213 个 `!important` 不能一次删 | 它们现在是旧页面的承重墙；必须等某页迁完再删对应 retrofit 段，否则旧页面瞬间裸奔 |
| M4 放最后 | 拆巨型表单与设置页风险最高，且依赖 M1 的状态层与 M2 的组件层；提前做会返工 |
| 不用 shadcn 全套 | 已有 27 个 `components/ui/` 组件和 `hub-*` token 是资产；重建薄组件层成本更低，且避免三套体系并存 |
| 逐页 PR 而非一次性刷全站 | 45 个文件仍用旧色类，一次性改动不可评审、不可回滚；每页截图对比可累积信任 |
| VOS 专属组件不「顺手统一」 | `VosSignIn`、`LanguageSwitch` 的 auto/en/zh、Sidebar 集成指南入口、`getPublicBaseUrl()` 复制地址、`vos.compression*` 双语选项都是功能，不是样式冗余 |
| `design-taste-frontend` 不进后台 | 它是营销官网/落地页专用，硬性规则（hero 一屏一节、真实照片、无图注、60-80 词/屏）与管理面板冲突 |
| **缓存与草稿必须按用户分区，不能默认继承现状** | 服务端隔离靠读时过滤，前端新增 query cache / 表单草稿会成为新的串号入口（`1.8`）；M1 与 M4 必须显式设计用户生命周期，A/B 双账号 E2E 在 M0 就建好 |

### 2.5 skill 分工

| skill | 使用阶段 | 用途 |
| --- | --- | --- |
| `huashu-design` | M2 | 出 3 个视觉方向的高保真原型供定稿（其说明明确「生产级 Web App 不适用」，故只用于原型，不直接改项目代码）；原型需包含 VOS 容器内的 1440 / 390 两档 |
| `frontend-design` | M2 / M3 | 组件视觉与信息层级的品味约束 |
| `web-design-guidelines` | M2 / M3 | 每页验收：a11y、focus states、forms、URL 反映状态、dark mode、touch、i18n 等 100+ 规则；两种模式各跑一遍 |
| `vercel-react-best-practices` | M1 / M4 | 消除请求瀑布、re-render、bundle 体积；6 语言按语言懒加载时保留 VOS 语言跟随逻辑 |
| `vercel-composition-patterns` | M4 | 组合模式拆分巨型组件、消除 props drilling |
| `webapp-testing` + `playwright-cli` / `agent-browser` | M0 起全程 | E2E、交互断言、**普通 + VOS 双模式**的 1440/390 截图与截图 diff |
| `lsp-code-analysis` | M1 / M4 | 重构前的影响面分析；M1 特别用来查 `getVosSession` / `isVosMode` / `x-vos-token` 的全部引用 |
| `skill-creator` | M5 | 编写项目内 `mcphub-ui` 规范 skill，内含 VOS 硬约束 |
| `design-taste-frontend` | 不用于本方案 | 保留给未来的官网 / 落地页 |

### 2.6 环境准备

已安装并可由 CodeBuddy / Claude Code 识别（2026-11-13 核验）：

```text
~/.codebuddy/skills/   design-taste-frontend, frontend-design, huashu-design, image-studio,
                       vercel-composition-patterns, vercel-react-best-practices,
                       webapp-testing, web-design-guidelines
~/.agents/skills/      frontend-design, huashu-design, vercel-composition-patterns,
                       vercel-react-best-practices, webapp-testing, web-design-guidelines
```

运行时：Node `v22.23.1`；Playwright Chromium 已缓存于 `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`；`ffmpeg` 可用。

`CHROME_PATH` 当前未设置。Playwright 自带浏览器解析，本方案的 E2E 不受影响；仅 `design-taste-frontend` 自带的 `gate.mjs` / `shoot.mjs` 等脚本只查找 `/usr/bin/google-chrome`、`/usr/bin/chromium` 或 `CHROME_PATH`，若将来要用需显式设置：

```bash
export CHROME_PATH="$HOME/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"
```

VOS 本地 / CI 环境需要额外准备两种模式（M0 落地，方式由 D9 确定）：普通模式用 `pnpm dev`；VOS 模式至少要能稳定提供 `vosAuthEnabled: true` 的 `/config` 与 `window.vos_platform` bridge。完整 introspect 链路可复用 `tests/fixtures/vos-userinfo.mjs`，发布前用 `scripts/verify-vos-runtime.py` 做容器烟测。

---

## 3. 具体实施

### 3.0 每个 PR 的固定流程与命令

以下条件命令为**建议命令**，涉及新依赖的安装会修改 `pnpm-lock.yaml`，执行前先在 PR 中锁定版本并确认影响面。

```bash
# 本地开发（另开终端常驻，供 E2E 使用）
pnpm dev

# 每次提交前
pnpm format                       # 需先扩展脚本覆盖 .tsx 与 frontend/（见 M0）
pnpm lint
pnpm frontend:typecheck
pnpm test:ci                      # 含 tests/integration/vos-auth.test.ts 与 tests/frontend/vos*.test.ts
pnpm exec vitest run              # Vitest 引入后可用
npx playwright test               # 普通 + VOS 两个 project（见 M0）
pnpm frontend:build
pnpm docs:validate                # 仅编译 docs/ 下 .mdx

# 发布前 VOS 容器烟测（需要已构建的 vos 镜像 / 运行容器，不作为每次 PR 的必需步骤）
python3 scripts/verify-vos-runtime.py
python3 ictrek.app/scripts/test_vos_package.py
```

浏览器验收（`webapp-testing` / `playwright-cli`）：每条黄金路径在 1440 与 390 各截一张图，与本页基线对比；**普通模式与 VOS 模式各跑一遍**；用 `web-design-guidelines` 跑一遍审查，FAIL 项要么修、要么在 PR 描述里逐条说明理由。VOS 模式的截图基线必须包含 `VosSignIn` 失败态与「语言跟随 VOS」态。

### 3.1 M0 · 安全网（0.5–1 天，第一刀）

**目标**：让后续每个改动都有可证明的回归网，**并先把 VOS 双模式基线建起来**。

| 文件 / 位置 | 动作 |
| --- | --- |
| `frontend/vitest.config.ts`（新建） | Vitest + jsdom + Testing Library，**独立配置，不改动后端 Jest**，避免影响现有 300+ 后端用例 |
| `tests/frontend/` | 补首批组件用例：Toast 队列、Modal 键盘行为、Button 三态、ErrorState 重试；补 `interceptors` 双模式断言（VOS 注入 `x-vos-token` 且不发 `x-auth-token`、普通模式反之、`/auth/vos` 不注入） |
| `e2e/`（新建）+ `playwright.config.ts` | 3 条黄金路径（① 新增 server → 启停 → 删除；② 分组配置；③ 设置保存 → 刷新后仍在）拆成 **两个 Playwright project**：`standalone`（普通密码登录）与 `vos`（VOS bridge / introspect 模拟）；两条路径都跑同一组用例 |
| `e2e/fixtures/vos/`（新建） | 按 D9 提供 VOS 模拟：`addInitScript` 注入 `window.__MCPHUB_CONFIG__` 与 `window.vos_platform` stub + 路由 `/config`、`/auth/vos`；完整模式另起 `VOS_AUTH_ENABLED=true` + `VOS_USERINFO_URL` 指向 `tests/fixtures/vos-userinfo.mjs` 的后端 |
| `e2e/__screenshots__/` | **普通 / VOS × 1440 / 390** 四组基线截图入库；VOS 额外存 `VosSignIn` 失败态 |
| `e2e/isolation.spec.ts`（新建） | **A/B 双账号切换用例**（`1.8.4` 第 6 条）：A 建私有 server + 写工具草稿 + 改设置 → 切到 B → 断言私有 server 不可见、草稿不回填、query cache 已清空、SSE 用 B 的 token、菜单权限随 B 刷新；普通 / VOS 两个 project 都跑 |
| `package.json:28` | `format` 从 `"src/**/*.ts"` 扩展到 `.tsx` 与 `frontend/` |
| `eslint.config.mjs:20,33-46` | 加 `eslint-plugin-jsx-a11y` 与 `react-hooks` 规则，先 warn 不阻断 |
| `tests/frontend/translationCoverage.test.ts:21-36` | 翻译覆盖校验从 en/zh 扩到 6 语言，并覆盖动态 key 与 `\|\| 'English fallback'` 兜底串；`vos.*` 键单独断言 |
| `.github/workflows/ci.yml:57-121` | 恢复 `build` job（`pnpm build` + `node scripts/verify-dist.js`）；新增 E2E job（普通 + VOS 两个 project）；把 `pnpm frontend:build` 设为必需；保留既有 `vos-release.yml` 的打包断言 |

建议依赖（示例，版本待 PR 锁定）：

```bash
pnpm add -D vitest jsdom @testing-library/react @testing-library/user-event @playwright/test eslint-plugin-jsx-a11y
```

**验收**：CI 全绿、3 条黄金路径在普通 / VOS 两个 project 均绿、四组基线截图入库、`pnpm build` 恢复运行；`tests/integration/vos-auth.test.ts` 与 `tests/frontend/vosAuthService.test.ts` 保持通过。
**回滚**：本阶段只增测试与配置，revert 无业务影响。

### 3.2 M1 · 数据与反馈（2–3 天，体感提升最大、样式零改动）

**目标**：界面从「抖、没反应」变成「稳、有回应」，同时不碰 VOS token 链路的一根线。

| 文件 | 动作 |
| --- | --- |
| `frontend/src/utils/fetchInterceptor.ts:21-39,143-161` | 错误不再吞：返回明确 Result 类型或抛 `ApiError`；删除全局 click 监听 + `is-loading` class 的 DOM hack；**保持显式包装链，不改成全局 `fetch` 劫持**；401 / 403 / 404 分别归类，404 不触发登录态清理 |
| `frontend/src/utils/interceptors.ts:26-65` | **401 分模式处理**：普通模式 `removeToken()` + 跳 `${getBasePath()}/login` + 提示；VOS 模式保留 `clearVosSession()`、**不跳转**、让 `ProtectedRoute` → `VosSignIn` 承接；同时保留 `x-vos-token` 注入三条件、`x-auth-token` 互斥、`Accept-Language`、`credentials:'include'` |
| `frontend/src/contexts/ToastContext.tsx:23-42`、`components/ui/Toast.tsx:93-103` | Toast 队列化（不再互相覆盖）、加 `role="status"` / `aria-live`、按类型区分 success/error/info |
| `frontend/src/pages/ServersPage.tsx:141-149` | 删除固定 400ms 假转圈 |
| `frontend/src/pages/ServersPage.tsx:191-213`、`GroupsPage.tsx:67-85`、`UsersPage.tsx:70-88`、`MarketPage.tsx:296-314`、`Dashboard.tsx:136-158` | 5 份重复错误 banner 抽成统一 `<ErrorState onRetry>`；重试不得重建 VOS 会话，只重发原请求 |
| `frontend/src/components/ui/Button.tsx:45-95` | 把已有的 Promise-loading / spinner / disabled 能力推广到所有表单与弹窗按钮，加 `aria-busy` |
| `frontend/src/contexts/ServerContext.tsx:85-178` + `utils/serverPolling.ts` | 轮询改为可控 `refetchInterval`；`visibilitychange` 时暂停；数据 hash 未变不 `setServers`；轮询间隔与 270s 会话上限的关系按 D8 确认，避免把 `getVosSession()` 变成高频 PKCE |
| `hooks/useGroupData.ts`、`useUserData.ts`、`useCostData.ts`、`useMarketData.ts` | 换成统一 query hooks：请求去重、`invalidateQueries` 替代 `refreshKey` 全量重拉；**queryKey 必须含用户维度**（`subject` / `username` 的稳定哈希），禁止 `['servers']` 这类全局 key；**cache / queryKey 里不得出现 token 或明文身份数据**；`queryClient` 在账号切换 / logout / 401 时 `cancelQueries()` + `clear()`（`1.8.4`） |
| `frontend/src/contexts/AuthContext.tsx`、`SettingsContext.tsx`、`ServerContext.tsx`、`services/logService.ts` | 新增统一 `resetForUser()`：把 `auth.user` 同步到 `getVosSession()` 的最新 `result.user`（现状只在挂载时 `setAuth`）、清空设置/服务器/Toast/EmbeddingSync 状态、取消 in-flight 请求与重试定时器、`logStreamManager.disconnect()` 后用新 token 重连；覆盖 **401 与 logout 两条不 reload 的路径**（D12） |
| 所有 mutation 调用点 | 统一 success / error / pending 三态；补上当前静默的成功反馈（新增/编辑 server、group/user CRUD） |
| `pages/SettingsPage.tsx:721,1636,1690` | 保存成功改用 `success` 类型而非默认 `info` |
| `services/logService.ts:74-167`、`services/configService.ts:121-153`、`services/betterAuthClient.ts` | 不动其 VOS 分支；仅核对新请求层没有把它们改成走统一包装链；SSE 单例的账号生命周期由 `resetForUser()` 单独接管 |
| `components/ui/DynamicForm.tsx:118-124,153,213`、`ToolCard.tsx:127,253-254`、`PromptCard.tsx:78,164-165` | 草稿 key 按用户分区、**提交成功即删**（恢复被注释的 `clearStoredFormData()`）；禁止把 Bearer / API key / OAuth secret 写入全局 localStorage（D11） |

建议依赖（示例）：`pnpm add -D @tanstack/react-query`（决策 D4）。

**VOS 请求层护栏（本阶段必须写进测试）**：

- `getVosSession()` 仍是每个 app API 请求 `await` 的来源；新状态层只能包在 `fetchWithInterceptors` 之上，不能绕过拦截器直接 `fetch`。
- 401 之后 VOS token 不得被写入 query cache、URL、localStorage 或错误日志；`clearVosSession()` 后由下一次 `getVosSession()` 自然重新授权，不主动调用 `window.location.reload()`（避免循环）。
- `/auth/vos`、`/config`、`/public-config`、VOS 日志流必须继续走各自原生路径，不被新拦截器二次注入。
- **账号切换隔离**（`1.8.4`）：`queryClient` 与所有 Provider 缓存在 `user-change` / `sub` 变化 / logout / 401 时必须清理；`epoch` 只防陈旧登录写回，还需要在 `queryFn` 里对响应做用户维度校验，避免旧响应写进新 cache；`resetForUser()` 必须在 reload 兜底之前执行。
- **不得把 `isAdmin` / `permissions` 落盘或当授权依据**；服务端 `filterData` 无 user 时会返回全部，因此前端不得因为「接口返回了」就默认当前用户可见。
- 改动前用 `lsp-code-analysis` 列出 `isVosMode` / `getVosSession` / `x-vos-token` / `localStorage` 的全部引用，逐个确认。

**验收**：

- Network 面板中 `/groups` 从 4 个请求变 1 个；**VOS 模式下每个管理请求仍带 `x-vos-token`，且不带 `x-auth-token`**。
- 后台标签页 0 轮询；服务器数据未变化时消费者不重渲染。
- 每个写操作都有确定反馈；断网 / 500 有重试入口；**普通模式 401 跳登录页、VOS 模式 401 落到 `VosSignIn` 且不发生顶层跳转**。
- 403 / 404 不触发清会话；`VosSignIn` 的 reload 重试可用。
- M0 的三条黄金路径在普通 / VOS 两个 project 全绿；新增「断网重试」「401 分模式」「token 不落盘」用例；`tests/integration/vos-auth.test.ts` 通过。
- **A/B 双账号 E2E 通过**（`1.8.4` 第 6 条）：切换后私有 server 不可见、草稿不回填、query cache 清空、SSE 用新 token、`auth.user` / 菜单权限随新用户刷新；401 与 logout 两条不 reload 的路径也要断言。
- 服务端既有 A/B 用例（`tests/services/dataService.test.ts`、`tests/integration/personal-credentials.test.ts` 等）保持通过。

**回滚**：逐文件 revert；请求层改动需同时回退调用点，故按一个 PR 整体提交。

### 3.3 M2 · 视觉定稿与地基（3–5 天）

**目标**：确定唯一视觉基线，建好 token 与组件层，为逐页迁移提供承重结构。

**步骤 1 · 定稿**：`huashu-design` 基于真实的 Dashboard / Servers / Settings 三屏出 3 个方向的高保真 HTML 原型，需求方选定一稿（D1）。未定稿不启动 M3。同时确定 D2（品牌主色）、D3（字体）。原型需包含 VOS 容器（iframe、`/app/com.ictrek.mcphub` 前缀）下的 1440 / 390 表现，确认在 VOS 外壳中的对比度与边距。

**步骤 2 · token**：在 `index.css` 用 Tailwind v4 `@theme` 重建，替换 `index.css:13-47` 现有 16 个颜色变量 + 1 个字体栈的散装定义。建议分组：

| 分组 | 建议 token | 说明 |
| --- | --- | --- |
| 表面 | `--hub-bg`、`--hub-bg-2`、`--hub-surface`、`--hub-surface-hover` | 背景与卡片 |
| 文字 | `--hub-ink`、`--hub-ink-2`、`--hub-ink-3` | 三级文字层级 |
| 线条 | `--hub-line`、`--hub-line-2` | hairline border |
| 语义色 | `--hub-accent`、`--hub-accent-soft`、`--hub-ok`、`--hub-warn`、`--hub-err` | light / dark **各一套完整值**，补齐 `.dark` 当前缺的 4 个 |
| 尺度 | 4pt 间距阶梯、单一 radius 尺度、2 级 shadow、字号阶梯、`--hub-z-*` 分层 | 收敛 `z-50 / z-[60] / z-[100]` 与 4~999px 圆角 |
| 字体 | `--hub-mono` | 加载字体文件或删除声明，不留空声明 |

现有 `hub-*` 类保留为兼容层并标记 deprecated，迁移完成后再删除。

**步骤 3 · 组件层**：扩展 `frontend/src/components/ui/`（现有 27 个组件），全部走 `utils/cn.ts` + cva：

| 组件 | 替换对象 | 关键要求 |
| --- | --- | --- |
| `Button` | 三套并存：`ui/Button.tsx`、`index.css:149-174` `.hub-btn`、`index.css:595-682` `.btn-*` | 唯一按钮对（primary / secondary），step / press 动效，Promise loading |
| `Input` / `Select` | `SettingsPage.tsx` 中复制 20+ 次的 `block w-full py-2 px-3 border border-gray-300 ...` | 字段级错误、`aria-invalid` / `aria-describedby`、必填标注 |
| `Modal` | 13+ 处手写 `fixed inset-0` 弹窗 | `role="dialog"` / `aria-modal`、Escape、焦点陷阱、打开聚焦、关闭后焦点归还、统一 z-index |
| `Toast` / `ErrorState` | M1 已实现 | 接入组件层统一导出 |
| `Table` / `EmptyState` / `Skeleton` / `Tabs` / `Switch` | 各页重复实现 | 骨架屏替代纯文字 loading；空状态带 CTA |

**VOS 专属件不得被「统一」掉**：`VosSignIn`（失败态 + reload 重试）、`LanguageSwitch`（VOS 只有 auto/en/zh、切换不 reload，普通模式 6 语言 + reload）、`Sidebar` 的集成指南入口、`ServerCard` / `GroupCard` 的 `getPublicBaseUrl()` 复制完整网关地址、`SettingsPage` 的 `vos.compression*` 双语选项、`UserProfileMenu` 的 `displayName`。这些都是功能分支，不是样式冗余；换 token 与组件时逐一在 VOS 模式截图确认。

**步骤 4 · 无障碍收口**：恢复 `index.css:520`、`:201`、`:702` 抹掉的焦点样式；修 `ConfirmDialog.tsx:109-144` 的 Enter 竞态；删除 `ActivityPage.tsx:126-139` 的原生 `window.confirm` / `alert`；`Dashboard.tsx:211-217` 的 `div onClick` 改为可键盘操作元素。

**步骤 5 · 响应式地基**：

| 断点 | 行为 |
| --- | --- |
| 1440 | 完整 10 列服务器表格、232px 侧栏 |
| 1024 | 侧栏可折叠 / 抽屉化，列数收敛 |
| 768 | 服务器卡片改为两列卡片流，横向滚动局部化 |
| 390 | 一列、按钮全宽、全屏菜单、控件最小 44px 触控高度、无页面级横向滚动 |

把 `index.css:410` 与 `:1144` 两个媒体查询替换为上述四档；`Content.tsx:8-11` 的整区横向滚动改为卡片容器局部滚动。VOS 容器本身有平台外壳，窄屏验收需按「VOS 模式 + 390」单独跑一次。

**验收**：`web-design-guidelines` 审查 0 critical；390 / 768 / 1024 / 1440 在普通 / VOS 两模式无溢出与重叠；明暗两主题截图一致；VOS 专属件功能抽查通过；`pnpm frontend:build` 通过。
**风险**：本阶段只建地基，不批量替换页面类名，旧 `!important` 段暂时保留，生产页面观感不变。

### 3.4 M3 · 逐页迁移（每页 0.5–1 天，可增量上线）

**目标**：把两套视觉收敛成一套，并在同一 PR 里把该页交互换到 M1 / M2 的规范上。

**顺序**（高频 × 视觉落差）：

| 序 | 页面 | 主要文件 | 迁移重点 |
| --- | --- | --- | --- |
| 1 | `/servers` | `ServersPage.tsx`、`ServerCard.tsx`、`AddServerForm.tsx`、`EditServerForm.tsx` | 10 列卡片、启停 Switch、删除/重装确认弹窗、筛选与空状态；`ServerCard` / `ServerForm` 带 VOS 注释 |
| 2 | `/settings` | `SettingsPage.tsx`（4633 行 / 11 折叠区） | 旧色类约 290 处、20+ 重复输入框、数值校验 toast 改为字段级错误；保留 `vos.compression*` 与 `isHosted` 门控 |
| 3 | `/market` | `MarketPage.tsx`、`MarketServerDetail.tsx`、`RegistryServerDetail.tsx` | 分类侧栏、卡片、标签、搜索与分页 |
| 4 | `/groups`、`/users` | `GroupsPage.tsx`、`GroupCard.tsx`、`UsersPage.tsx` | 卡片、CRUD 弹窗、空状态 CTA；`GroupCard` 的 owner 比较见 D10 |
| 5 | `/dashboard` | `Dashboard.tsx`、`Sidebar.tsx`、`Header.tsx` | 已是 `hub-*` 风格，只做对齐与响应式收口；保留 `getPublicBaseUrl` / 集成指南入口 / 版本显示 |
| 6 | 其余 | `PromptsPage`、`ResourcesPage`、`ActivityPage`、`LogsPage`、`CredentialsPage`、`LoginPage`、`OAuthConsentPage` | 按同一 checklist 收尾；`LoginPage` 的 `LoginEntry` 分支与 `VosSignIn` 必须保留 |

**每页 checklist**：

- [ ] 旧 Tailwind 灰/蓝类换成语义 token 类；删除该页对应的 `index.css` retrofit `!important` 段。
- [ ] inline style 收编到组件或 CSS 类；硬编码颜色、圆角、z-index 收敛到 token。
- [ ] 表单 / 弹窗 / 列表 / 反馈换成 M1、M2 的统一组件，补齐三态与键盘行为。
- [ ] 筛选、页码、展开项写进 URL（`web-design-guidelines` 的 "URL reflects state" 规则），路径带 `BASE_PATH`。
- [ ] **逐条核对 `1.7.4` 中该页涉及的 VOS 分支**（尤其 17 个带注释文件），确认功能没有在换组件时被删掉。
- [ ] 文案变更同步 6 个 locale，并跑翻译覆盖检查；`vos.*` 键不丢。
- [ ] **普通 / VOS × 1440 / 390** 四张截图对比基线，PR 附图；`web-design-guidelines` 审查通过。
- [ ] `pnpm frontend:typecheck`、`pnpm exec vitest run`、`npx playwright test`（两个 project）全绿。

**纪律**：`!important` 只能「随页删」，不能提前全删。迁移期间允许新旧类短暂共存，但每页 PR 必须净减少补丁数量。

**验收**：每页 `!important` 归零、inline style <10 处/页、axe 0 critical、两个 E2E project 全绿、VOS 专属功能抽查通过。

### 3.5 M4 · 信息架构（5–7 天，最后做）

**目标**：解决「跳转 → 弹窗 → 巨型表单 → 二次确认 → 全表重拉」的路径过长问题。

| 文件 | 动作 |
| --- | --- |
| `components/ServerForm.tsx`（2618 行） | 用 `vercel-composition-patterns` 拆成 Basic / Connection / Advanced / OAuth 四步（或 tab）+ `useServerForm` reducer；React Hook Form + Zod 做字段级校验、必填标注、脏数据保护（关闭前确认 / 草稿）；**草稿必须按用户分区、提交成功即删、禁止把 headers / API key / OAuth secret 写入全局 localStorage**（`1.8.4`、D11）；保留文件首行的 VOS 双语标签注释 |
| `pages/SettingsPage.tsx`（4633 行） | 拆成 `/settings/*` 子路由 + 侧栏二级导航；11 个折叠 section 状态进 URL hash / search param；保留 `vos.compression*` 双语选项与 `isHosted` 门控 |
| `App.tsx:13,44-52,80-100` | 新增深链 `/servers/:name`、`/groups/:id`、`/market/:name`；**保持 `basename={getBasePath()}`**，禁止硬编码 `/login` 等根路径；保留 `/integration-guide` 同级页与旧路由重定向；通配路由不再无脑回首页 |
| `pages/ServersPage.tsx:50-60,216-271` | 加排序、批量启停/删除、筛选与页码进 URL |
| `pages/GroupsPage.tsx`、`UsersPage.tsx`、`ActivityPage.tsx` | 补搜索 / 分页 / URL 同步；6 个筛选条件写进 URL |
| `components/ui/UserProfileMenu.tsx:66-69,94` | 按 D7 确认登出语义；VOS 下不得让「登出」被误解为退出 VOS 平台，也不得触发顶层跳转 |
| `frontend/src/i18n.ts`、`locales/*.json` | 6 个语言包改为按语言懒加载（`vercel-react-best-practices` 的 bundle 规则）；**VOS 的 `initializeVosLocale()` / 语言跟随 / auto-en-zh 选项必须保留，且懒加载不能破坏渲染前的语言初始化顺序**（`main.tsx:14-52`） |

建议依赖（示例）：`pnpm add -D react-hook-form zod @hookform/resolvers`（决策见 D4/D5）。

**验收**：黄金路径 E2E 覆盖新深链且**普通 / VOS 两个 project 都带正确 `BASE_PATH`**；刷新不丢筛选与折叠位置；浏览器后退可用；VOS 模式语言跟随与 `VosSignIn` 仍可达；**新增的 `ServerForm` 草稿按用户分区、提交成功即删、不落凭据，A/B 用例断言切换后不回填**；bundle 体积不高于改造前；`pnpm build` + `verify-dist.js` 通过。

### 3.6 M5 · 防回退（持续）

- 用 `skill-creator` 在 `mcphub/.agents/skills/mcphub-ui/` 写项目内规范 skill，内容至少包括：token 单一来源与命名、组件清单与用法、每个操作必须有 success / error / pending / 空态、Modal 键盘规范、390px 验收、i18n 6 语言同步、PR 截图要求、禁止新增 `!important` 与 inline style，**并把 `1.7.3` 的 9 条 VOS 硬约束、`1.8.4` 的 7 条用户隔离硬约束、「每个 PR 必须双模式 + A/B 账号验收」写进去**。
- 新增持久化 / 缓存代码时必须走 `resetForUser()` 与按用户分区的 key 规范；代码审查检查项里加一条「这个 key / cache 在账号切换后还留着吗」。
- 把 `web-design-guidelines` 审查、Playwright 双模式截图 diff、`pnpm test:ci`（含 `vos-auth` 与 `vosAuthService` 用例）固化为 PR 模板检查项；发布流程保留 `scripts/verify-vos-runtime.py` 与 `ictrek.app/scripts/test_vos_package.py` 烟测。
- 死代码清理：`CloudServerDetail.tsx` / `useCloudData.ts`（`/cloud` 已重定向到 `/market`）、三套市场 UI 合并、`AddGroupForm` / `EditGroupForm` 合并；清理前用 `lsp-code-analysis` 确认不是 VOS 分支在用。
- 可选：组件 Storybook 与视觉回归服务（Percy / Chromatic），当前仓库 0 个 `*.stories.*`；若引入，Storybook 需支持 VOS 模式的配置注入以便展示 `VosSignIn` / 语言菜单。

### 3.7 里程碑与估算

| 里程碑 | 内容 | 估算 | 前置 |
| --- | --- | --- | --- |
| M0 | 安全网 + VOS 双模式基线 | 0.5–1 天 | D9（VOS E2E 模拟方式） |
| M1 | 数据与反馈（含 401 分模式） | 2–3 天 | M0、D8（会话节奏） |
| M2 | 视觉定稿 + token + 组件库 | 3–5 天 | D1/D2/D3 定稿；可与 M1 并行 |
| M3 | 逐页迁移 | 每页 0.5–1 天 | M1 + M2 |
| M4 | 信息架构 | 5–7 天 | M1 + M2、D7（登出语义）、D10（owner 显示） |
| M5 | 防回退 | 持续 | M3 启动后即可 |

**建议起手式**：第一周做 M0 + M1 + M2 的定稿。M0 半天架网（含 VOS 双模式基线），M1 两三天让界面立刻「不抖、有回应」（「难用」体感的主要来源），同时出 3 稿视觉方向。**该周不改任何样式类名**，风险最低，且避免方向未定就刷 45 个页面导致返工；M1 的 401 改造必须按 `1.7.2` 分叉，碰请求层前先跑一遍 VOS 集成用例。

### 3.8 验收总表

- [ ] G1：`!important` 补丁 0；inline style <30 处；light/dark 语义色完整；品牌主色唯一
- [ ] G2：所有写操作三态齐全；**401 分模式处理**（普通跳登录页、VOS 落 `VosSignIn`）；403/404 不误清会话；错误可重试；Toast 有队列与 `aria-live`
- [ ] G3：`/groups` 单页面 1 个请求；后台标签页 0 轮询；数据未变不重渲染；无 DOM loading hack 与假转圈
- [ ] G4：390 / 768 / 1024 / 1440 无溢出；键盘可达全部控件；焦点可见；axe 0 critical
- [ ] G5：组件测试 + 3 条 E2E + 视觉基线进 CI；`pnpm build` 为必需 job；巨型文件拆分完成
- [ ] G6：筛选 / 页码 / 展开 / 选中状态进 URL，刷新不丢、后退可用；全部深链带 `BASE_PATH`
- [ ] **G7**：VOS 管理请求均带 `x-vos-token` 且不带 `x-auth-token`；`/auth/vos` 仍走 Bearer；token 不进 localStorage / Cookie / URL / 日志 / 上游透传头；introspect 与角色钳制不变；`VosSignIn` 可达、语言跟随 VOS 可用
- [ ] **G7**：普通 / VOS × 1440 / 390 四组基线截图齐备；`tests/integration/vos-auth.test.ts`、`tests/frontend/vosAuthService.test.ts` 通过；发布前 `verify-vos-runtime.py` 烟测通过
- [ ] **G8**：服务端 owner / visibility / group / app 凭据过滤不变；queryKey 含用户维度；账号切换（含 401 / logout 不 reload 路径）后 `auth.user`、query cache、Settings/Server Context、SSE 连接、in-flight 请求、表单草稿全部清理或按用户分区
- [ ] **G8**：A/B 双账号 E2E 在普通 / VOS 两个 project 全绿；服务端既有 A/B 用例（`dataService`、`personal-credentials`、`serverController` 等）通过；草稿提交成功后不留驻
- [ ] 6 语言文案同步（含 `vos.*` 键）；PR 附双模式截图；`pnpm docs:validate` 通过

---

## 4. 风险登记与回滚

| 风险 | 触发点 | 对策 | 回滚方式 |
| --- | --- | --- | --- |
| **VOS 登录态回归（最高）** | M1 改请求层 / 401；M4 改路由与 Provider | `1.7.3` 的 9 条硬约束逐条测试；改动前用 `lsp-code-analysis` 列全部引用；每个 PR 跑普通 + VOS 两个 E2E project 与 `tests/integration/vos-auth.test.ts` | 请求层改动按单 PR 整体 revert |
| **跨用户数据串号（最高）** | M1 引入 query cache；M4 加草稿；M0 缺 A/B 用例 | `1.8.4` 的 7 条硬约束：queryKey 含用户维度、`resetForUser()` 覆盖 401/logout、草稿按用户分区且提交即删、A/B E2E 先建；禁止把 `isAdmin` 落盘当授权依据 | revert 新缓存/草稿实现，回到「reload 兜底」现状 |
| **`auth.user` 与 SSE 停留在上一个用户** | M1 的 401 / logout 不 reload 路径 | `auth.user` 同步最新 `result.user`；`logStreamManager.disconnect()` 后用新 token 重连；`App.tsx:53` 常驻订阅者不得阻止 close | 恢复 `AuthContext` / `logService` 生命周期 |
| **草稿含凭据且提交后不清** | M1 / M4 表单改造 | `ToolCard.tsx:253-254`、`PromptCard.tsx:164-165` 被注释的清理恢复；`ServerForm` 草稿禁止写入 headers / API key / OAuth secret | revert 草稿持久化 |
| **401 统一跳登录破坏 VOS** | M1 | 严格按 `1.7.2` 分叉：VOS 只清会话、不跳转、由 `ProtectedRoute` → `VosSignIn` 承接；禁止硬编码 `/login` | 恢复 `interceptors.ts:53-62` 的清理逻辑 |
| **token 泄漏** | M1 新状态层 / 日志 / 错误上报 | token 只在内存，不进 queryKey / cache / URL / localStorage / 错误日志；`passthroughHeaders` 敏感头黑名单不放松；加专门断言 | revert 新请求层 |
| **全局 `fetch` 劫持污染 VOS 原生路径** | M1 | 保持 `fetchWithInterceptors` 包装链；`/auth/vos`、`/config`、`/public-config`、日志流、Better Auth 继续走原生路径 | 恢复包装链实现 |
| **`/config` 不可达导致 VOS 被判为关闭** | 改 Vite / SPA 入口 / basePath | `viteProxy.ts` 保证 `/config` 代理；`runtime.ts` 兜底配置要显式测试；M0 加 `/config` 可用性用例 | revert 构建/入口改动 |
| **`BASE_PATH` 丢失 / iframe 顶层跳转** | M4 深链与登录跳转 | 所有跳转用 `${getBasePath()}/...`、`basename` 不变；VOS 模式禁止 `window.location.href` 顶层跳转 | 恢复 `App.tsx` basename 与跳转实现 |
| **VOS 语言跟随被懒加载破坏** | M4 i18n 改造 | 保持 `main.tsx` 的 `initializeVosLocale()` 在 render 前完成；VOS auto/en/zh 选项与不 reload 行为写用例 | revert i18n 懒加载 |
| **270s 会话与轮询节奏冲突** | M1 轮询改造 | D8 与平台确认；`refetchInterval` 不触发高频 PKCE；`visibilitychange` 暂停 | 恢复旧轮询参数 |
| `!important` 是承重墙 | M3 提前批量删除 | 严格「迁完一页删一段」；迁移期允许新旧类共存 | 恢复 `index.css` 对应 retrofit 段 |
| 视觉方向未定就铺开 | M2 / M3 | D1 未定稿不启动 M3；3 稿基于真实三屏并含 VOS 容器表现 | 组件层是增量，页面类名按 PR revert |
| i18n 漏译 | 所有文案改动 | 每页 PR 跑 6 语言覆盖检查（含 `vos.*`）；M0 先扩展测试 | 按 locale 文件 revert |
| 状态层迁移引入竞态 | M1 | 保留 `ServerContext` 对外接口，内部替换为 query；`ServersPage.tsx:69-85` 已有 request-id 防御需保留 | 逐 hook 切回旧实现 |
| 巨型表单拆分丢配置 | M4 | 先补字段级测试与 E2E 再拆；按 section 搬；保留旧路由重定向 | 保留旧组件到新路径稳定后再删 |
| E2E 依赖本地服务 / VOS 环境 | M0 起 | `pnpm dev` 常驻；VOS project 用 stub 或 userinfo fixture；CI 明确环境依赖；失败时标注环境原因 | E2E job 可临时设为非阻断，但 build 与 VOS 用例不可 |
| 字体 / 品牌色决策拖延 | M2 | D2/D3 与 D1 一起定稿，写入 token 表 | 不影响功能，可后续单独调整 |
| 依赖与 lockfile 变更 | M0 / M1 / M4 | 每阶段单独 PR 锁版本；`pnpm install --frozen-lockfile` 在 CI 验证 | revert 依赖 PR |

---

## 附录 A · 证据索引

| 主题 | 位置 |
| --- | --- |
| 技术栈与脚本 | `package.json:19-42,104-165` |
| 路由表与 Provider | `frontend/src/App.tsx:15-29,37-51,52-102` |
| 布局与侧栏 | `frontend/src/layouts/MainLayout.tsx:10-39`、`components/layout/Sidebar.tsx:59-91,134-175`、`Header.tsx:14-41`、`Content.tsx:8-11` |
| 样式与 token | `frontend/src/index.css:1-60,201,277-289,410,485-948,520,596,702,835-869,1096-1138,1144`；`frontend/tailwind.config.js:5-10`；`frontend/postcss.config.js` |
| 主题 | `frontend/src/contexts/ThemeContext.tsx:3,23-58`、`components/ui/ThemeSwitch.tsx:11,17-21` |
| 请求与轮询 | `frontend/src/utils/fetchInterceptor.ts:21-39,61-214`、`utils/interceptors.ts:26-71`、`utils/serverPolling.ts:1-41`、`contexts/ServerContext.tsx:85-220,223-408` |
| 反馈 | `contexts/ToastContext.tsx:23-42`、`components/ui/Toast.tsx:93-119`、`components/ui/Button.tsx:45-95`、`components/ui/ConfirmDialog.tsx:106-144` |
| 表单与页面 | `components/ServerForm.tsx:591-639,642,691,1780,2146,2443,2606-2618`、`pages/SettingsPage.tsx:54-110,721,969-981,1653,4176-4182`、`pages/ServersPage.tsx:50-60,80-82,141-149,191-213,216-341` |
| 列表与导航 | `pages/MarketPage.tsx:29-32,112-163,188-192`、`pages/Dashboard.tsx:161-170,211-217`、`pages/CredentialsPage.tsx:360-371` |
| **VOS 模式识别与运行时** | `src/services/vosAuthService.ts:7`、`src/controllers/configController.ts:39-57,71-109`、`src/routes/index.ts:545-548`、`frontend/src/utils/runtime.ts:53-116`、`frontend/src/main.tsx:14-52`、`frontend/src/types/runtime.ts:2-9`、`frontend/viteProxy.ts:8-22` |
| **VOS 前端 token 链路** | `frontend/src/services/vosAuthService.ts:1-180`、`frontend/src/utils/interceptors.ts:1-2,26-65`、`frontend/src/utils/setupInterceptors.ts:7-19`、`frontend/src/contexts/AuthContext.tsx:37-50,214-221`、`frontend/src/services/logService.ts:74-167`、`frontend/src/services/configService.ts:121-153` |
| **VOS 登录态 / 路由 / i18n** | `frontend/src/components/ProtectedRoute.tsx:19-28`、`components/VosSignIn.tsx:3-14`、`pages/LoginPage.tsx:1-3,518`、`components/ui/UserProfileMenu.tsx:66-69,94`、`services/vosLocaleService.ts`、`components/ui/LanguageSwitch.tsx:10-27,52-63,88`、`locales/*.json` 的 `vos` 段约 `:1619-1633` |
| **VOS 后端鉴权与权限** | `src/middlewares/auth.ts:117-130`、`src/middlewares/index.ts:79-101`、`src/services/vosAuthService.ts:16-110`、`src/controllers/vosAuthController.ts:5-29`、`src/controllers/authController.ts:29-32,116-119`、`src/controllers/configController.ts:74`、`src/controllers/serverController.ts:2161-2163`、`src/utils/passthroughHeaders.ts:6-29`、`src/services/authorizationService.ts:32,44-61`、`src/services/dataService.ts:7-33` |
| **VOS 部署与端点** | `ictrek.app/src/docker-compose.yml:4-7,16-33`、`ictrek.app/src/manifest.yml:17-31`、`Dockerfile:74-84`、`docker/vos-entrypoint.sh`、`src/routes/index.ts:308-309,508-548`、`docs/vos-api-reference.zh.md:17,21,89`、`docs/vos-user-guide.zh-CN.md:5-9,33,45` |
| **VOS 测试与烟测** | `tests/integration/vos-auth.test.ts`、`tests/frontend/vosAuthService.test.ts`、`tests/frontend/runtimeVos.test.ts`、`tests/frontend/vosLocaleService.test.ts`、`tests/utils/passthroughHeaders.test.ts:78-90`、`tests/fixtures/vos-userinfo.mjs`、`scripts/verify-vos-runtime.py`、`ictrek.app/scripts/test_vos_package.py:31`、`.github/workflows/vos-release.yml:34-40` |
| **服务端用户隔离** | `src/services/userContextService.ts:1-53`、`src/services/requestContextService.ts:54-120`、`src/middlewares/auth.ts:14,117-130`、`src/middlewares/userContext.ts:58-140`、`src/services/dataService.ts:7-34,82-88`、`src/services/authorizationService.ts:32,43-62`、`db/repositories/ServerRepository.ts:118-143`、`src/services/groupService.ts:65-77,92-134`、`src/services/credentialBindingService.ts:89-99,153-157`、`src/services/mcpService.ts:1037,1041-1055,1058-1063,1083-1146`、`src/services/sseService.ts:61-63,1025-1063` |
| **前端隔离缺口 / 持久化 key** | `frontend/src/services/vosAuthService.ts:48-50,88-92,168-180`、`contexts/AuthContext.tsx:38-49,213-221`、`contexts/SettingsContext.tsx:358-440,1273-1284`、`contexts/ServerContext.tsx:75-89,123-178`、`services/logService.ts:51-56,130-141,198-207`、`components/ui/DynamicForm.tsx:118-124,153,213`、`ToolCard.tsx:127,132,253-254`、`PromptCard.tsx:78,83,164-165`、`utils/interceptors.ts:8-23`、`ThemeContext.tsx:24,33`、`vosLocaleService.ts:6,38-39`、`LanguageSwitch.tsx:60`、`changelogService.ts:4,24` |
| **服务端 A/B 隔离测试** | `tests/services/dataService.test.ts:87-152`、`tests/integration/vos-auth.test.ts:184-229,272-350`、`tests/controllers/serverController.test.ts:2466-2488,2696`、`tests/services/groupService-authorization.test.ts:255-283`、`tests/integration/personal-credentials.test.ts:585-727`、`tests/services/mcpService-group-visibility.test.ts:384-485`、`tests/services/userContextService.test.ts:33-56` |
| 测试与 CI | `jest.config.cjs:3-9,29-46`、`.github/workflows/ci.yml:35-48,57-121`、`eslint.config.mjs:20,33-46`、`tests/frontend/translationCoverage.test.ts:21-36` |
| 项目约定 | `AGENTS.md`、`docs/agents/typescript-and-frontend.md:3-16`、`docs/agents/testing.md`、`docs/agents/git-and-contribution.md` |
| 参考截图 | `assets/dashboard.png`、`assets/market.zh.png`、`assets/smart-routing.zh.png` |

## 附录 B · 已安装 skills 与用途

见 `2.5` 与 `2.6`。安装核验命令：

```bash
npx skills list -g
ls -1 ~/.codebuddy/skills ~/.agents/skills
```

`design-taste-frontend` 的 `hooks.Stop` 搜索路径只覆盖 `~/.claude/skills/`、`~/.agents/skills/` 与 `CLAUDE_*` 变量，不含 `~/.codebuddy/skills/`；其自动 gate 在本机可能不触发，需要时手动运行 `scripts/gate.mjs`。本方案不依赖该 gate。

## 附录 C · 术语与参考

- **retrofit 段**：`index.css:485-948` 中用 `!important` 覆盖旧 Tailwind 工具类的兼容补丁，是半成品迁移的主要遗留物。
- **`hub-*`**：`index.css:13-55` 定义的新设计 token / 类，用于已改造的 Dashboard、Servers、Sidebar、Header。
- **黄金路径**：E2E 覆盖的三条高频用户任务，见 `3.1`；普通模式与 VOS 模式各跑一遍。
- **VOS 适配**：登录 / 路由 / 文案层面的功能定制，不是视觉主题；本方案必须保持其行为不变，边界见 `1.7`。
- **VOS 登录 token**：由 VOS 平台 `window.vos_platform` 的 OAuth2 PKCE 签发的 `access_token`，`client_id=com.ictrek.mcphub`；只存前端模块内存，管理 API 以 `x-vos-token` 携带，登录校验端点以 `Authorization: Bearer` 携带。不是 MCPHub 的 `x-auth-token`，也不是外部应用的 context access-token 文件。
- **introspect**：后端对每个 `/api` 请求向 `VOS_USERINFO_URL` 远程校验 token 与角色，不信任浏览器声明、不缓存角色到前端。
- **双通道**：`x-vos-token`（管理 API）+ `Authorization: Bearer`（`/auth/vos`、集成/MCP）；见 `1.7.1`。
- **`VosSignIn`**：VOS 模式未认证时 `ProtectedRoute` 渲染的提示组件，重试动作是 `window.location.reload()`；不是密码登录页。
- **`BASE_PATH`**：VOS 部署前缀 `/app/com.ictrek.mcphub`，`App.tsx` 的 `basename` 与所有 URL/跳转都必须带上。
- **单实例多用户**：本项目只有一个应用容器、共享 `mcp_settings.json`，没有 tenant 维度；隔离靠「每请求身份 + 读时过滤」而非存储分区。平台 admin 全放行、public 对实例内所有已认证用户可见、内置 prompt/resource 实例级共享。
- **读时过滤**：`filterData` 在每次查询/工具调用时按 `owner` / `visibility` / `sharedWithUsers` / `sharedWithUserGroups` / `isAdmin` 重新计算可见集合；`filterData()` 无 user 且 ALS 为空时返回全部，是服务端最脆弱的边界。
- **`resetForUser()`**：本方案要求新增的统一账号切换清理入口，覆盖 query cache、身份状态、Context、SSE、定时器与 in-flight 请求；`reload()` 只是兜底，不是清理。
- **`perSessionClient`**：上游 MCP 连接按会话（非按用户）隔离的开关；默认关闭时所有下游会话共享同一上游进程/浏览器，有状态服务可能跨用户串状态（D13）。
- 领域词汇以 `CONTEXT.md` 为准；架构决策记录见 `docs/adr/`。
