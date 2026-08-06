# 荒启科幻桌面客户端（hq-scifi）

[![Release](https://img.shields.io/github/v/release/Kide-Lee/HQ-SciFi)](https://github.com/Kide-Lee/HQ-SciFi/releases)
[![License](https://img.shields.io/github/license/Kide-Lee/HQ-SciFi)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)](https://github.com/Kide-Lee/HQ-SciFi/releases)

> ⚠️ **第三方非官方客户端**：本项目为独立开发的桌面客户端，与「荒启科幻」官方无隶属关系，非官方出品。

[荒启科幻](https://www.huangqisf.com/h5/#/)（huangqisf.com）写作社区的桌面客户端，为**写作、阅读、评审**提供一站式体验。

## ✨ 功能特性

- **写作**：本地 Markdown 编辑（CodeMirror 6，自动保存 + Ctrl+S），草稿 / 待审核 / 已发布 / 已拒绝四态管理，一键与荒启草稿箱同步、发布
- **阅读**：推荐（精选 / AI 模型）、连载、练笔活动、作品库五大栏目；正文安全净化渲染；列表支持按评分 / 点赞 / 评论 / 阅读数排序
- **评审**：接入官方五维评审体系（设定 / 文笔 / 人物 / 情节 / 思想性），查看与提交评审、表达态度
- **安全**：登录凭据经系统级加密（safeStorage）仅存主进程、渲染层沙箱隔离、远端内容白名单净化防 XSS

## 📦 安装

从 [GitHub Releases](https://github.com/Kide-Lee/HQ-SciFi/releases)（最新版本以 Releases 页为准）下载安装包：

| 平台 | 文件 |
| --- | --- |
| Windows | [hq-scifi.Setup.0.0.1.exe](https://github.com/Kide-Lee/HQ-SciFi/releases/download/v0.0.1/hq-scifi.Setup.0.0.1.exe) |
| Linux | [hq-scifi-0.0.1.AppImage](https://github.com/Kide-Lee/HQ-SciFi/releases/download/v0.0.1/hq-scifi-0.0.1.AppImage)（无需安装，直接运行） |
| Linux | [hq-scifi_0.0.1_amd64.deb](https://github.com/Kide-Lee/HQ-SciFi/releases/download/v0.0.1/hq-scifi_0.0.1_amd64.deb)（Debian/Ubuntu 系） |

> 更新日志见 [Releases](https://github.com/Kide-Lee/HQ-SciFi/releases)。

### 从源码构建

环境要求：Node.js ≥ 20（建议 22 LTS）+ npm。

```bash
npm install
npm run dev          # 开发模式（热更新）
npm run build:win    # 打包 Windows 安装包（dist/；自动注入 Windows 原生模块 prebuild）
npm run build:linux  # 打包 Linux（deb + AppImage，dist/）
```

> Windows 包在 Linux 交叉打包时，`build:win` 会自动下载 better-sqlite3 的 Windows prebuild 替换原生二进制（打包后恢复），无需 Windows 环境；升级 Electron 后首次打包会重新下载匹配 ABI 的 prebuild（需联网访问 GitHub Releases）。

## 🚀 使用

1. 启动客户端，使用荒启账号登录（账号密码 / 手机验证码），登录后自动恢复会话、免重复登录
2. **写作**：左侧「写作」→ 新建草稿 → 编辑（自动保存）→ 「同步到草稿」或「发布」（发布后进入官方审核流程，审核通过即公开）
3. **阅读**：通过左侧栏目（推荐 / 连载 / 活动 / 作品库）浏览文章，点击卡片进入阅读
4. **评审**：打开他人文章 → 「✎ 评审这篇文章」→ 填写五维评分与评语 → 提交

## 📚 文档

- [产品与技术设计](doc/design.md)
- [荒启 API 调查报告](doc/api-research.md)
- [荒启网站现状调研](doc/site-overview.md)

## 🛠 技术栈

Electron 34 · React 19 · TypeScript · Vite 7（electron-vite 5）· CodeMirror 6 · Zustand · better-sqlite3 · electron-builder 26

## ⚖️ 免责声明

- 本项目为第三方独立开发，非官方出品；请勿将本项目用于任何违反荒启科幻服务条款的用途。
- 站内文章等内容版权归原作者与平台所有，本客户端仅作本地管理与浏览工具。
- 请自行保管账号安全，遵守[荒启科幻](https://www.huangqisf.com/)的使用规则。

## 📄 License

[MIT](LICENSE) © 2026 之于言者
