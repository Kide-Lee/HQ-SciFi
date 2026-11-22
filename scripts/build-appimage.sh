#!/usr/bin/env bash
# 用「系统 WebKitGTK」构建 AppImage（不内嵌 WebKit）。
#
# 为什么不用 `cargo tauri build --bundles appimage`：Tauri 的 AppImage 会把构建机
# （ubuntu-22.04）的 WebKitGTK 2.44 打进包内，那一版在真机上**不渲染跨站 iframe**
# （阅读页的音乐/视频播放器停在 about:blank）；deb 用系统 WebKitGTK（Debian 13 = 2.54）正常。
# 用户裁定 AppImage 改用系统 WebKit，所以这里自己拼一个最小 AppDir：
#   只放「可执行文件 + 三个资源 + 图标 + desktop」，不带任何 .so，
#   运行时依赖系统 libwebkit2gtk-4.1 / libgtk-3（与 deb 相同的系统要求）。
#
# 产物落到 `src-tauri/target/release/bundle/appimage/hq-scifi_<version>_amd64.AppImage`，
# 这样 scripts/verify-bundles.mjs 与上传步骤不用改路径。
#
# 用法：
#   cargo tauri build --bundles deb --features devtools   # 先出二进制与 deb
#   bash scripts/build-appimage.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONF="src-tauri/tauri.conf.json"
PRODUCT="hq-scifi"        # package_info.name → Tauri 的 resource_dir 是 usr/lib/<name>
BINARY_NAME="huangqi-scifi" # mainBinaryName（与 deb 内的 /usr/bin 一致）
VERSION="$(python3 -c "import json;print(json.load(open('${CONF}'))['version'])")"

OUT_DIR="src-tauri/target/release/bundle/appimage"
OUT="$OUT_DIR/${PRODUCT}_${VERSION}_amd64.AppImage"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hqsf-appimage.XXXXXX")"
APPDIR="$WORK/AppDir"
trap 'rm -rf "$WORK"' EXIT

# 二进制：Tauri CLI 会按 mainBinaryName 复制一份，cargo 原始名是包名 hq-scifi，两个都认。
BIN=""
for candidate in "src-tauri/target/release/${BINARY_NAME}" "src-tauri/target/release/${PRODUCT}"; do
  if [ -x "$candidate" ]; then BIN="$candidate"; break; fi
done
if [ -z "$BIN" ]; then
  echo "::error::找不到已构建的可执行文件（先跑 cargo tauri build --bundles deb）"
  exit 1
fi

# 资源：api.config.json / agreement.md / changelog.md（prepare-resources.mjs 的产物）
for f in api.config.json agreement.md changelog.md; do
  if [ ! -f "src-tauri/resources/$f" ]; then
    echo "::error::缺少打包资源 src-tauri/resources/$f（先跑 node src-tauri/scripts/prepare-resources.mjs）"
    exit 1
  fi
done

mkdir -p \
  "$APPDIR/usr/bin" \
  "$APPDIR/usr/lib/$PRODUCT" \
  "$APPDIR/usr/share/icons/hicolor/256x256/apps" \
  "$APPDIR/usr/share/applications"

install -m 0755 "$BIN" "$APPDIR/usr/bin/$BINARY_NAME"

# Tauri 在 Linux 上把 resource_dir() 解析成 `<exe_dir>/../lib/<package name>`（见
# tauri-utils platform.rs::resource_dir_from），所以资源必须放这里，不能放可执行文件旁边。
install -m 0644 \
  src-tauri/resources/api.config.json \
  src-tauri/resources/agreement.md \
  src-tauri/resources/changelog.md \
  "$APPDIR/usr/lib/$PRODUCT/"

install -m 0644 src-tauri/icons/256x256.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/$BINARY_NAME.png"
install -m 0644 src-tauri/icons/256x256.png "$APPDIR/$BINARY_NAME.png"
cp "$APPDIR/$BINARY_NAME.png" "$APPDIR/.DirIcon"

cat > "$APPDIR/$BINARY_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=黄芪饮片
Comment=荒启科幻：写作-阅读-评审 一站式桌面客户端
Exec=$BINARY_NAME
Icon=$BINARY_NAME
Terminal=false
Categories=Network;
StartupWMClass=huangqi-scifi
EOF
install -m 0644 "$APPDIR/$BINARY_NAME.desktop" "$APPDIR/usr/share/applications/$BINARY_NAME.desktop"

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export PATH="$HERE/usr/bin:$PATH"
exec "$HERE/usr/bin/huangqi-scifi" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# appimagetool：用 continuous 版；`--appimage-extract-and-run` 让它不依赖 FUSE（CI 里没挂载权限）。
TOOL_APPIMAGE="$WORK/appimagetool.AppImage"
curl -fsSL -o "$TOOL_APPIMAGE" \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
chmod +x "$TOOL_APPIMAGE"

mkdir -p "$OUT_DIR"
ARCH=x86_64 "$TOOL_APPIMAGE" --appimage-extract-and-run "$APPDIR" "$OUT"

ls -l "$OUT"
echo "AppImage（系统 WebKit）已生成：$OUT"