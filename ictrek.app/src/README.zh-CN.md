# MCPHub __APP_VERSION__

从 VOS 应用抽屉打开 MCPHub，自动使用平台账户登录。管理员部署可信的本地 stdio 服务；普通用户可添加远程 MCP，并使用获共享的服务。

新服务默认私有。公开服务仍要求认证；也可只共享给指定用户或组。共享调用权限不会开放上游配置和密钥。外部客户端请创建用户级 MCPHub Bearer Key，并连接 VOS HTTPS 地址下的 `/app/com.ictrek.mcphub/mcp`。停用 VOS 用户后，还需显式撤销其已签发的 MCPHub Key。

默认选择 CPU profile。仅本地 stdio 服务需要 GPU 时选择 NVIDIA profile；该模式只开放驱动和设备，不自带 CUDA/PyTorch，也不保证服务依赖兼容 L4T/Thor。应用不挂宿主 Docker socket，不运行 Docker-in-Docker。Docker 形式的 MCP 请独立部署后通过 HTTP/SSE 接入。

配置与缓存保存在应用数据目录；升级前请连同凭据加密密钥一起备份。私有可见性不是进程和文件系统隔离，本地命令服务仅应安装可信来源。

界面默认跟随 VOS 语言。可在语言菜单中手动选择中文或 English，或切回自动跟随；平台切换语言时，应用即时更新，无需刷新页面。

在使用 Traefik v3 的 VOS 上，从浏览器直接打开应用根地址会跳转到「应用抽屉 → MCPHub → 服务管理」。嵌入页面和 API 请求沿用原有路由。
