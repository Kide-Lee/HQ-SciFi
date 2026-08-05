# 荒启科幻桌面客户端（hqsf-client）

[荒启科幻](https://www.huangqisf.com/h5/#/) 的电脑客户端，写作-阅读-评审一站式方案。设计文档见 [design.md](design.md)，荒启 API 调查报告见 [api-research.md](api-research.md)。

## 技术栈

Electron 34 + React 19 + TypeScript + Vite 7（electron-vite 5）+ CodeMirror 6（M1 引入）+ Zustand + electron-builder 26。

## 目录结构

```
src/
├─ main/          # 主进程：窗口、IPC、荒启 API 网络（net.fetch）、SQLite 索引、会话、同步引擎
├─ preload/       # contextBridge 白名单 API（window.hqsf，token 不经过本层）
├─ shared/        # 三端共享类型（单一来源）
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

- **安全**：渲染层 `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，仅经 `window.hqsf` 白名单 IPC 与主进程通信；网络请求统一在主进程（`net.fetch`，规避 CORS）；**token 只存在主进程**（safeStorage 加密落盘），`window.hqsf` 不下发 token；本地文件读写限定在存档根目录内（resolve + realpath 双重防穿越）。
- **荒启 API**：主进程 `src/main/net/api.ts` 封装统一请求（`{code,msg,data,total}` 约定，`searchParams`/`params` 参数规范）；业务能力（登录/同步/文件/索引）经专用 IPC handler 暴露，不开放通用代理。
- **本地索引**：better-sqlite3（`src/main/db.ts`，存文章元数据/状态，正文始终是磁盘 md 文件）；正文转换 markdown-it（md→HTML，上传）与 turndown（HTML→md，拉回），见 `src/main/md2html.ts` / `src/main/sync.ts`。
- **M1 状态**：登录（账号密码/手机验证码）+ 会话持久化 + 草稿箱拉取/增量同步 + CodeMirror 6 本地编辑 + 同步到草稿/发布 + 四态展示已实现（代码完成，桌面环境验证待做）。

## 状态

**M0（脚手架）已交付**：三端骨架（main/preload/renderer）、安全窗口（contextIsolation + sandbox + CSP 基础版）、IPC 白名单 API（`window.hqsf`）、荒启 API 网络代理（`net.fetch`）、左侧栏+主界面 UI 骨架；`npm run typecheck` 与 `npm run build` 均通过。

**M0 收尾验证清单（需在正常桌面环境执行，沙箱内无法完成）**：

1. **GUI 运行验证**：`npm run dev`
   - 预期：窗口「荒启科幻」出现；左侧栏五个栏目（写作/推荐/连载/活动/作品库）可切换，文件树随栏目变化；主界面右下角「连通性自检（IPC + 荒启 API）」按钮点击后显示 `IPC: pong ✓ · 荒启 API 连通（…）✓`。
   - 已知：开发沙箱（bwrap 只读容器）中官方 Electron 二进制在 Chromium 初始化时 SIGTRAP，与项目代码无关；`electron-vite dev` 的 vite 构建与 dev server 部分已在本沙箱验证正常。
2. **Linux 安装包**：`npm run build:linux`（产出 `dist/*.deb` 与 `dist/*.AppImage`）
   - 网络要求：electron-builder 首次运行需从 GitHub 下载 fpm/AppImage 工具；若不可达可设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（注意：该镜像对 fpm 等个别文件 302 回源 GitHub，可能仍超时）。
3. **Windows 安装包**：`npm run build:win`（产出 `dist/*.exe` NSIS 安装包；跨平台打 NSIS 可用，但如需代码签名/图标嵌入建议在 Windows 上执行）
   - 预期：deb/AppImage/NSIS 均可安装启动，AppImage 可直接运行。

完成验证后，将结果与安装包路径回填到本文件「状态」小节，并把 design.md M0 行状态更新为最终交付。

**M1 内容（已实现，代码完成）**：登录与会话持久化、SQLite 索引（better-sqlite3）、CodeMirror 6 编辑器、草稿同步与发布（对接荒启 API，见 api-research.md）。

**M1 验证清单（需正常桌面环境 + 真实账号）**：

1. `npm run dev` → 登录页（账号密码 / 手机验证码）→ 登录后侧栏显示用户卡与「⇅ 同步」；首次同步拉取草稿箱到本地存档目录（`~/文档/荒启科幻/草稿`）。
2. 本地新建草稿 → CodeMirror 编辑（Ctrl+S / 防抖自动保存）→ 「同步到草稿」→ 侧栏「草稿」出现该文章；修改后再同步为覆盖更新（contentsUpdate）。
3. 「发布」→ 侧栏「待审核」出现该文章；荒启审核通过后再次「⇅ 同步」→ 移至「已发布」；被拒则归入「已拒绝」。
4. 远端草稿被修改且本地也改过时：拉取保留本地（冲突计数），需人工处理。
5. 退出登录 → 重启免登录（会话 safeStorage 加密恢复）；Linux 无 keyring 时提示凭据加密降级。
6. 若登录响应结构/接口参数与 api-research.md 推断不一致（如 `contentsAdd` 返回的 cid 字段、`modified` 时间戳单位），以实测为准修正 `src/main/auth.ts` / `src/main/sync.ts` 的容错分支。

完成验证后，将结果回填到本文件「状态」小节，并把 design.md M1 行状态更新为最终交付。

**M2 内容（已实现，代码完成）**：阅读视图（远端文章列表/详情/HTML 正文净化渲染）+ 评审面板（官方五维评审体系：设定/文笔/人物/情节/思想性，评分+评语+综合+态度表态，提交 addReview/editReview）。入口：写作树四态文章点击直接阅读；作品库分类（metasList 动态取 mid）→ 文章列表 → 阅读/评审。接口参数已从官方 h5 前端包静态核对（见 api-research.md §10）。

**M2 验证清单（需正常桌面环境 + 真实账号）**：

1. 侧栏「已发布 / 待审核 / 已拒绝」点击文章 → 主区显示阅读视图（标题/作者/字数/阅读/赞/评分/时间 + 净化后的 HTML 正文）；「← 返回列表」可退回。
2. 侧栏「作品库」→ 任一分类 → 文章列表加载（默认按时间；切换 评分/点赞/评论/阅读 排序生效且保持分类过滤）→ 点击他人文章进入阅读。
3. 阅读他人文章 → 「✎ 评审这篇文章」→ 右侧评审面板：展示已有评审列表（评分/五维评语/态度按钮）；填写五维评语（各≥10字，不足有提示）+ 滑块评分 + 综合（选填）→ 「提交评审」→ 提示成功并刷新列表。
4. 本人文章不显示评审入口；未登录时 `getRemoteArticle`/`submitReview` 被主进程拦截并提示。
5. 正文安全：恶意 HTML（script/iframe/on* 事件/javascript: 链接/控制字符 URL）被 sanitizeHtml 白名单剥离，不执行、不弹窗。
6. 若 addReview 提交体/评分字段与官方实测不一致，以实测为准修正 `src/main/read.ts` 的 `reviewParams`。

完成验证后，将结果回填到本文件「状态」小节，并把 design.md M2 行状态更新为最终交付。

**M3 内容（已实现，代码完成）**：五大栏目全部接入真实数据。推荐 = 精选（choiceList，公开 62 篇、固定顺序）+ AI模型（gptList，8 个模型卡片）；连载 = 连载/合集（metasList type=serial/collection → selectContents）；活动 = 练笔期次（metasList type=active，mid 即 activeid → selectContents）；作品库沿用 M2。`selectContents` 是分类/连载/活动/tag 的统一取数接口（分页 + order 排序均生效）。ArticleListView 为通用文章列表载体（无限滚动 + 排序），GptListView 为 AI 模型卡片。

**M3 验证清单（需正常桌面环境 + 真实账号）**：

1. 侧栏「推荐」→「精选」：文章列表加载（无排序按钮，固定顺序，无限滚动分页 62 篇）；「AI模型」：8 张模型卡片（头像/名称/简介/来源）。
2. 侧栏「连载」→ 展开「连载 / 合集」两组 → 点击具体连载（如「大道之行也」）→ 该连载文章列表（排序按钮可用）→ 点击章节进入阅读视图。
3. 侧栏「活动」→ 展开「练笔活动」→ 点击具体期次（如「荒启科幻练笔第二十四期」）→ 该期参赛文章列表。
4. 侧栏「作品库」→ 分类列表（M2 回归，不受影响）。
5. 接口事实（已实测）：`metasList` 的 type 有 category(4)/active(27)/serial(16)/collection(25)/tag(19)；`selectContents` 按 mid 拉文章（活动/连载/合集/tag 通用）；`contentsList` 的 active 过滤不生效（total 恒为全站数），活动文章必须走 `selectContents`；`choiceList` 无 total、order 参数无效（固定顺序）。

完成验证后，将结果回填到本文件「状态」小节，并把 design.md M3 行状态更新为最终交付。

## 开发环境已知问题（沙箱）

本项目的开发/构建在受限沙箱中完成，以下结论为已排查确认的事实，供后续开发参考：

- **沙箱结构**：bwrap 只读容器——`/` 只读，仅 `/home/kidelee/Projects/hqsf`、`~/.cache`、`~/.npm` 可写；`/tmp` 不跨命令持久；`gio`/`rm` 走回收站会报「只读文件系统」（用 `find -delete`）；无 sudo。
- **官方 Electron 二进制无法启动 GUI**：任何版本（34/38/43）在 app 初始化阶段 SIGTRAP（`int3; ud2` 即 Chromium IMMEDIATE_CRASH；core 分析崩溃栈落在 Node/libuv 初始化区，si_code=SI_KERNEL；与项目代码无关，最小 `app.whenReady` 脚本同样崩溃）。系统预装的 VS Code（Electron 42）、QQ（Electron 40）为定制构建、可正常跑，不能替代调试。`--version`、`ELECTRON_RUN_AS_NODE=1`、Node 模式均正常。**GUI 验证只能在正常桌面环境做**。
- **GitHub 不可达**：`npm` 安装 electron 需镜像 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` + 手动 `node node_modules/electron/install.js`；electron-builder 工具下载需 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（electron 包可下，fpm/AppImage 工具镜像 302 回源仍超时，安装包构建受阻）。
- **npm 安全策略**：install scripts 需 `npm install-scripts approve <pkg>` 批准（本项目已批准 esbuild、electron-winstaller）。
- **版本锁定**：electron@34.5.8（与崩溃无关，纯粹当时的稳定选择）；`@vitejs/plugin-react@^5` + `vite@^7` + `electron-vite@^5` 是兼容组合（plugin-react 6 需 vite 8）；TypeScript 7 已移除 `baseUrl`，`paths` 需相对路径。
