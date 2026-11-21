#!/usr/bin/env bash
# 把已发布（非 draft）的 Release 安装包下载到 dist/releases/<version>/，并生成 SHA256SUMS。
# 用法: bash .dsh/skills/release-packaging/scripts/fetch-assets.sh 2.0.14
set -euo pipefail

VERSION="${1:?用法: fetch-assets.sh <version，如 2.0.14>}"
TAG="v${VERSION}"
REPO="Kide-Lee/HQ-SciFi"
DEST="dist/releases/${VERSION}"

mkdir -p "$DEST"
cd "$DEST"

curl -sS -m 30 "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'assets' not in d:
    raise SystemExit('读不到 Release: ' + str(d.get('message')))
for a in d['assets']:
    print(a['name'], a['size'], a['browser_download_url'])
" | while read -r name size url; do
    if [ -f "$name" ] && [ "$(stat -c%s "$name")" = "$size" ]; then
      echo "已有 $name ($size)"
      continue
    fi
    echo "下载 $name ($size) ..."
    for i in 1 2 3 4 5; do
      curl -sSL -m 1800 -C - --retry 5 --retry-delay 4 --retry-all-errors -o "$name" "$url" && break
      echo "  第 $i 次失败，重试" >&2
    done
    [ "$(stat -c%s "$name")" = "$size" ] || { echo "体积不符：$name" >&2; exit 1; }
done

# AppImage 需要可执行位
chmod +x ./*.AppImage 2>/dev/null || true
sha256sum hq-scifi_"${VERSION}"_* > SHA256SUMS
sha256sum -c SHA256SUMS
echo "完成：$(pwd)"
