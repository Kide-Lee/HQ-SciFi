---
name: macos-vm-ssh
description: 连接本机 KVM 上的 macOS 虚拟机（用户 virtual，免密）：自动从 virbr0 网桥 ARP 邻居发现 VM 的 DHCP 地址（QEMU MAC 前缀 52:54:00），生成最小 ssh 配置（放 <仓库>/.git/，绕过 DSH 沙箱损坏的系统 ssh 配置链），以免密方式执行命令或进入交互 shell。不含任何密码、密钥路径或账号信息。当用户要求"连接/ssh 到 macOS 虚拟机/KVM/VM"或要在 VM 内执行命令/验证应用时使用。
---

# 连接 macOS 虚拟机（KVM + virtual 用户免密）

## 用法

```bash
bash .dsh/skills/macos-vm-ssh/scripts/vm-connect.sh                     # 自动发现 IP，进入交互 shell
bash .dsh/skills/macos-vm-ssh/scripts/vm-connect.sh 'whoami; sw_vers'   # 在 VM 内执行一条命令后退出
VM_IP=<VM的IP> bash .dsh/skills/macos-vm-ssh/scripts/vm-connect.sh 'uname -m'  # 显式指定 IP
```

环境变量：`VM_IP`（显式指定地址，跳过自动发现）、`VM_USER`（默认 `virtual`）。

## 为什么需要这个 skill

- **VM 地址是 DHCP 分配的**：每次启动可能变化，不能写死 IP——从 KVM 默认网桥 `virbr0`（192.168.122.1/24）的 ARP 邻居表自动发现，QEMU 虚拟机 MAC 前缀固定为 `52:54:00`。
- **DSH 沙箱系统 ssh 配置链损坏**：`/etc/ssh/ssh_config.d/*.conf` 报 `Bad owner or permissions`，且 home 只读导致 known_hosts 无法落盘——与 `push-remote` 同款解法：`ssh -F <最小配置>` 绕过，known_hosts 写到 `<仓库>/.git/`。
- **免密已配置**：本机默认 ssh 密钥已在 VM 的 `authorized_keys` 中（`BatchMode=yes` 验证通过，无密码提示）；macOS 侧需开启「系统设置 → 通用 → 共享 → 远程登录」。

## 脚本流程

1. 发现 IP：`VM_IP` 环境变量 > `ip neigh show dev virbr0` 中 MAC 前缀 `52:54:00` 的邻居；找不到则报错并提示显式指定。
2. 生成 `.git/vm-ssh-config`（`StrictHostKeyChecking accept-new` + `.git/vm-known_hosts`），完全绕过系统配置链。
3. 连接 `virtual@<ip>`：带命令参数 → 执行后退出；无参数 → `ssh -t` 进入交互 shell。`BatchMode=yes` 保证免密失败时快速报错而非挂起。

## 安全约定（重要）

- **本 skill 不含任何密码、私钥内容、密钥文件名或账号信息**——身份走 ssh 默认密钥发现（`~/.ssh/` 下默认命名的密钥），不硬编码；
- 生成的 `vm-ssh-config` / `vm-known_hosts` 在 `<仓库>/.git/` 内，天然不入库，可随时删除；
- 所有操作都在 VM 内以 `virtual` 用户身份执行；涉及真实数据的操作（安装、重启、改配置）先征得用户同意。

## 坑清单

| 坑 | 对策 |
| --- | --- |
| VM 重启后 IP 变了 | 脚本每次自动从 ARP 邻居发现；也可 `VM_IP=…` 显式指定 |
| 找不到 VM（无 `52:54:00` 邻居） | 确认 VM 在运行（`virsh list --all`）；STALE 邻居过期后重新 `ping` 触发 ARP，或显式传 `VM_IP` |
| `Bad owner or permissions on /etc/ssh/ssh_config.d/…` | 不要 chmod 系统文件；`-F` 最小配置绕过 |
| `Host key verification failed`（home 只读） | `accept-new` + `UserKnownHostsFile` 指向 `.git/`（可写） |
| 22 端口不通 | macOS 需开启「远程登录」（系统设置 → 通用 → 共享）；或 VM 网卡未接入 virbr0 |
| 密码提示挂起 | 免密未配置时 `BatchMode=yes` 会直接报错而非挂起；先检查 VM 侧 `authorized_keys` |
| 多台 KVM 虚拟机 | 自动发现取第一个匹配；显式传 `VM_IP` 指定目标 |
