#!/usr/bin/env bash
# Tauri 启动冒烟（CI：Linux + Xvfb + dbus）。
#
# 目的：本机沙箱没有 pkg-config/WebKitGTK，编译都做不了，更不可能启动；
# 所以「应用能不能起来、能不能建出窗口、有没有初始化本地库」只能在这里证明。
#
# 判定标准（全部满足才算通过）：
#   1. 进程 90 秒内没有退出；
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
for _ in $(seq 1 90); do
  sleep 1
  if command -v xdotool > /dev/null && xdotool search --name "$TITLE" > /dev/null 2>&1; then
    found=1
    break
  fi
  kill -0 "$APP_PID" 2>/dev/null || break
done

alive=0
kill -0 "$APP_PID" 2>/dev/null && alive=1

db_count=$(find "$HOME" -maxdepth 6 -name 'hqsf.db' 2>/dev/null | wc -l)

echo "window_found=$found"
WINDOW_ID=$(xdotool search --name "$TITLE" 2>/dev/null | head -1)
echo "window_id=${WINDOW_ID:-none}"
echo "app_alive=$alive"
echo "db_count=$db_count"
echo "--- 本地库 ---"
find "$HOME" -maxdepth 6 -name 'hqsf.db*' 2>/dev/null || true

# 窗口存在 ≠ 界面画出来了：截一张图，用「颜色种数」判断是不是白屏。
# 60px 的纯白窗口只有 1 种颜色；正常界面有文字、图标、分栏底色，通常上百种。
colors=0
screenshot_ok=0
if [ -n "${WINDOW_ID:-}" ] && command -v import > /dev/null; then
  if import -window "$WINDOW_ID" "$HOME/shot.png" 2>"$HOME/shot.err"; then
    colors=$(convert "$HOME/shot.png" -format %k info: 2>/dev/null || echo 0)
    screenshot_ok=1
  else
    echo "截图失败（不判失败）：$(tail -3 "$HOME/shot.err" 2>/dev/null)"
  fi
fi
echo "screenshot_ok=$screenshot_ok unique_colors=$colors"
[ "$screenshot_ok" = 1 ] && echo "--- 截图尺寸 ---" && identify "$HOME/shot.png" 2>/dev/null | head -1

echo "--- app.log（尾部）---"
tail -120 "$HOME/app.log" 2>/dev/null || true

kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true

fail=0
[ "$found" = 1 ] || { echo "::error::没有找到窗口"; fail=1; }
[ "$alive" = 1 ] || { echo "::error::进程提前退出"; fail=1; }
[ "$db_count" -ge 1 ] || { echo "::error::没有生成 hqsf.db（CoreCtx/Db::open 没走通）"; fail=1; }
# 截图只在能截时判定：少于 20 种颜色基本就是白屏/纯色（渲染层没挂上）。
if [ "$screenshot_ok" = 1 ] && [ "${colors:-0}" -lt 20 ]; then
  echo "::error::窗口疑似白屏（unique_colors=$colors），渲染层可能未加载"
  fail=1
fi
[ "$fail" = 0 ] || { echo "::error::冒烟失败（见上面各部分输出）"; exit 1; }
echo "冒烟通过"