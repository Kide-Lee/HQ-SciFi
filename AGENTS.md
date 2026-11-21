# hqsf-client（黄芪饮片桌面客户端）

荒启科幻桌面客户端，为 [荒启科幻](https://www.huangqisf.com/) 提供 写作-阅读-评审 一站式方案。产品与技术设计见 `doc/design.md`，荒启 API 接口定义见 `api.config.example.json`（真实配置 `api.config.json` 本地持有，不入库）。
> 文档归档：除 `README.md` 与 `AGENTS.md` 外的 md 文档（产品与技术设计 `doc/design.md`）统一存放于 `doc/` 目录；荒启 API 调研文档与接口配置不入库（见 `.gitignore`）。

## Project

- **v2.0 起技术栈**：**Tauri 2.12 + 后端 100% Rust**（`crates/hqsf-core`）+ React 19 + TypeScript + Vite 7 + Zustand 5；本地库 `rusqlite`（SQLite，bundled）；编辑器 Milkdown v7/ProseMirror + CodeMirror 6；markdown 渲染为 Rust `comrak` + QuickJS 内嵌 KaTeX/turndown（与 1.x 逐字节对等）；图标 lucide-react。
- **迁移期双轨**：`src/main/**` 是 1.x 的 Electron 主进程，**只作为行为参照与回滚路径**，不再新增功能；新功能一律写 Rust（`crates/hqsf-core`）。渲染层 `src/renderer/**` 是共享的，业务代码零改动。
- 入口：Tauri 壳 `src-tauri/src/lib.rs`（`run()`）；渲染层入口 `src/renderer/src/main.tsx`；桥接层 `src/bridge/`（暴露与 1.x 同形的 `window.hqsf`）。
- 迁移文档：`doc/design/Tauri迁移计划.md`（计划与决策）、`Tauri命令契约.md`（85 通道冻结契约）、`Rust实现约定.md`（内核编码约定与文件所有权）、`Tauri迁移验收.md`（验证记录与未验证项）。

## Commands

### Rust 内核（本机可跑）

```bash
export CARGO_HOME=$PWD/.cargo-home   # 本机 ~/.cargo 只读，必须指向仓内
cargo test -q -p hqsf-core --lib      # 521 个测试
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
cargo run -q -p hqsf-bindings         # 重新生成 src/shared/generated/*.ts
cargo run -q -p hqsf-bindings -- --check   # 校验绑定漂移（CI 门禁）
```

### 前端 / 壳层

- `npm run typecheck` — 渲染层（`tsconfig.web.json`）+ Electron 遗留主进程（`tsconfig.node.json`）
- `npm run build` — electron-vite 构建到 `out/`（`out/renderer` 即 Tauri 的 `frontendDist`）
- `node scripts/gen-markdown-corpus.mjs` — 重生成 markdown 金标准语料（直接 import 1.x 真实现，幂等）
- `npm run dev` / `npm run dev:test` — Electron 开发模式（迁移期回滚路径；`HQSF_TEST=1` 隔离数据目录）
- `npm run build:linux` / `build:win` / `build:mac` — **1.x Electron 出包**，迁移期保留；Tauri 出包见 `.github/workflows/release.yml`（tag `v*` 触发三平台）
- `src-tauri` 本机无法编译（缺 pkg-config / WebKitGTK）：`node scripts/gen-tauri-commands.mjs --report|--write|--verify` 可在无编辑器环境下生成/校验 85 命令 dispatch，编译校验交给 CI 的 `shell` job。

## Architecture

### Rust 内核 `crates/hqsf-core`（26k 行，零 tauri 依赖）

- `adapters/` — 上游字段规整（user/read/review/comment/search/notify/browse/interact/chat/sync/agreement/media/docs）
- `domain/` — 纯规则与判定（四态、匿名化、评分可见性、JS 语义工具、`js_len` UTF-16 长度）
- `services/` — 用例编排（auth/updater/docs/settings/sync/net）；`services/net.rs` 是唯一的 HTTP + 会话入口
- `commands/` — 85 条 IPC 入口，一通道一函数；`commands/registry.rs` 是命令注册表（与 `src-tauri/testdata/contracts/commands.json` 双向断言）
- `infra/` — db（rusqlite）/ fs / net（api+config）/ session / settings / updater / media（图片缓存）/ markdown（comrak+QuickJS）/ migrate / sandbox
- 端口在 `ports.rs`（FileStore/SecretStore/HttpTransport/EventSink/Clock/Platform/AppPaths），装配在 `ctx.rs` 的 `CoreCtx`；**内核不得直接碰 `std::fs`/`reqwest`/`keyring`/`tauri`/`std::env`**
- 测试工具在 `testkit.rs`（`Harness` + 内存端口 + 脚本化 HTTP）

### 壳层 `src-tauri`（平台层）

窗口/单实例/`hqsf-img` 协议/keyring/updater/剪贴板/对话框/Launcher/WindowOps 的真实实现与启动编排；85 条命令 dispatch 由 `scripts/gen-tauri-commands.mjs` 从契约生成（`src/commands_generated.rs`，gitignored）。

### 前端

- `src/bridge/` — 传输门面：`index.ts`（85 方法）、`invoke.ts`（`__TAURI_INTERNALS__.invoke` 包装，不依赖 `@tauri-apps/api`）、`protocol.ts`（`hqsf-img` 平台化）
- `src/shared/` — `generated/`（specta 生成的类型与命令清单，**勿手改**）、`contracts/`（IPC 契约与 `HqsfApi`）、`domain/`（1.x 遗留类型，新类型应定义在 Rust 侧由 specta 生成）
- `src/renderer/` — React UI：`features/<feature>/`、`components/`、`lib/`、`stores/`（Zustand）
- `src/main/`、`src/preload/` — 1.x Electron 主进程与 preload（迁移期参照，勿新增）

## Conventions

- 如果认为用户的设计有模糊之处，应询问用户。
- **IPC 返回约定**：成功 `{ok:true, data:业务载荷}`，失败 `{ok:false, error:string}`；`ping`/`getAppInfo` 是裸值接口（1.x 遗留，已保持）。
- **一通道一命令**：不允许通用转发/代理命令；通道名 → Rust 命令名规则 `hqsf:x-y` → `x_y`（唯一例外 `media:pick-upload-image` → `pick_upload_image`）。
- **类型单一来源**：跨端类型定义在 Rust（`#[derive(specta::Type)]` + `#[serde(rename_all="camelCase")]`），由 `cargo run -p hqsf-bindings` 生成 `src/shared/generated/types.ts`；改 Rust 类型后必须重生成并提交，否则 CI 漂移门禁失败。
- **错误文案逐字照抄 1.x**：用户可见的失败文案是行为契约的一部分（契约文档里有原文）；新增错误走 `CoreError`，不要临时 `format!` 编新文案。
- **路径安全**：一切路径先过 `infra::sandbox::assert_inside`（词法归一 + 存在时 canonicalize 挡 symlink），根为 docs root。
- **token 安全**：token 只进 `SecretStore`（键 `hqsf.session`，值是 JSON），`window.hqsf` 不下发，`SecretData.token` 标 `skip_serializing`。
- **markdown 不许另起实现**：后端 `md_to_html`/`html_to_md`/`frontmatter` 只在 `infra::markdown`（金标准语料 143+22+22 条，逐字节对等）；渲染层预览用 `lib/mdPreview.ts` 的 markdown-it 版。两侧不得互相替代，也不得为了省事改成「渲染层生成 HTML 再传后端」。
- **`src/bridge` 无业务规则**：只做调用转发、参数整形、错误转 `Error`；任何判定/规整/合并逻辑必须落在 Rust。
- **右键菜单**：统一走 `components/menu/` 的 `useContextMenu()` + App 根部唯一的 `<ContextMenuHost />`；菜单只放没有按钮入口的操作。Host 会统一追加「刷新 + 开发者工具」，调用方不要自己加。复制一律走 `window.hqsf.copyText`。
- 渲染层状态用 Zustand；UI 文案简体中文。
- **无边框窗口拖拽**：`-webkit-app-region` 只在 Electron 生效，WebKit 下无效；Tauri 由 `src/bridge/drag.ts` 兜底——可拖拽区根节点必须带 `data-hqsf-drag-region`（现为顶栏、左栏、登录/协议页拖拽条），拖拽区内的可点击元素用原生 `button/input/a` 或标 `data-hqsf-no-drag`（如左栏拖宽分隔条）。新增「拖拽区」时两处都要补：根节点属性 + 确认子元素是交互元素或带 no-drag 标记。
- **内核编码约定**详见 `doc/design/Rust实现约定.md`（含文件所有权、端口使用、测试写法）；多 agent 并行时严格遵守其中的单写者清单。

## Notes

- **本机沙箱限制**：`~` 根只读 → `~/.cargo`、`~/.cache` 不可写，cargo 必须 `export CARGO_HOME=$PWD/.cargo-home`；本机**没有 npm 可执行文件**（只有 `~/.local/bin/pnpm`），脚本用 `node_modules/.bin/*`；`/tmp` 不跨命令持久；删文件用 `find -delete`（`rm` 走回收站会报只读）。
- **本机没有 pkg-config / WebKitGTK**，`src-tauri` 编译不了；因此 `src-tauri` 的改动只能靠静态自查 + CI 的 `shell` job，务必：`node --check` 脚本、`node scripts/gen-tauri-commands.mjs --verify`、`prepare-resources.mjs --check`。
- **金标准语料的生成方式**：`scripts/gen-markdown-corpus.mjs` 直接 import 1.x 真实现（`src/main/infra/media/md2html.ts`、`src/shared/*`、`node_modules/turndown`）产出 JSONL 并冻结入库；不要手写期望值。comrak / KaTeX / turndown 升级后必须重跑语料（`infra/markdown/tests.rs` 会逐条打印首差字节）。
- **KaTeX/turndown 资产同版本约束**：`crates/hqsf-core/assets/katex.min.js` 必须与 `node_modules/katex` 同版本（现 0.18.4），升级前端 KaTeX 时同步替换该资产，否则公式 HTML 与线上不再逐字节一致。
- **1.x Electron 遗留坑**（迁移期保留，出问题时参考）：better-sqlite3 需 `electron-builder install-app-deps` 重建（锁 v12.11.1，ABI 132）；Linux 交叉打包 Windows 必须用 `scripts/win-prebuild.mjs` 换 prebuild，否则 Windows 上静默无窗口；`app.whenReady()` 内任一步抛错都是 unhandled rejection（进程无窗口无诊断）。
- **启动冒烟**：CI `smoke` job 用 `xvfb-run + dbus-run-session` 真启动 Tauri 应用，判定「进程存活 + `xdotool` 按标题找到窗口 + 数据目录出现 `hqsf.db`」；本地跑：`xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bash scripts/smoke-tauri.sh <可执行文件>`。失败详情看 `smoke-logs` 分支（`git fetch --force origin smoke-logs && git show origin/smoke-logs:README.md`）。
- **出包与打包验证**：`release.yml` 由 tag `v*`（正式、建 draft Release）、分支 `build-only`（只构建+上传产物，不打 tag）、手动 dispatch（`version` 必填、`dry_run`）触发；三平台构建结论与产物体积回写到 `release-status` 分支（`git ls-remote origin release-status` / `git fetch --force origin release-status && git show origin/release-status:README.md` 查看，勿烧 GitHub API 限额）。用 `cargo install tauri-cli` + `cargo tauri build`，不要引入 `@tauri-apps/cli`（会破坏 `npm ci` 的 lock 一致性）。CI 出包用 `api.config.example.json` 兜底，**正式发布必须提供真实 `api.config.json`**。
- **CDP 调试**（1.x Electron 仍在时可用）：`HOME=<工作区>/node_modules/.dev-home node_modules/electron/dist/electron --inspect=9229 .`，再用项目 skill `cdp-debugging` 的客户端挂 `webContents.debugger` 做 DOM 断言；Tauri 侧 GUI 自动化需 `tauri-driver`（Linux WebKitWebDriver / Windows msedgedriver）。
- npm install-scripts 已批准：esbuild、electron-winstaller、electron、better-sqlite3@12.11.1。