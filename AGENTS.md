# hqsf-client（荒启科幻桌面客户端）

Electron 桌面客户端，为 [荒启科幻](https://www.huangqisf.com/) 提供 写作-阅读-评审 一站式方案。产品与技术设计见 `design.md`，荒启 API 调查报告见 `api-research.md`。

## Project

- 技术栈：Electron 34 + React 19 + TypeScript + electron-vite 5 + Vite 7 + Zustand 5 + electron-builder 26；better-sqlite3（本地索引）+ CodeMirror 6（编辑器）+ markdown-it/turndown（md⇄HTML 转换）。
- 入口：`src/main/index.ts`（单实例锁 → `initApp`）；渲染层入口 `src/renderer/src/main.tsx`。
- M0（三端骨架 + IPC + API 代理）、M1（写作闭环：登录/同步/编辑/发布/四态）与 M2（读审一体：阅读视图 + 评审面板）代码已交付；GUI 与真实账号接口验证需正常桌面环境（沙箱限制，见 Notes 与 README 验证清单）。

## Commands

- `npm run dev` — 开发模式（HMR；GUI 验证需正常桌面环境，见 Notes）
- `npm run typecheck` — 主进程（tsconfig.node.json）+ 渲染层（tsconfig.web.json）类型检查
- `npm run build` — electron-vite 构建到 `out/`
- `npm run build:linux` — 构建 + 打包 deb / AppImage 到 `dist/`
- `npm run build:win` — 构建 + 打包 NSIS 到 `dist/`
- 无测试与 lint 脚本

## Architecture

- `src/main/` — 主进程：
  - `window.ts` 安全窗口（`contextIsolation:true` + `sandbox:true`）；`ipc.ts` 白名单 IPC（22 个 handler，全部 `{ok,data}|{ok,error}` 约定）
  - `net/api.ts` 荒启 API（`net.fetch`，统一 `{code,msg,data,total}`，`code:1` 成功，基址 `https://api.huangqisf.com/`）
  - `db.ts` better-sqlite3 索引（articles/meta 表；存元数据，正文是磁盘 md 文件）
  - `session.ts` safeStorage 加密 token 落盘（basic_text 后端降级标记 insecure）；`auth.ts` 登录/会话（token 不下发渲染层）
  - `fs.ts` 本地存档（根目录 `~/文档/荒启科幻/草稿`，resolve+realpath 双防穿越）；`sync.ts` 同步引擎（拉取/推送/发布/冲突检测）
  - `md2html.ts` markdown-it → Quill HTML（上传）；turndown HTML→md（拉回）
  - `read.ts` 阅读与评审适配层（文章列表/详情、评审列表/提交/态度、作品库分类）
- `src/preload/` — `contextBridge` 暴露 `window.hqsf`（白名单方法；不经过 token、不开放通用 API 代理）。
- `src/shared/` — 三端共享类型单一来源（`types.ts`）。
- `src/renderer/` — React UI：`LoginView`（账号密码/手机验证码）、`Sidebar`（用户卡 + 写作树：本地存档/草稿/待审核/已发布/已拒绝 + 同步按钮 + 栏目树）、`EditorPane`（CodeMirror 6 + 工具栏：新建/保存/同步到草稿/发布 + 状态角标）、`ReaderView`（M2 阅读视图：净化 HTML 正文 + 元信息 + 评审面板 `ReviewPanel` 五维表单）、`ArticleListView`（文章列表：排序/分页）、`lib/sanitize.ts`（远端 HTML 白名单净化防 XSS）、stores（`auth`/`docs`/`editor`/`reader`/`ui`）。
- `electron-builder.yml` — 打包配置（linux deb+AppImage、win NSIS；`asarUnpack` better-sqlite3）。

## Conventions

- **IPC 返回约定**：成功 `{ok:true, data:业务载荷}`，失败 `{ok:false, error:string}`；主进程负责把 `ApiResponse` 解包成载荷。ping/getAppInfo 是 M0 遗留裸值接口。
- **类型单一来源**：`src/shared/types.ts` 定义跨端类型（ArticleRow/PullResult/UserSession/LocalNode/ApiResult…），主进程/preload/渲染层都从它 import；改类型只改一处。
- **API 调用坑**：`apiRequest` 默认 GET，GET 分支忽略 `body`；凡 POST 接口必须显式传 `method:'POST'`。对接新接口先查 `api-research.md` 确认 method 与参数。
- **token 安全**：token 只存在主进程（safeStorage），`window.hqsf` 不下发；渲染层拿不到任何凭据。
- **路径安全**：所有本地文件 IPC 都经 `fs.ts` 的 `assertInside`（resolve + realpath 防 `..`/symlink 穿越），以 `getDocsRoot()` 为根。
- 渲染层状态用 Zustand；UI 文案简体中文。
- 窗口安全：不加载远程脚本、外部链接交系统浏览器（`setWindowOpenHandler` deny + `shell.openExternal`）。

## Notes

- 本机开发沙箱（bwrap 只读容器）限制：官方 Electron 二进制无法启动 GUI（SIGTRAP，与代码无关）；`/tmp` 不跨命令持久；`rm` 走回收站会报只读，删文件用 `find -delete`；`~` 根只读，`~/.cache`/`~/.npm` 可写。
- **better-sqlite3 ABI 坑**：必须用 `electron-builder install-app-deps` 为 Electron 重建（需 `HOME` 指向可写目录，`ELECTRON_GYP_DIR` 硬编码为 `$HOME/.electron-gyp`）；v13 要求 NAPI10/Node≥22，与 Electron 34（Node 20.18）不兼容，锁 **v12.11.1**；electron-builder.yml 已配置 `asarUnpack`。
- npm install-scripts 已批准：esbuild、electron-winstaller、electron、better-sqlite3@12.11.1。
- 打包工具已缓存于 `~/.cache/electron-builder`（沙箱内可直接 `npm run build:linux` 验证）。
