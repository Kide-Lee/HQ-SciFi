#!/usr/bin/env bash
# Tauri 启动冒烟（CI：Linux + Xvfb + dbus）。
#
# 目的：本机沙箱没有 pkg-config/WebKitGTK，编译都做不了，更不可能启动；
# 所以「应用能不能起来、能不能建出窗口、有没有初始化本地库」只能在这里证明。
#
# 判定标准（全部满足才算通过）：
#   1. 进程 30 秒内没有退出；
#   2. X11 里能按标题「黄芪饮片」找到窗口（xdotool）；
#   3. 数据目录里出现了 hqsf.db（说明 build_core → Db::open 走通了）。
#
# 用法：xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bash scripts/smoke-tauri.sh
set -uo pipefail

APP="${1:-src-tauri/target/release/huangqi-scifi}"
TITLE="${TAURI_SMOKE_TITLE:-黄芪饮片}"

# 测试模式：数据目录用隔离的 hqsf-test，避免碰任何真实数据；HOME 由调用方指向临时目录。
export HQSF_TEST=1
# 无 GPU / 无合成器的容器里 WebKitGTK 需要退回软件渲染，否则会白屏或直接崩。
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

[ -x "$APP" ] || { echo "::error::找不到可执行文件：$APP"; exit 1; }

"$APP" > "$HOME/app.log" 2>&1 &
APP_PID=$!
echo "app_pid=$APP_PID"

found=0
for _ in $(seq 1 30); do
  sleep 1
  if command -v xdotool > /dev/null && xdotool search --name "$TITLE" > /dev/null 2>&1; then
    found=1
    break
  fi
  kill -0 "$APP_PID" 2>/dev/null || break
done

alive=0
kill -0 "$APP_PID" 2>/dev/null && alive=1

echo "window_found=$found"
xdotool search --name "$TITLE" 2>/dev/null | head -3 || true
echo "app_alive=$alive"
echo "--- 本地库 ---"
find "$HOME" -maxdepth 6 -name 'hqsf.db*' 2>/dev/null || true
echo "--- app.log（尾部）---"
tail -120 "$HOME/app.log" 2>/dev/null || true

kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true

if [ "$found" = 1 ] && [ "$alive" = 1 ]; then
  echo "冒烟通过"
  exit 0
fi
echo "::error::Tauri 应用未能创建窗口或提前退出（见上面的 app.log）"
exit 1