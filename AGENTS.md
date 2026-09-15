# hqsf-client（黄芪饮片桌面客户端）

Electron 桌面客户端，为 [荒启科幻](https://www.huangqisf.com/) 提供 写作-阅读-评审 一站式方案。产品与技术设计见 `doc/design.md`，荒启 API 接口定义见 `api.config.example.json`（真实配置 `api.config.json` 本地持有，不入库）。
> 文档归档：除 `README.md` 与 `AGENTS.md` 外的 md 文档（产品与技术设计 `doc/design.md`）统一存放于 `doc/` 目录；荒启 API 调研文档与接口配置不入库（见 `.gitignore`）。

## Project

- 技术栈：Electron 34 + React 19 + TypeScript + electron-vite 5 + Vite 7 + Zustand 5 + electron-builder 26；better-sqlite3（本地索引）+ Milkdown v7/ProseMirror（可视化编辑器）+ CodeMirror 6（源码模式编辑器）+ markdown-it/turndown（md⇄HTML 转换）+ lucide-react（图标，ISC 许可）。
- 入口：`src/main/index.ts`（单实例锁 → `initApp`）；渲染层入口 `src/renderer/src/main.tsx`。
- M0（三端骨架 + IPC + API 代理）、M1（写作闭环：登录/同步/编辑/发布/四态）与 M2（读审一体：阅读视图 + 评审面板）代码已交付；GUI 可在沙箱内验证（见 Notes「沙箱内真实 GUI + CDP 验证」），真实账号接口验证仍需可用网络与账号。

## Commands

- `npm run dev` — 开发模式（HMR；沙箱内 GUI 验证方式见 Notes）
- `npm run typecheck` — 主进程（tsconfig.node.json）+ 渲染层（tsconfig.web.json）类型检查
- `npm run build` — electron-vite 构建到 `out/`
- `npm run build:linux` — 构建 + 打包 deb / AppImage 到 `dist/`，并自动归档到 `dist/releases/<version>/`
- `npm run build:win` — 构建 + 打包 NSIS 到 `dist/`，并自动归档到 `dist/releases/<version>/`
- `node scripts/archive-release.mjs [version]` — 手动归档指定版本产物（默认当前 package.json 版本）；归档统一发布文件名（Windows exe 用点号 `hq-scifi.Setup.<v>.exe`，与 README 下载链接一致）
- 无测试与 lint 脚本

## Architecture

- `src/main/` — 主进程：
  - `bootstrap/` 启动编排；`window/` 安全窗口与窗口行为；`ipc/` 领域 handler（`ipc.ts` 为历史入口，指向 `ipc/index.ts`）；`services/` 应用服务；`adapters/` API 适配与字段规整；`infra/` 网络/DB/FS/会话/设置/更新/媒体；`domain/` 纯业务规则
  - 旧路径 `net/api.ts`、`net/apiconfig.ts`、`db.ts`、`fs.ts`、`session.ts`、`settings.ts`、`imgcache.ts`、`md2html.ts`、`updater.ts` 保留兼容 shim，指向 `infra/`
  - IPC 白名单 85 个 handler，全部 `{ok,data}|{ok,error}` 约定
- `src/preload/` — `contextBridge` 暴露 `window.hqsf`（85 个 invoke + 2 个事件订阅；白名单方法；不经过 token、不开放通用 API 代理）。
- `src/shared/` — 三端共享类型单一来源（`domain/`；`types.ts` 为兼容重定向）；`contracts/` 固化 IPC 通道与 `HqsfApi` 契约。
- `src/renderer/` — React UI：`features/<feature>/` 业务组件；`components/` 通用 UI（media/feedback/user/modal 子目录）；`lib/` 纯函数；`stores/` 按 feature 分（auth/docs/editor/reader/user/notifications/chat/settings/ui）。
- `electron-builder.yml` — 打包配置（linux deb+AppImage、win NSIS；`asarUnpack` better-sqlite3）。

## Conventions

- 如果认为用户的设计有模糊之处，应询问用户。
- **IPC 返回约定**：成功 `{ok:true, data:业务载荷}`，失败 `{ok:false, error:string}`；主进程负责把 `ApiResponse` 解包成载荷。ping/getAppInfo 是 M0 遗留裸值接口。
- **类型单一来源**：`src/shared/domain/` 定义跨端类型（ArticleRow/PullResult/UserSession/LocalNode/ApiResult…），`src/shared/types.ts` 为兼容重定向；主进程/preload/渲染层都从 domain import；改类型只改一处。
- **API 调用坑**：`apiRequest` 默认 GET，GET 分支忽略 `body`；凡 POST 接口必须显式传 `method:'POST'`。接口路径一律经 `endpoint('接口名').path` 从配置取（新增接口需同时在 `api.config.json` 与 `infra/net/apiconfig.ts` 的 `REQUIRED_ENDPOINTS` 中登记）。
- **token 安全**：token 只存在主进程（safeStorage），`window.hqsf` 不下发；渲染层拿不到任何凭据。
- **路径安全**：所有本地文件 IPC 都经 `infra/fs/index.ts` 的 `assertInside`（resolve + realpath 防 `..`/symlink 穿越），以 `getDocsRoot()` 为根。
- **右键菜单**：统一走 `components/menu/` 的 `useContextMenu()` + App 根部唯一的 `<ContextMenuHost />`（状态在 `stores/contextMenu.ts`）；菜单**只放没有按钮入口的操作**（例：编辑器不放撤销/重做——工具栏已有；输入框没有对应按钮，回退菜单里保留）。Host 会给每个菜单统一追加「刷新（整页重载，重载前先落盘编辑器改动）+ 开发者工具」，调用方不要自己加（`appMenuItems.tsx`）。现有上下文：编辑器（含链接三项）/ 本地文件树 / 阅读正文选区 / 评论 / 评审 / 聊天消息 / 通知 / 可编辑元素回退（`editableContextMenu.tsx`）；复制一律走 `window.hqsf.copyText`，取选区用 `lib/selection.ts` 的 `readSelection`，引用格式用 `toQuoteLine`。
- 渲染层状态用 Zustand；UI 文案简体中文。
- 窗口安全：不加载远程脚本、外部链接交系统浏览器（`setWindowOpenHandler` deny + `shell.openExternal`）。

## Notes

- 本机开发沙箱（bwrap 只读容器）限制：`~` 根只读——`app.getPath('userData')` 下建不了单实例锁 `SingletonLock`，应用会立刻退出（早期误记为「SIGTRAP，与代码无关」）；`/tmp` 不跨命令持久；`rm` 走回收站会报只读，删文件用 `find -delete`；`~/.cache`/`~/.npm` 可写。
- **沙箱内真实 GUI + CDP 验证（已实测可行）**：`HOME=<工作区>/node_modules/.dev-home node_modules/electron/dist/electron --inspect=9229 .` 能把界面真正跑起来（隔离 HOME，不碰用户的 `~/.config` 与文档目录）；随后用本仓 skill 的客户端 `CDP_PORT=9229 node .dsh/skills/cdp-debugging/scripts/cdp.mjs eval "$(cat 脚本)"` 在主进程上下文 `webContents.debugger` 挂渲染层，用 `Runtime.evaluate` 派发 `MouseEvent('contextmenu')`/`KeyboardEvent` 并断言 DOM，即可验证右键菜单等交互。注意：每条 bash 命令各有独立 PID namespace，应用必须和验证脚本在同一条命令里启动。
- **better-sqlite3 ABI 坑**：必须用 `electron-builder install-app-deps` 为 Electron 重建（需 `HOME` 指向可写目录，`ELECTRON_GYP_DIR` 硬编码为 `$HOME/.electron-gyp`）；v13 要求 NAPI10/Node≥22，与 Electron 34（Node 20.18）不兼容，锁 **v12.11.1**；electron-builder.yml 已配置 `asarUnpack`。
- **交叉打包 Windows 的原生模块坑**：Linux 上 `electron-builder --win` 会把本机 Linux 编译的 `better_sqlite3.node`（ELF）原样打进 Windows 包 → Windows 上 `initDb` 加载失败（unhandled rejection）→ 进程存活但永不创建窗口（界面打不开）。已修复：`scripts/win-prebuild.mjs`（apply 下载 better-sqlite3 官方 `electron-v{ABI}-win32-x64` prebuild 临时替换，restore 恢复），`npm run build:win` 已自动编排（apply 失败则不打、restore 必执行）；ABI 用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p process.versions.modules` 实测（Electron 34.5.8 = 132）。升级 Electron 时 prebuild 的 ABI 需同步匹配（v12.11.1 release 覆盖到 electron-v146）。
- **Windows 真机验证**（已用 KVM 虚拟机验证）：NSIS 安装后 `%LOCALAPPDATA%\Programs\huangqi-scifi\huangqi-scifi.exe`；SSH 启动的进程落在 Session 0 看不到 GUI，须用 `schtasks /create /it` + 批处理把应用拉进交互会话；验证界面用 CDP `--remote-debugging-port` + PowerShell `ClientWebSocket` 发 `Runtime.evaluate`（/tmp 下的 ssh 脚本不跨命令持久，见 git 记录 .ssh-tmp 一版）。本机/VM 的 CDP 调试（含无重启挂载正在运行的实例）已沉淀为项目 skill `cdp-debugging`，见 `.dsh/skills/cdp-debugging/`。
- **启动链路健壮性（待办）**：`app.whenReady().then()` 内 `initDb`/`registerImageProtocol`/`registerIpcHandlers` 任一抛错都是 unhandled rejection，进程静默无窗口、不留诊断信息——建议加 try/catch + `dialog.showErrorBox`。
- npm install-scripts 已批准：esbuild、electron-winstaller、electron、better-sqlite3@12.11.1。
- 打包工具已缓存于 `~/.cache/electron-builder`（沙箱内可直接 `npm run build:linux` 验证）。
