# hqsf-client（黄芪饮片桌面客户端）

Electron 桌面客户端，为 [荒启科幻](https://www.huangqisf.com/) 提供 写作-阅读-评审 一站式方案。产品与技术设计见 `doc/design.md`，荒启 API 接口定义见 `api.config.example.json`（真实配置 `api.config.json` 本地持有，不入库）。
> 文档归档：除 `README.md` 与 `AGENTS.md` 外的 md 文档（产品与技术设计 `doc/design.md`）统一存放于 `doc/` 目录；荒启 API 调研文档与接口配置不入库（见 `.gitignore`）。

## Project

- 技术栈：Electron 34 + React 19 + TypeScript + electron-vite 5 + Vite 7 + Zustand 5 + electron-builder 26；better-sqlite3（本地索引）+ Milkdown v7/ProseMirror（可视化编辑器）+ CodeMirror 6（源码模式编辑器）+ markdown-it/turndown（md⇄HTML 转换）+ lucide-react（图标，ISC 许可）。
- 入口：`src/main/index.ts`（单实例锁 → `initApp`）；渲染层入口 `src/renderer/src/main.tsx`。
- M0（三端骨架 + IPC + API 代理）、M1（写作闭环：登录/同步/编辑/发布/四态）与 M2（读审一体：阅读视图 + 评审面板）代码已交付；GUI 与真实账号接口验证需正常桌面环境（沙箱限制，见 Notes 与 README 验证清单）。

## Commands

- `npm run dev` — 开发模式（HMR；GUI 验证需正常桌面环境，见 Notes）
- `npm run typecheck` — 主进程（tsconfig.node.json）+ 渲染层（tsconfig.web.json）类型检查
- `npm run build` — electron-vite 构建到 `out/`
- `npm run build:linux` — 构建 + 打包 deb / AppImage 到 `dist/`，并自动归档到 `dist/releases/<version>/`
- `npm run build:win` — 构建 + 打包 NSIS 到 `dist/`，并自动归档到 `dist/releases/<version>/`
- `node scripts/archive-release.mjs [version]` — 手动归档指定版本产物（默认当前 package.json 版本）；归档统一发布文件名（Windows exe 用点号 `hq-scifi.Setup.<v>.exe`，与 README 下载链接一致）
- 无测试与 lint 脚本

## Architecture

- `src/main/` — 主进程：
  - `window.ts` 安全窗口（`contextIsolation:true` + `sandbox:true`）；`ipc.ts` 白名单 IPC（22 个 handler，全部 `{ok,data}|{ok,error}` 约定）
  - `net/api.ts` 荒启 API 请求层（`net.fetch`，统一 `{code,msg,data,total}`，`code:1` 成功）；`net/apiconfig.ts` 配置驱动——baseUrl 与全部接口 path/method 从 `api.config.json` 读取（启动时加载，缺失抛 `ApiConfigError` 报错退出），代码不硬编码接口路径
  - `db.ts` better-sqlite3 索引（articles/meta 表；存元数据，正文是磁盘 md 文件）
  - `session.ts` safeStorage 加密 token 落盘（basic_text 后端降级标记 insecure）；`auth.ts` 登录/会话（token 不下发渲染层）
  - `fs.ts` 本地存档（根目录 `~/文档/荒启科幻/草稿`，resolve+realpath 双防穿越）；`sync.ts` 同步引擎（拉取/推送/发布/冲突检测）
  - `md2html.ts` markdown-it → Quill HTML（上传）；turndown HTML→md（拉回）
  - `read.ts` 阅读与评审适配层（文章列表/详情、评审列表/提交/态度、作品库分类）
- `src/preload/` — `contextBridge` 暴露 `window.hqsf`（白名单方法；不经过 token、不开放通用 API 代理）。
- `src/shared/` — 三端共享类型单一来源（`types.ts`）。
- `src/renderer/` — React UI：`LoginView`（账号密码/手机验证码）、`Sidebar`（用户卡 + 写作树：本地存档/草稿/待审核/已发布/已拒绝 + 同步按钮 + 栏目树）、`EditorPane`（双模式编辑：可视化 Milkdown v7/ProseMirror `MilkdownEditor`+`MilkdownToolbar` / 源码 CodeMirror 6 `SplitEditor` + 工具栏：新建/保存/同步到草稿/发布 + 状态角标）、`ReaderView`（M2 阅读视图：净化 HTML 正文 + 元信息 + 评审面板 `ReviewPanel` 五维表单）、`ArticleListView`（文章列表：排序/分页）、`lib/sanitize.ts`（远端 HTML 白名单净化防 XSS）、stores（`auth`/`docs`/`editor`/`reader`/`ui`）。
- `electron-builder.yml` — 打包配置（linux deb+AppImage、win NSIS；`asarUnpack` better-sqlite3）。

## Conventions

- 如果认为用户的设计有模糊之处，应询问用户。
- **IPC 返回约定**：成功 `{ok:true, data:业务载荷}`，失败 `{ok:false, error:string}`；主进程负责把 `ApiResponse` 解包成载荷。ping/getAppInfo 是 M0 遗留裸值接口。
- **类型单一来源**：`src/shared/types.ts` 定义跨端类型（ArticleRow/PullResult/UserSession/LocalNode/ApiResult…），主进程/preload/渲染层都从它 import；改类型只改一处。
- **API 调用坑**：`apiRequest` 默认 GET，GET 分支忽略 `body`；凡 POST 接口必须显式传 `method:'POST'`。接口路径一律经 `endpoint('接口名').path` 从配置取（新增接口需同时在 `api.config.json` 与 `net/apiconfig.ts` 的 `REQUIRED_ENDPOINTS` 中登记）。
- **token 安全**：token 只存在主进程（safeStorage），`window.hqsf` 不下发；渲染层拿不到任何凭据。
- **路径安全**：所有本地文件 IPC 都经 `fs.ts` 的 `assertInside`（resolve + realpath 防 `..`/symlink 穿越），以 `getDocsRoot()` 为根。
- 渲染层状态用 Zustand；UI 文案简体中文。
- 窗口安全：不加载远程脚本、外部链接交系统浏览器（`setWindowOpenHandler` deny + `shell.openExternal`）。

## Notes

- 本机开发沙箱（bwrap 只读容器）限制：官方 Electron 二进制无法启动 GUI（SIGTRAP，与代码无关）；`/tmp` 不跨命令持久；`rm` 走回收站会报只读，删文件用 `find -delete`；`~` 根只读，`~/.cache`/`~/.npm` 可写。
- **better-sqlite3 ABI 坑**：必须用 `electron-builder install-app-deps` 为 Electron 重建（需 `HOME` 指向可写目录，`ELECTRON_GYP_DIR` 硬编码为 `$HOME/.electron-gyp`）；v13 要求 NAPI10/Node≥22，与 Electron 34（Node 20.18）不兼容，锁 **v12.11.1**；electron-builder.yml 已配置 `asarUnpack`。
- **交叉打包 Windows 的原生模块坑**：Linux 上 `electron-builder --win` 会把本机 Linux 编译的 `better_sqlite3.node`（ELF）原样打进 Windows 包 → Windows 上 `initDb` 加载失败（unhandled rejection）→ 进程存活但永不创建窗口（界面打不开）。已修复：`scripts/win-prebuild.mjs`（apply 下载 better-sqlite3 官方 `electron-v{ABI}-win32-x64` prebuild 临时替换，restore 恢复），`npm run build:win` 已自动编排（apply 失败则不打、restore 必执行）；ABI 用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p process.versions.modules` 实测（Electron 34.5.8 = 132）。升级 Electron 时 prebuild 的 ABI 需同步匹配（v12.11.1 release 覆盖到 electron-v146）。
- **Windows 真机验证**（已用 KVM 虚拟机验证）：NSIS 安装后 `%LOCALAPPDATA%\Programs\huangqi-scifi\huangqi-scifi.exe`；SSH 启动的进程落在 Session 0 看不到 GUI，须用 `schtasks /create /it` + 批处理把应用拉进交互会话；验证界面用 CDP `--remote-debugging-port` + PowerShell `ClientWebSocket` 发 `Runtime.evaluate`（/tmp 下的 ssh 脚本不跨命令持久，见 git 记录 .ssh-tmp 一版）。本机/VM 的 CDP 调试（含无重启挂载正在运行的实例）已沉淀为项目 skill `cdp-debugging`，见 `.dsh/skills/cdp-debugging/`。
- **启动链路健壮性（待办）**：`app.whenReady().then()` 内 `initDb`/`registerImageProtocol`/`registerIpcHandlers` 任一抛错都是 unhandled rejection，进程静默无窗口、不留诊断信息——建议加 try/catch + `dialog.showErrorBox`。
- npm install-scripts 已批准：esbuild、electron-winstaller、electron、better-sqlite3@12.11.1。
- 打包工具已缓存于 `~/.cache/electron-builder`（沙箱内可直接 `npm run build:linux` 验证）。
