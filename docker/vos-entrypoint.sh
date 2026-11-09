#!/usr/bin/env bash
set -euo pipefail
export HOME=/app/data/home
export MCPHUB_SETTING_PATH=/app/data/mcp_settings.json
export npm_config_cache="$HOME/.npm"
export UV_CACHE_DIR="$HOME/.cache/uv"
export UV_TOOL_DIR="$HOME/.local/share/uv/tools"
export UV_TOOL_BIN_DIR="$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
umask 077
if [[ "$(id -u)" == 0 ]]; then
  # Touch only this application's mount, never host Docker or shared user directories.
  [[ ! -L /app/data && ! -L "$HOME" ]]
  install -d -o 10001 -g 10001 -m 700 /app/data "$HOME"
  exec gosu mcphub "$0" "$@"
fi
if [[ ! -e "$MCPHUB_SETTING_PATH" ]]; then
  printf '%s\n' '{"mcpServers":{},"users":[],"systemConfig":{"routing":{"skipAuth":false,"enableBearerAuth":true},"auth":{"allowRegistration":false}}}' > "$MCPHUB_SETTING_PATH"
fi
exec "$@"
