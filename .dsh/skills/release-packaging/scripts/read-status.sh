#!/usr/bin/env bash
# 读 CI / 打包 / 发版结论。
#
# 背景：本机拿不到 Actions 日志（接口要 admin、raw.githubusercontent 不可达、
# 匿名 API 60/h），所以工作流把结论推到 git 分支，这里用最小 ssh 配置拉下来打印。
#
# 用法：
#   bash .dsh/skills/release-packaging/scripts/read-status.sh            # 四个分支全读
#   bash .dsh/skills/release-packaging/scripts/read-status.sh ci-status   # 只读一个
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT" || exit 1

SSH_CONFIG="$REPO_ROOT/.git/hqsf-ssh-config"
KNOWN_HOSTS="$REPO_ROOT/.git/hqsf-known_hosts"
if [ -f "$SSH_CONFIG" ]; then
  export GIT_SSH_COMMAND="ssh -F $SSH_CONFIG -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=accept-new"
fi

BRANCHES=("${@:-ci-status release-status release-logs ci-logs smoke-logs}")
# shellcheck disable=SC2206
BRANCHES=(${BRANCHES[@]})

for branch in "${BRANCHES[@]}"; do
  printf '\n=== %s ===\n' "$branch"
  if ! git fetch --force -q origin "$branch" 2>/dev/null; then
    echo "(远端没有这个分支，或 fetch 失败)"
    continue
  fi
  git show "origin/$branch:README.md" 2>/dev/null | head -60 || echo "(分支里没有 README.md)"
done