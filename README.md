# 荒启科幻桌面客户端（hqsf-client）

[荒启科幻](https://www.huangqisf.com/h5/#/) 的电脑客户端，写作-阅读-评审一站式方案。设计文档见 [design.md](design.md)，荒启 API 调查报告见 [api-research.md](api-research.md)。

## 技术栈

Electron 34 + React 19 + TypeScript + Vite 7（electron-vite 5）+ CodeMirror 6（M1 引入）+ Zustand + electron-builder 26。

## 目录结构

```
src/
├─ main/          # 主进程：窗口、IPC、荒启 API 网络代理（net.fetch）
├─ preload/       # contextBridge 白名单 API（window.hqsf）
└─ renderer/      # React 渲染层（contextIsolation + sandbox）
resources/        # 打包资源（icon 等）
dist/             # electron-builder 产物
out/              # electron-vite 构建产物
```

## 常用命令

```bash
npm run dev          # 开发模式（HMR）
npm run build        # 仅构建（electron-vite build）
npm run typecheck    # 类型检查（主进程 + 渲染层）
npm run build:linux  # 构建并打包 Linux（deb + AppImage）
npm run build:win    # 构建并打包 Windows（NSIS）
```

## 架构要点

- **安全**：渲染层 `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，仅经 `window.hqsf` 白名单 IPC 与主进程通信；网络请求统一在主进程（`net.fetch`，规避 CORS、集中管理 token/重试）。
- **荒启 API**：主进程 `src/main/net/api.ts` 封装统一请求（`{code,msg,data,total}` 约定，`searchParams`/`params` 参数规范），渲染层经 `window.hqsf.apiRequest(path, options)` 调用。
- **M0 状态**：脚手架骨架 + IPC/网络连通性自检按钮（主界面右下）。SQLite 索引、CodeMirror 编辑器、登录与同步为 M1 内容。

## 状态

**M0（脚手架）已交付**：三端骨架（main/preload/renderer）、安全窗口（contextIsolation + sandbox + CSP 基础版）、IPC 白名单 API（`window.hqsf`）、荒启 API 网络代理（`net.fetch`）、左侧栏+主界面 UI 骨架、连通性自检按钮；`npm run typecheck` 与 `npm run build` 均通过。

**M0 收尾验证清单（需在正常桌面环境执行，沙箱内无法完成）**：

1. **GUI 运行验证**：`npm run dev`
   - 预期：窗口「荒启科幻」出现；左侧栏五个栏目（写作/推荐/连载/活动/作品库）可切换，文件树随栏目变化；主界面右下角「连通性自检（IPC + 荒启 API）」按钮点击后显示 `IPC: pong ✓ · 荒启 API 连通（…）✓`。
   - 已知：开发沙箱（bwrap 只读容器）中官方 Electron 二进制在 Chromium 初始化时 SIGTRAP，与项目代码无关；`electron-vite dev` 的 vite 构建与 dev server 部分已在本沙箱验证正常。
2. **Linux 安装包**：`npm run build:linux`（产出 `dist/*.deb` 与 `dist/*.AppImage`）
   - 网络要求：electron-builder 首次运行需从 GitHub 下载 fpm/AppImage 工具；若不可达可设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（注意：该镜像对 fpm 等个别文件 302 回源 GitHub，可能仍超时）。
3. **Windows 安装包**：`npm run build:win`（产出 `dist/*.exe` NSIS 安装包；跨平台打 NSIS 可用，但如需代码签名/图标嵌入建议在 Windows 上执行）
   - 预期：deb/AppImage/NSIS 均可安装启动，AppImage 可直接运行。

完成验证后，将结果与安装包路径回填到本文件「状态」小节，并把 design.md M0 行状态更新为最终交付。

**M1 内容**：登录与会话持久化、SQLite 索引（better-sqlite3）、CodeMirror 6 编辑器、草稿同步与发布（对接荒启 API，见 api-research.md）。

## 开发环境已知问题（沙箱）

本项目的开发/构建在受限沙箱中完成，以下结论为已排查确认的事实，供后续开发参考：

- **沙箱结构**：bwrap 只读容器——`/` 只读，仅 `/home/kidelee/Projects/hqsf`、`~/.cache`、`~/.npm` 可写；`/tmp` 不跨命令持久；`gio`/`rm` 走回收站会报「只读文件系统」（用 `find -delete`）；无 sudo。
- **官方 Electron 二进制无法启动 GUI**：任何版本（34/38/43）在 app 初始化阶段 SIGTRAP（`int3; ud2` 即 Chromium IMMEDIATE_CRASH；core 分析崩溃栈落在 Node/libuv 初始化区，si_code=SI_KERNEL；与项目代码无关，最小 `app.whenReady` 脚本同样崩溃）。系统预装的 VS Code（Electron 42）、QQ（Electron 40）为定制构建、可正常跑，不能替代调试。`--version`、`ELECTRON_RUN_AS_NODE=1`、Node 模式均正常。**GUI 验证只能在正常桌面环境做**。
- **GitHub 不可达**：`npm` 安装 electron 需镜像 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` + 手动 `node node_modules/electron/install.js`；electron-builder 工具下载需 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（electron 包可下，fpm/AppImage 工具镜像 302 回源仍超时，安装包构建受阻）。
- **npm 安全策略**：install scripts 需 `npm install-scripts approve <pkg>` 批准（本项目已批准 esbuild、electron-winstaller）。
- **版本锁定**：electron@34.5.8（与崩溃无关，纯粹当时的稳定选择）；`@vitejs/plugin-react@^5` + `vite@^7` + `electron-vite@^5` 是兼容组合（plugin-react 6 需 vite 8）；TypeScript 7 已移除 `baseUrl`，`paths` 需相对路径。
