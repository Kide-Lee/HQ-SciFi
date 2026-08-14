#!/usr/bin/env bash
# ============================================================
# vm-connect.sh — 连接本机 KVM 上的 macOS 虚拟机（用户 virtual，免密）
#
# 用法:
#   bash .dsh/skills/macos-vm-ssh/scripts/vm-connect.sh                 # 自动发现 IP，进入交互 shell
#   bash .dsh/skills/macos-vm-ssh/scripts/vm-connect.sh 'whoami; sw_vers'   # 在 VM 内执行一条命令
#   VM_IP=<VM的IP> bash .dsh/skills/macos-vm-ssh/scripts/vm-connect.sh '...'  # 显式指定 IP
#
# 安全约定（重要）:
#   - 本脚本不含任何密码、密钥路径、账号信息——身份走 ssh 默认密钥发现（免密已配置）；
#   - 临时 ssh 配置与 known_hosts 落在 <仓库>/.git/ 下：沙箱可写、天然不入库。
# ============================================================
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CONF="$REPO_ROOT/.git/vm-ssh-config"
KNOWN="$REPO_ROOT/.git/vm-known_hosts"
VM_USER="${VM_USER:-virtual}"
CMD="${1:-}"

# ---- 1) 发现 VM IP：环境变量 > virbr0 ARP 邻居里的 QEMU 虚拟机（MAC 前缀 52:54:00） ----
if [ -z "${VM_IP:-}" ]; then
  # ARP 邻居可能过期（STALE 被清）：广播 ping 触发各主机回复来刷新（需 root，失败忽略）
  timeout 2 ping -b -c 1 -W 1 192.168.122.255 >/dev/null 2>&1 || true
  # 解析不依赖字段位置：行内含 QEMU MAC 前缀即视为目标，取行首 IPv4
  VM_IP="$(ip neigh show dev virbr0 2>/dev/null \
    | awk '$0 ~ /52:54:00/ && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $1; exit }')"
fi
if [ -z "${VM_IP:-}" ]; then
  # 沙箱外兜底：virsh 查运行中的域及其 IP（沙箱内 /run/user 只读会导致 virsh 失败，忽略）
  DOM="$(virsh list --name --state-running 2>/dev/null | head -1)"
  if [ -n "$DOM" ]; then
    VM_IP="$(virsh domifaddr --domain "$DOM" --source arp 2>/dev/null \
      | awk '/ipv4/ { gsub(/\/.*/, "", $NF); print $NF; exit }')"
  fi
fi
if [ -z "${VM_IP:-}" ]; then
  echo "未能自动发现 VM IP。请先确认虚拟机在运行，然后显式指定：" >&2
  echo "  VM_IP=<地址> bash $0 [命令]" >&2
  echo "（自动发现：virbr0 网桥 ARP 邻居中 MAC 前缀 52:54:00 的地址；virsh 为沙箱外兜底）" >&2
  exit 1
fi

# ---- 2) 生成最小 ssh 配置（绕过沙箱里损坏的系统配置链；known_hosts 落 .git/ 可写） ----
{
  printf 'Host %s\n' "$VM_IP"
  printf '  StrictHostKeyChecking accept-new\n'
  printf '  UserKnownHostsFile %s\n' "$KNOWN"
} > "$CONF"

# ---- 3) 连接：有命令参数则执行后退出，否则进入交互 shell ----
# BatchMode=yes：免密场景下快速失败，避免挂在密码提示上
SSH_ARGS=(-F "$CONF" -o BatchMode=yes -o ConnectTimeout=8 "$VM_USER@$VM_IP")
if [ -n "$CMD" ]; then
  ssh "${SSH_ARGS[@]}" "$CMD"
else
  echo "连接到 ${VM_USER}@${VM_IP}（退出用 exit）…" >&2
  ssh -t "${SSH_ARGS[@]}"
fi
