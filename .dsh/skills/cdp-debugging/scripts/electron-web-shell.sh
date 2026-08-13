#!/usr/bin/env bash
# 用项目自带的 Electron 打开一个可 CDP 调试的页面（零下载）。
#
# 必须在"用户真实终端"运行（DSH 沙箱内无法启动 Electron GUI，SIGTRAP）。
# 用法：
#   .dsh/skills/cdp-debugging/scripts/electron-web-shell.sh [URL]
#   # 默认 URL 为 http://127.0.0.1:3080（DSH Web GUI）；CDP 端口默认 9222
#   CDP_PORT=9223 .dsh/skills/cdp-debugging/scripts/electron-web-shell.sh http://localhost:5173
#
# 之后在沙箱内用 skill 的 cdp.mjs 挂载（page 型 target，eval/shot/listen 均可）：
#   CDP_PORT=9222 node .dsh/skills/cdp-debugging/scripts/cdp.mjs targets
set -euo pipefail

cd "$(dirname "$0")/../../../.."
[ -x node_modules/electron/dist/electron ] || {
  echo "未找到 node_modules/electron/dist/electron，请先在项目根执行 npm install" >&2
  exit 1
}

PORT="${CDP_PORT:-9222}"
URL="${1:-http://127.0.0.1:3080}"

echo "CDP 绑定 127.0.0.1:${PORT}，页面 ${URL}（窗口可最小化，关闭窗口即退出）" >&2
exec node_modules/electron/dist/electron \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  "$URL"
