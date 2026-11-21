#!/usr/bin/env bash
# 端到端冒烟编排：Xvfb（调用方负责）里起 tauri-driver，再跑 W3C WebDriver 断言。
#
# 用法（CI）：xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bash scripts/e2e/run.sh
# 本机（有 WebKitGTK 的机器）：
#   cargo build --manifest-path src-tauri/Cargo.toml --features devtools
#   APP_BIN=$(realpath src-tauri/target/debug/hq-scifi) xvfb-run -a dbus-run-session -- bash scripts/e2e/run.sh
set -uo pipefail

# cargo 的产物名是 **包名** `hq-scifi`；`tauri.conf.json` 的 `mainBinaryName`（huangqi-scifi）
# 只影响打包时的重命名，不影响 target/ 目录。两个名字都试一遍。
APP="${APP_BIN:-}"
if [ -z "$APP" ]; then
  for cand in src-tauri/target/debug/hq-scifi src-tauri/target/debug/huangqi-scifi; do
    if [ -x "$cand" ]; then APP="$(realpath "$cand")"; break; fi
  done
fi
PORT="${WD_PORT:-4444}"
DRIVER_BIN="${TAURI_DRIVER_BIN:-tauri-driver}"
NATIVE_DRIVER="${NATIVE_DRIVER_BIN:-$(command -v WebKitWebDriver)}"

if [ -z "$APP" ] || [ ! -x "$APP" ]; then
  echo "::error::找不到可执行文件（APP_BIN=${APP_BIN:-<空>}，先 cargo build --features devtools,custom-protocol）"
  echo "--- src-tauri/target/debug 内容 ---"
  ls -la src-tauri/target/debug/ 2>/dev/null | head -20 || echo "(目录不存在)"
  exit 1
fi
[ -n "$NATIVE_DRIVER" ] && [ -x "$NATIVE_DRIVER" ] || { echo "::error::找不到 WebKitWebDriver（apt install webkit2gtk-driver）"; exit 1; }
command -v "$DRIVER_BIN" > /dev/null || { echo "::error::找不到 tauri-driver（cargo install tauri-driver）"; exit 1; }

export E2E_SHOT_DIR="${E2E_SHOT_DIR:-$(pwd)/.e2e}"
export APP_BIN="$APP"
mkdir -p "$E2E_SHOT_DIR"

# 与 smoke-tauri.sh 保持一致：隔离数据目录 + 容器里退回软件渲染（否则 WebKitGTK 白屏/崩溃）。
export HQSF_TEST=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
# CI 的 Xvfb 里 WebKitGPUProcess 起不来时，WebKit 会重载页面（表现成「协议门又回来了」，
# 因为 App 重新挂载、agreementOk 重新计算）。这两个开关让 WebKit 退回单进程/无沙箱路径。
export WEBKIT_DISABLE_GPU_PROCESS=1
export WEBKIT_FORCE_SANDBOX=0
export LIBGL_ALWAYS_SOFTWARE=1
# 应用启动时按该顺序找 api.config.json：给驱动进程的环境变量会被子进程继承。
if [ -z "${HQSF_API_CONFIG:-}" ] && [ -f "$(pwd)/api.config.json" ]; then
  export HQSF_API_CONFIG="$(pwd)/api.config.json"
fi

"$DRIVER_BIN" --port "$PORT" --native-driver "$NATIVE_DRIVER" > "$E2E_SHOT_DIR/driver.log" 2>&1 &
DRIVER_PID=$!
cleanup() {
  kill "$DRIVER_PID" 2>/dev/null || true
  wait "$DRIVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

status=0
node scripts/e2e/smoke.mjs || status=$?

# renderer.log：__hqsf_log 的落盘通道（用户报错时要的那个文件）。路径随数据目录而定，直接找。
LOG=$(find "$HOME" -maxdepth 6 -path '*logs/renderer.log' 2>/dev/null | head -1)
echo "--- renderer.log ---"
if [ -n "$LOG" ]; then
  echo "path=$LOG bytes=$(wc -c < "$LOG")"
  tail -n 20 "$LOG" || true
  [ -s "$LOG" ] || { echo "::error::renderer.log 是空文件（渲染层没有输出过 console）"; status=1; }
else
  echo "::error::没找到 renderer.log（__hqsf_log 未生效）"
  status=1
fi

echo "--- driver.log（尾部）---"
tail -n 20 "$E2E_SHOT_DIR/driver.log" || true
exit "$status"
