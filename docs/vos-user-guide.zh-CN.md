### MCPHub：运行、管理与调用 MCP 服务

适用版本：VOS MCPHub 0.0.2。MCPHub 将本地或远程 MCP 服务统一接入，提供服务器管理、工具调用、分组、提示词、资源和应用集成入口。VOS 应用抽屉下有两个并列页面：服务管理、API 集成指南。

#### 安装、登录与语言

在 VOS 应用商店安装或升级 MCPHub。普通管理与远程 MCP 调用选择与设备架构匹配的 CPU profile 即可；只有本地 MCP 确实需要 GPU 时才选择 NVIDIA、L4T 或 Thor/Spark profile。GPU profile 只提供设备与驱动访问，不包含模型框架或 CUDA 工具链。

从应用抽屉打开服务管理，自动使用当前 VOS 账户，无需另建 MCPHub 密码。VOS 管理员可以管理本地命令服务；普通账户使用自己有权限的服务。界面默认跟随 VOS 语言，右上角语言菜单也可选中文或 English，选“跟随 VOS 语言”恢复自动跟随。切换语言不会停止 MCP 服务。

#### 一个无需联网即可运行的实例

新版镜像包含 `/app/examples/vos-demo.mjs`，无需下载模型、安装额外包或配置密钥。它提供 `add`、`echo` 两个工具，`demo://status` 资源，以及 `explain-sum` 提示词。

以管理员打开“服务器 → 添加”，填写：服务器名称 `vos-demo`；服务器类型“STDIO 命令”；命令 `node`；点击“添加参数”，在一个参数输入框中填 `/app/examples/vos-demo.mjs`。不要把命令和参数合成一行。在高级选项中保持“Private — 仅所有者和管理员”，然后添加。等待状态变为在线；首次配置可点击刷新查看工具列表。

展开该服务器的工具，调用 `add`，输入 `a=7`、`b=5`，结果应为 `12`；调用 `echo`，输入 `message=hello MCP`，应返回同一文本。在“资源”读取 `demo://status`，应得到 `{"server":"vos-demo","status":"ready"}`。在“提示词”选择 `explain-sum`，填写字符串参数 `a=7`、`b=5`，应生成让客户端计算并解释加法的消息；提示词本身不会执行大模型推理。

可以再创建 `vos-demo-public`，使用相同命令和参数，在高级选项将可见范围设为 Public。这会运行第二个独立 MCP 进程，用于验证受控共享和其他应用的服务发现。

#### 管理实例与访问范围

在服务器卡片查看连接状态、工具和错误信息。编辑用于修改连接参数；停用后服务不可调用，重新启用恢复；重载会重建连接与本地进程，修改命令、环境变量后可用它重新初始化。删除会移除服务器配置，操作前确认目标。按需启动可在调用时启动本地服务，并在空闲超时后回收；每会话隔离适用于需要独立状态的浏览器类服务，会增加连接与进程数量。

Private 只允许所有者及管理员；Shared 可指定用户和用户组；Public 允许已认证用户，并可被其他 VOS 应用的应用身份发现。Public 不表示匿名开放。应用身份只发现和调用公共服务，不继承平台给予应用 token 的管理员角色。私有范围是访问控制，不是本地进程的系统沙箱；只运行管理员信任的 STDIO 命令。

#### 接入已有服务、市场与导入

“添加”支持 STDIO、SSE、Streamable HTTP 和 OpenAPI。远程服务填写真实地址及其所需凭据；OpenAPI 用于将 API 定义转换成工具。市场可查找并添加模板，导入/上传可批量载入配置，执行前核对命令、URL、环境变量及共享范围。下载包、市场和外部服务需要网络。镜像内不运行 Docker daemon，也不挂载主机 Docker socket；只提供 Docker 镜像的 MCP 应独立部署，再以 HTTP/SSE 接入。

凭据页管理个人上游凭据；服务器声明个人凭据槽时，每位用户分别绑定，不能依赖组织凭据自动兜底。上游 OAuth 服务按其授权流程连接。不要把 VOS token 填成上游 API 密钥，也不要将其配置为透传请求头。

#### 分组、工具、提示词与资源

在“分组”创建服务组合并添加成员，以分组端点接入多个服务。可以按工具启停、调整描述和配置隐藏参数，缩小客户端可调用的范围；工具访问策略用于进一步限制调用。提示词页查看上游提供的模板，资源页读取上游暴露的内容；实际能力取决于服务自身。上述离线实例可用来验证工具、提示词和资源三个页面。

#### 从客户端调用

API 集成指南提供当前设备的完整 MCP URL，以及桌面客户端和 Node SDK 示例。单服务端点为 `/app/com.ictrek.mcphub/mcp/vos-demo`；统一入口为 `/app/com.ictrek.mcphub/mcp`，也支持分组和按账户的入口。客户端需使用当前用户的 VOS 应用 access token，或该用户创建的 MCPHub 用户级 Bearer Key；用户级 Key 只用于 MCP 传输，不用于 VOS 发现/身份接口。将 token 保存在客户端的受保护配置或环境变量中，不写入文档和截图。HTTPS 证书应被运行客户端的系统信任。

下面是使用官方 SDK 的最小调用程序。在客户端目录安装 `@modelcontextprotocol/sdk@1.29.0`，保存为 `call-mcp.mjs`。将 `MCPHUB_URL` 设置为实际单服务完整 URL，将 `MCPHUB_TOKEN` 设置为上述用户凭据，再运行 `node call-mcp.mjs`。

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
} finally {
  await client.close();
}
```

#### VOS token、用户验证与其他应用集成

API 集成指南内有完整的 PKCE 获取用户 token 示例：在 VOS 同域 iframe 中经 `vos_platform.api.v1000.oauth2.authorize` 获取授权码，再调用 `token` 交换 access token，校验 state，并在过期后刷新。不要读取平台登录 token 或用硬编码管理员凭据代替授权。

带 `Authorization: Bearer <VOS 应用 access token>` 调用 `GET /app/com.ictrek.mcphub/api/integration/whoami` 验证当前身份；调用 `GET /app/com.ictrek.mcphub/api/integration/discovery` 获取已启用且当前身份有权访问的服务和相对 MCP 路径。后端会向 VOS userinfo 验证 token，而不是信任浏览器提供的角色。

其他 VOS 应用可按指南只读挂载自己的应用上下文 token，由后端调用 discovery，并通过返回的路径连接公共 MCP。需要代表某个用户访问私有服务时，必须传递该用户的有效授权 token。自动集成应处理 MCPHub 未安装、服务不可用和权限不足，不得回退匿名访问。发现结果不返回命令、环境变量、上游地址或密钥。

#### 日志、设置与故障检查

日志页用于查看连接、进程和调用错误；设置页包含 Key、工具策略、智能路由、结果压缩、OAuth Server、市场与系统配置，以及配置导出。智能路由、模型相关压缩和外部市场需要另配依赖，并非离线实例的前置条件。VOS 账户与密码在平台管理，MCPHub 中的上游通用认证设置不能代替 VOS 登录。

登录失败先确认从 VOS 抽屉打开、VOS 会话有效且应用已升级至 0.0.2；该版本修复 Safari 访问本地设备时登录请求的凭据模式问题。服务器离线时检查命令、参数、网络、依赖和日志；有服务但无工具时检查权限、服务启用状态及工具开关。升级前可导出配置，并按管理员的备份策略保护应用数据目录与凭据。升级保留已有服务器配置，不会自动新建本节示例。
