#!/usr/bin/env bash
# ============================================================
# push.sh — 沙箱内推送远端（系统 OpenSSH 配置链权限损坏时的通用解法）
#
# 用法: bash .dsh/skills/push-remote/scripts/push.sh [remote] [branch]
#
# 安全约定（重要）:
#   - 本脚本不含任何私钥内容、密钥文件名、账号信息；
#   - 身份（IdentityFile）在运行时从仓库 `git config core.sshCommand` 推导，
#     回退到 `~/.ssh/config` 对应 Host 块，再回退到 ssh 默认密钥发现；
#   - 生成的临时配置与 known_hosts 落在 <仓库>/.git/ 下：沙箱可写、天然不入库。
# ============================================================
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
REMOTE="${1:-origin}"
BRANCH="${2:-$(git branch --show-current)}"
if [ -z "$BRANCH" ]; then
  echo "无法确定当前分支（detached HEAD？），请显式传分支名" >&2
  exit 1
fi
CONF="$REPO_ROOT/.git/hqsf-ssh-config"
KNOWN="$REPO_ROOT/.git/hqsf-known_hosts"

# ---- 0) 先试常规推送：用户正常终端（系统 ssh 配置完好）直接成功 ----
if out="$(git push "$REMOTE" "$BRANCH" 2>&1)"; then
  printf '%s\n' "$out"
  exit 0
fi
if ! printf '%s\n' "$out" | grep -qiE 'Bad owner or permissions|Host key verification failed'; then
  # 非本 skill 覆盖的错误（远端拒绝/fetch first/网络不通等）：原样报错，不套 workaround
  printf '%s\n' "$out" >&2
  exit 1
fi
printf '%s\n' "系统 ssh 配置异常，改用沙箱最小配置推送（$(printf '%s' "$out" | head -1)）" >&2

# ---- 1) 解析远端 host ----
REMOTE_URL="$(git remote get-url "$REMOTE")"
case "$REMOTE_URL" in
  *://*) HOST="$(printf '%s' "$REMOTE_URL" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:]+).*#\1#')" ;;
  *)     HOST="$(printf '%s' "$REMOTE_URL" | sed -E 's#^[^@/]*@?([^:/]+).*#\1#')" ;;
esac
: "${HOST:?无法从 remote URL 解析 host: $REMOTE_URL}"

# ---- 2) 从 ~/.ssh/config 提取该 host 的 Host 块（Hostname/Port/User/IdentityFile…） ----
BLOCK=""
USER_CONF="$HOME/.ssh/config"
if [ -f "$USER_CONF" ]; then
  BLOCK="$(awk -v host="$HOST" '
    tolower($1)=="host" {
      hit = 0
      for (i = 2; i <= NF; i++) if (tolower($i) == host || $i == "*") hit = 1
      if (hit) { print; got = 1; next }
      if (got) exit
    }
    got && /^[ \t]*[^#]/ { print }
  ' "$USER_CONF")"
fi

# ---- 3) 身份推导：core.sshCommand 的 -i 参数 > Host 块内 IdentityFile > 默认 ----
IDENT=""
SSH_CMD="$(git config --get core.sshCommand 2>/dev/null || true)"
if [ -n "$SSH_CMD" ]; then
  IDENT="$(printf '%s' "$SSH_CMD" | sed -nE 's/.*-i(=| )([^ ]+).*/\2/p' | head -1)"
fi
if [ -z "$IDENT" ]; then
  IDENT="$(printf '%s\n' "$BLOCK" | sed -nE 's/^[ \t]*IdentityFile[ \t]+(.+)$/\1/p' | head -1)"
fi
# 展开 ~（ssh_config 部分版本不展开 IdentityFile 的 ~）
if [ -n "$IDENT" ]; then
  IDENT="${IDENT/#\~/$HOME}"
fi

# ---- 4) 生成最小配置（绕过系统配置链；known_hosts 落 .git/ 沙箱可写） ----
{
  printf 'Host %s\n' "$HOST"
  # 原 Host 块选项（去掉 Host 首行与身份相关行，身份统一在下方追加）
  printf '%s\n' "$BLOCK" \
    | sed -E '/^[ \t]*Host[ \t]/d; /^[ \t]*(IdentityFile|IdentitiesOnly)[ \t]/d; /^[ \t]*$/d'
  # GitHub 且无 Host 块时回退 SSH-over-HTTPS 端点（443 通常比 22 更稳）
  if [ -z "$BLOCK" ] && [ "$HOST" = "github.com" ]; then
    printf '  Hostname ssh.github.com\n  Port 443\n  User git\n'
  fi
  if [ -n "$IDENT" ]; then
    printf '  IdentityFile %s\n  IdentitiesOnly yes\n' "$IDENT"
  fi
  printf '  StrictHostKeyChecking accept-new\n  UserKnownHostsFile %s\n' "$KNOWN"
} > "$CONF"

# ---- 5) 推送 ----
printf 'GIT_SSH_COMMAND 使用最小配置：%s\n' "$CONF" >&2
GIT_SSH_COMMAND="ssh -F $CONF" git push "$REMOTE" "$BRANCH"
