---
name: push-remote
description: 把本地提交推送到远端仓库（git push）。DSH 沙箱内系统 OpenSSH 配置链含权限损坏文件（/etc/ssh/ssh_config.d/*.conf 报 Bad owner or permissions，且 home 只读导致 known_hosts 无法落盘）时，自动生成最小 ssh 配置（放在 <仓库>/.git/，不入库）并以其推送；身份在运行时从仓库 core.sshCommand 与 ~/.ssh/config 推导，不含任何私钥内容或密钥文件名。当用户要求"推送/提交后推送到远端/推到 GitHub"时使用。
---

# 推送远端（git push）

## 用法

```bash
bash .dsh/skills/push-remote/scripts/push.sh                # 推 origin + 当前分支
bash .dsh/skills/push-remote/scripts/push.sh origin main    # 显式指定 remote 与分支
```

## 为什么需要这个 skill

- **症状**：`git push` 报 `Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`，或 `Host key verification failed`。
- **根因**：DSH 沙箱把系统 ssh 配置链里的文件暴露为 `nobody` 所有/全局可写（OpenSSH 拒绝读取任何权限过宽的配置）；同时 `~/.ssh`、`~/.cache` 只读，known_hosts 无法写入。
- **解法**：`ssh -F <最小配置>` 完全绕过系统配置链；主机密钥校验用 `StrictHostKeyChecking accept-new`，known_hosts 写到工作区 `<仓库>/.git/`（沙箱可写、不入库）。

## 脚本流程

1. 先试常规 `git push`（用户正常终端里系统配置完好，直接成功，不绕路）。
2. 失败且错误特征匹配（Bad owner / Host key verification）才进入 workaround；其他错误（远端拒绝、fetch first、网络不通）原样报错退出。
3. 从 `git remote get-url <remote>` 解析 host（支持 scp 与 https 两种 URL 形态）。
4. 从 `~/.ssh/config` 提取该 host 的 Host 块（Hostname/Port/User/ProxyJump 等原样带出）。
5. 身份推导顺序：仓库 `git config core.sshCommand` 里的 `-i <path>` → Host 块内 `IdentityFile` → ssh 默认密钥发现。GitHub 且无 Host 块时回退 `ssh.github.com:443`（SSH-over-HTTPS）。
6. 生成 `.git/hqsf-ssh-config` + `.git/hqsf-known_hosts`，以 `GIT_SSH_COMMAND="ssh -F <配置>"` 推送。

## 安全约定（重要）

- **本 skill 不含任何私钥内容、密钥文件名或账号信息**——身份路径全部在运行时从 `git config` / `~/.ssh/config` 推导；
- 生成的 `hqsf-ssh-config`（含 IdentityFile 路径）与 `hqsf-known_hosts` 都在 `<仓库>/.git/` 内，天然不入库，可随时删除；
- 若目标仓库需要不同身份，先设置 `git config core.sshCommand "ssh -i <密钥路径> …"` 再跑脚本，或直接以环境变量 `GIT_SSH_COMMAND` 覆盖（环境变量优先于配置）。

## 坑清单

| 坑 | 对策 |
| --- | --- |
| `Bad owner or permissions on /etc/ssh/ssh_config.d/…` | 不要尝试 chmod 系统文件（只读且无效）；用 `-F` 最小配置绕过 |
| `Host key verification failed`（home 只读、无 known_hosts） | `accept-new` + `UserKnownHostsFile` 指向 `.git/`（可写） |
| 推送报错不是上述特征错误 | 脚本原样报错退出，不套 workaround，避免掩盖真实原因 |
| detached HEAD（无当前分支） | 显式传分支名：`push.sh origin <分支>` |
| 换了仓库/远端/密钥 | 全部运行时推导：换 `core.sshCommand` 的 `-i` 即可，脚本无需改动 |
| 系统配置链修复后 | 脚本第 0 步直接成功，workaround 不再触发 |
