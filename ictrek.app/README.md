# MCPHub for VOS

This fork adds VOS account integration and app packaging. The upstream UI, MCP transports and authorization rules remain the basis of the product. App ID: `com.ictrek.mcphub`; page and API prefix: `/app/com.ictrek.mcphub`.

## Authentication and sharing

The browser login request uses `credentials: 'same-origin'`, matching the VOS bridge's transport. Safari can reject credentialless requests to a device using a locally accepted certificate even when the VOS page itself loads. Cookies are not accepted as dashboard credentials: the backend still requires and verifies the application Bearer token.

Open MCPHub from the VOS app drawer. The dashboard obtains an application access token through the VOS OIDC Fastpath using authorization code, PKCE S256 and a checked state. Tokens remain in memory. Every dashboard API request is verified server-side against the configured `VOS_USERINFO_URL`; redirects, invalid tokens, disabled users and unavailable verifiers fail closed. The browser cannot select the verifier URL or assert a role. VOS user-change events clear the page, and request-time identity checks catch missed events.

The stable identity key uses the verified VOS `sub` in a dedicated namespace, so gateway address/port changes do not create a new account. Local usernames are namespaced, so existing local accounts are never linked by a matching username or email. Only verified `system_admin` and `platform_admin` roles map to MCPHub administrator. Current roles are re-read on dashboard requests; no first-user admin shortcut or local password login is enabled in VOS mode. Standalone deployments retain upstream authentication when `VOS_AUTH_ENABLED` is unset.

New servers default to `private`. `public` means available to authenticated MCPHub users, not anonymously accessible. `group` shares with explicitly selected MCPHub users or local groups. VOS groups are not automatically imported. Sharing grants discovery/invocation only; configuration, upstream credentials and server lifecycle remain owner/admin controls. Shared MCPs with static credentials act using those shared credentials: choose per-user credential bindings when upstream data must be isolated by user.

External clients use MCPHub **user-level bearer keys**, which restore their owner's visibility, rather than an administrator's all-access system key. VOS browser tokens are used for dashboard authentication, not exported to external clients. Existing MCPHub bearer-key revocation controls apply; disabling a VOS account does not automatically revoke keys already issued by MCPHub, so revoke/offboard those keys explicitly. VOS login does not replace MCPHub's separate downstream OAuth authorization-server flow.

## VOS pages and integration API

The drawer follows PGV: exactly two root-level peer pages, **Server Management** and **API Integration Guide**, with no nested application group. The management entry remains `/app/com.ictrek.mcphub/`; the standalone bilingual guide is `/app/com.ictrek.mcphub/integration-guide` and follows the same language preference.

The guide covers obtaining a user token through the consuming app's own VOS OIDC/PKCE client, verifying users against VOS and MCPHub, reading the consuming app's protected context token on the backend, discovering MCP services and connecting an SDK/client automatically. It never displays a real credential.

- `GET /app/com.ictrek.mcphub/api/integration/whoami`: accepts a verified VOS Bearer token and returns identity kind, stable subject, MCPHub username, administrator flag and usage scope.
- `GET /app/com.ictrek.mcphub/api/integration/discovery`: returns authenticated, enabled service metadata and relative Streamable HTTP paths. It excludes upstream connection URLs, commands, environment variables, credentials and other users' private services.
- `/app/com.ictrek.mcphub/mcp`: also accepts VOS user tokens and app-context tokens directly. Every request is verified through VOS userinfo. An app-context token is always a non-admin, public-only principal, even when the platform assigns it an administrator role. It cannot sign into the dashboard or use private/group servers or personal credential bindings.

Other VOS apps join `vos_default`, use the `mcphub:3000` service alias, discover at the app-prefixed API path, and connect with the same token. The consuming application may mount **its own** `${VOS_APP_CONTEXT_PATH:-}:/var/lib/vos-context:ro`; a legitimately privileged backend/startup helper reads `access-token`. Do not mount another application's context or expose the token to frontend code. User-specific integrations forward the actual user token instead of using an app credential. Optional consumers must handle MCPHub being absent or unavailable without downgrading authentication.

MCPHub user-level Bearer Keys remain supported on MCP transports; they are not VOS credentials for the integration discovery/identity API. UI copy actions derive the real VOS origin and full app path, rather than advertising localhost addresses.

## Language

The VOS interface defaults to following the platform language. It reads `vos_platform.getState().locale` before the first rendered frame and listens for `locale-change` events. Chinese locale variants map to the Chinese translation and English variants map to English; unsupported platform languages fall back to English. The language menu offers **Follow VOS language / English / 中文**. An explicit manual choice persists under the app-specific `mcphub.vos.language` key; choosing automatic mode removes that override and immediately restores the current platform language. Switching languages does not reload the VOS page or interrupt MCP processes.

The current UI language is also sent as the API `Accept-Language` header. The fork fills missing English/Chinese translation keys, including server form sections and error messages, and checks literal frontend translation-key coverage in both languages. Standalone mode retains the upstream language choices. Existing generic browser-language cache entries do not override automatic VOS following.

## Execution model

The default is a single application container, running the dashboard and trusted local stdio MCPs as UID/GID 10001. Only the application's own data directory is writable/persistent. Upstream already restricts command-carrying configurations and template imports to administrators; ordinary users can configure their own remote MCPs. `private` is an authorization scope, not an OS sandbox: a trusted stdio process shares the application filesystem, environment and network with MCPHub. Do not run untrusted multi-user code in this container.

The VOS target is built with `INSTALL_EXT=false`. It does not mount `/var/run/docker.sock`, run privileged, or start Docker-in-Docker. MCPs supplied only as Docker images should be deployed as independent services with their own lifecycle and connected through Streamable HTTP/SSE. Host Docker orchestration would need a separately designed, restricted runner with instance ownership and cleanup; raw Docker socket access is not the default.

## CPU and NVIDIA profiles

Management, routing and remote MCP calls need no GPU. Select the CPU profile on AMD64 or ARM64, including Jetson/L4T and Thor/Spark, unless a trusted local stdio server specifically needs GPU access.

| VOS profile | Feishu sheet | Runtime |
| --- | --- | --- |
| `amd-without-cuda` | `AMD_with_mxn100` | normal AMD64 CPU container; sheet name is a release-table convention, not an accelerator dependency |
| `arm-without-cuda` | `ARM_without_cuda` | normal ARM64 CPU container, also usable on L4T/Thor |
| `amd` | `AMD_with_cuda` | NVIDIA AMD64 |
| `arm` | `ARM_with_cuda` | NVIDIA generic ARM64 |
| `l4t` | `l4t` | NVIDIA Jetson/L4T |
| `thor-spark` | `thor_spark` | NVIDIA Thor/Spark |

NVIDIA profiles declare `software: [cuda]` and `runtime: nvidia`; dedicated device profiles also constrain `device-type`. These profiles expose driver/device access only. The image does **not** bundle PyTorch, CUDA toolkit, TensorRT or device-specific inference libraries. A GPU MCP still needs compatible dependencies; L4T/Thor support cannot be established by merely adding `runtime: nvidia`. Prefer independently deployed platform-specific GPU MCPs for inference workloads. No host root/model directories are mounted automatically.

## Build and release

All Git operations run on the local workstation. Before each remote build/test, rsync this checkout to `~/dev/repos/mcphub` on an architecture-matched build machine. Builds copy into `~/dev/build/mcphub`; do not build VOS images on the Mac.

On the build machine, with the authoritative local commit passed explicitly:

```bash
bash build_image.sh --sheet ARM_without_cuda --commit <local-source-commit> --images mcphub --build-only
# After verification, omit --build-only to push the image and record its tag.
```

The explicit sheet controls architecture and tag prefix; the script never runs Git or SSH. Build every required platform/sheet before releasing. Unchanged published images can be reused. Image publication and Feishu read-back must succeed before triggering packaging. Feishu's spreadsheet ID is fixed; authentication uses the approved host credential file, never a repository secret containing the document ID.

```bash
# On a build machine, using its existing pnpm/Node >=22 environment:
pnpm install --frozen-lockfile
pnpm build
pnpm frontend:typecheck
pnpm exec jest tests/integration/vos-auth.test.ts tests/frontend/vosAuthService.test.ts --runInBand
python3 -m unittest discover -s ictrek.app/scripts -p 'test_vos_package.py'
# Local release orchestration, only after all required images are published:
bash ictrek.app/scripts/update_version.sh patch
```

After merging an official release from `samanhappy/mcphub`, set `ictrek.app/UPSTREAM_VERSION` to its tag without `v`. The VOS release script starts at `1.2.3-vos.01` for upstream `1.2.3` and increments the suffix for subsequent VOS releases. For upstream prereleases, it appends `.vos.01` to the existing prerelease segment. Use `--dry-run` to preview the next version. The installed package supplies the dashboard version through `MCPHUB_VOS_VERSION` and `GET /app/com.ictrek.mcphub/config` exposes it as `data.version`.

The release workflow resolves images from the exact `mcphub` column in all six sheets, creates a pull package, publishes a public release, and sends the archive to the VOS App Store through the existing SSH tunnel flow. Generated package files are under `~/dev/build/mcphub/ictrek.app`; `MCPHUB_PACKAGE_DIR` can select another build-directory location. The package has no dependency on PGV or V-Scheduler. Runtime credentials, settings, caches and personal credential key files live under the VOS application's data mount; preserve that directory during upgrade.

A successful source build or package test is not a published release or device installation. Validate actual VOS login, account switching, page routing and representative MCP calls on the target device before claiming end-to-end support. GPU execution additionally needs a real device-specific MCP workload test.

## Validation

The disposable image check runs with simulated VOS identities on its own Docker network and data directory, without installing or changing a VOS app:

```bash
python3 scripts/verify-vos-runtime.py --image <locally-built-vos-image>
```

It checks administrator/member separation, default private access, public invocation without configuration disclosure, user-level MCP client keys, stdio discovery and calls, process stop/restart/reload, non-root application execution and absence of Docker socket/daemon. `--keep-running` retains only these test containers for browser QA; the printed cleanup command removes them. The browser bridge in this fixture is simulated, so it is not evidence of real VOS OIDC integration. The fork also fixes an upstream route collision where generic OpenAPI tool routes intercepted dashboard tool calls.

## VOS API reference

The API Integration Guide links to a bundled bilingual complete API reference: [English](../docs/vos-api-reference.en.md) · [中文](../docs/vos-api-reference.zh.md). It documents VOS management authentication separately from MCP user Keys, complete Key creation/update/rotation/revocation semantics, personal upstream bindings, native REST operations and transport schemas. Documentation changes ship with the next application release; no new image is published for this documentation update.
