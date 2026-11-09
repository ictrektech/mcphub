# MCPHub __APP_VERSION__

Open MCPHub from the VOS app drawer to sign in with your platform account. Administrators manage trusted local stdio servers; users may add remote MCPs and use shared services.

Servers default to private. Public servers require authentication; use explicit user/group sharing for narrower access. Sharing usage does not disclose upstream configuration or credentials. For external clients, create a user-level MCPHub bearer key and use `/app/com.ictrek.mcphub/mcp` on the VOS HTTPS origin. Revoke MCPHub keys explicitly when offboarding a VOS user.

Choose the CPU profile unless a local stdio server needs GPU access. NVIDIA profiles expose drivers but do not supply CUDA/PyTorch or guarantee L4T/Thor dependency compatibility. The app does not mount the host Docker socket or run Docker-in-Docker. Deploy Docker-only MCPs separately and connect over HTTP/SSE.

Settings and caches persist in the app's data directory. Back it up, including credential encryption keys, before upgrade. Private visibility is not process/filesystem isolation; install local command servers only from trusted sources.

The interface follows VOS language by default. Use the language menu to choose English or Chinese explicitly, or return to automatic following. Platform language changes apply without reloading the page.
