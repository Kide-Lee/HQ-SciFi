# hqsf-client（荒启科幻桌面客户端）

Electron 桌面客户端，为 [荒启科幻](https://www.huangqisf.com/) 提供 写作-阅读-评审 一站式方案。产品与技术设计见 `design.md`，荒启 API 调查报告见 `api-research.md`。

## Project

- 技术栈：Electron 34 + React 19 + TypeScript + electron-vite 5 + Vite 7 + Zustand 5 + electron-builder 26；本地 Markdown 写作与 SQLite 索引计划 M1 引入。
- 入口：`src/main/index.ts`（单实例锁 → `initApp`）；渲染层入口 `src/renderer/src/main.tsx`。
- M0 已交付（三端骨架 + IPC + API 代理 + UI 骨架），GUI 与安装包验证基本完成；当前处于 M0 收尾 / M1 起点。

## Commands

- `npm run dev` — 开发模式（HMR；GUI 验证需正常桌面环境，见 Notes）
- `npm run typecheck` — 主进程（tsconfig.node.json）+ 渲染层（tsconfig.web.json）类型检查
- `npm run build` — electron-vite 构建到 `out/`
- `npm run build:linux` — 构建 + 打包 deb / AppImage 到 `dist/`
- `npm run build:win` — 构建 + 打包 NSIS 到 `dist/`
- 无测试与 lint 脚本

## Architecture

- `src/main/` — 主进程：`window.ts` 安全窗口（`contextIsolation:true` + `sandbox:true`）、`ipc.ts` 白名单 IPC、`net/api.ts` 荒启 API 代理（`net.fetch`，统一 `{code,msg,data,total}` 约定，`code:1` 成功，基址 `https://api.huangqisf.com/`）。
- `src/preload/` — `contextBridge` 暴露 `window.hqsf`（ping / getAppInfo / apiRequest），渲染层不接触 Node/网络。
- `src/renderer/` — React UI：`App.tsx` 布局、`components/Sidebar.tsx`（五栏目 + 文件树）、`components/MainArea.tsx`（主区占位 + 连通性自检）、`stores/ui.ts`（Zustand）。
- `electron-builder.yml` — 打包配置（linux deb+AppImage、win NSIS；`homepage`/`desktopName` 在 package.json）。

## Conventions

- **IPC 返回约定**：成功 `{ok:true, data:业务载荷, total?:number}`，失败 `{ok:false, error:string}`；主进程负责把 `ApiResponse` 解包成载荷，渲染层拿到的 `data` 即业务数据（不要双层取 `data.data`）。
- **API 调用坑**：`apiRequest` 默认 GET，GET 分支忽略 `body`；凡 POST 接口（如 `system/app`、`contentsList`）必须显式传 `method:'POST'`。对接新接口先查 `api-research.md` 确认 method。
- 渲染层状态用 Zustand；UI 文案简体中文；类型定义集中在 `src/preload/index.d.ts` 供渲染层使用。
- 窗口安全：不加载远程脚本、外部链接交系统浏览器（`setWindowOpenHandler` deny + `shell.openExternal`）。

## Notes

- 本机开发沙箱（bwrap 只读容器）限制：官方 Electron 二进制无法启动 GUI（SIGTRAP，与代码无关）；`/tmp` 不跨命令持久；`rm` 走回收站会报只读，删文件用 `find -delete`；打包工具已缓存于 `~/.cache/electron-builder`（沙箱内可直接 `npm run build:linux` 验证）。
- npm 安装需 `npm install-scripts approve` 批准 install scripts（已批准 esbuild、electron-winstaller）。
