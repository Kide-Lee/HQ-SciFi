# hqsf-client（黄芪饮片桌面客户端）

荒启科幻桌面客户端，为 [荒启科幻](https://www.huangqisf.com/) 提供 写作-阅读-评审 一站式方案。产品与技术设计见 `doc/design/简介.md`、`doc/design/产品定位与范围.md`，荒启 API 接口定义见 `api.config.example.json`（真实配置 `api.config.json` 本地持有，不入库）。
> 文档归档：散落的 md 文档统一放 `doc/`；1.x（Electron）时代的设计与计划已归档到 `doc/archive/1.x/`，仅作历史与行为参照，不再维护。

## Project

- **技术栈**：**Tauri 2.12 + 后端 100% Rust**（`crates/hqsf-core`）+ React 19 + TypeScript + Vite 7 + Zustand 5；本地库 `rusqlite`（SQLite，bundled）；编辑器 Milkdown v7/ProseMirror + CodeMirror 6；markdown 渲染为 Rust `comrak` + QuickJS 内嵌 KaTeX/turndown（与 1.x 逐字节对等）；图标 lucide-react。
- **1.x Electron 代码已彻底移除**（`src/main/**`、`src/preload/**`、electron-vite、electron-builder、better-sqlite3 及全部相关依赖与配置）。仓库只有一条产品线：Tauri。
- 入口：Tauri 壳 `src-tauri/src/lib.rs`（`run()`）；渲染层入口 `src/renderer/src/main.tsx`；桥接层 `src/bridge/`（暴露与 1.x 同形的 `window.hqsf`）。
- 迁移文档：`doc/design/Tauri迁移计划.md`（计划与决策）、`Tauri命令契约.md`（85 通道冻结契约）、`Rust实现约定.md`（内核编码约定与文件所有权）、`Tauri迁移验收.md`（验证记录与未验证项）、`真机验证清单.md`（装包后逐项核对的检查清单）。

## Commands

### 编译前自检（不编译 Rust 壳，本机全绿约 6 秒）

```bash
export CARGO_HOME=$PWD/.cargo-home   # 本机 ~/.cargo 只读，必须指向仓内
cargo test -q -p hqsf-core --lib          # 526 个测试
cargo clippy -q --all-targets -- -D warnings
cargo fmt --all -- --check
cargo run -q -p hqsf-bindings -- --check  # 绑定漂移（CI 门禁）
node src-tauri/scripts/gen-tauri-commands.mjs --verify   # 85/85 dispatch 契约仿真
node src-tauri/scripts/prepare-resources.mjs --check     # 打包资源就绪
node_modules/.bin/tsc -p tsconfig.web.json                # 渲染层类型
node_modules/.bin/vite build --config vite.web.config.ts  # 渲染层构建（out/web）
```

这些挡不住三件事：壳层自己能否编译（CI `shell` job）、WebKit 运行时行为（CI `smoke` job）、安装包内容（`release.yml` 的产物自检）。

### 命令

- `npm run typecheck` — 渲染层类型（`tsconfig.web.json`）
- `npm run build:web` — 纯 Vite 构建渲染层到 `out/web`（Tauri 的 `frontendDist`）
- `node scripts/gen-markdown-corpus.mjs` — 重生成 markdown 金标准语料（import `scripts/markdown-oracle/` 的 1.x 冻结实现，幂等）
- `node scripts/verify-bundles.mjs [--expect-version X]` — 校验安装包内容
- 出包：`.github/workflows/release.yml`（tag `v*` 正式 / 分支 `build-only` 只构建 / 手动 dispatch）
- `src-tauri` 本机无法编译（缺 pkg-config / WebKitGTK）：`node src-tauri/scripts/gen-tauri-commands.mjs --report|--write|--verify` 可在无 WebKit 环境生成/校验 85 命令 dispatch，编译校验交给 CI 的 `shell` job。

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

- `src/bridge/` — 传输门面：`index.ts`（85 方法）、`invoke.ts`（`__TAURI_INTERNALS__.invoke` 包装，不依赖 `@tauri-apps/api`）、`protocol.ts`（`hqsf-img` 平台化）、`drag.ts`（无边框窗口拖拽）
- `src/shared/` — `generated/`（specta 生成的类型与命令清单，**勿手改**）、`contracts/`（IPC 契约与 `HqsfApi`）、`domain/` 与 `types.ts`（渲染层仍在用的载荷类型层；新类型应定义在 Rust 侧由 specta 生成）
- `src/renderer/` — React UI：`features/<feature>/`、`components/`、`lib/`、`stores/`（Zustand）

## Conventions

- 如果认为用户的设计有模糊之处，应询问用户。
- **IPC 返回约定**：成功 `{ok:true, data:业务载荷}`，失败 `{ok:false, error:string}`；`ping`/`getAppInfo` 是裸值接口（1.x 遗留，已保持）。
- **一通道一命令**：不允许通用转发/代理命令；通道名 → Rust 命令名规则 `hqsf:x-y` → `x_y`（唯一例外 `media:pick-upload-image` → `pick_upload_image`）。
- **类型单一来源**：跨端类型定义在 Rust（`#[derive(specta::Type)]` + `#[serde(rename_all="camelCase")]`），由 `cargo run -p hqsf-bindings` 生成 `src/shared/generated/types.ts`；改 Rust 类型后必须重生成并提交，否则 CI 漂移门禁失败。
- **错误文案是契约**：用户可见的失败文案沿用 1.x 原文（契约文档里有原文）；新增错误走 `CoreError`，不要临时 `format!` 编新文案。
- **路径安全**：一切路径先过 `infra::sandbox::assert_inside`（词法归一 + 存在时 canonicalize 挡 symlink），根为 docs root。
- **token 安全**：token 只进 `SecretStore`（键 `hqsf.session`，值是 JSON），`window.hqsf` 不下发，`SecretData.token` 标 `skip_serializing`。
- **markdown 不许另起实现**：后端 `md_to_html`/`html_to_md`/`frontmatter` 只在 `infra::markdown`（金标准语料 127+22+22 条，逐字节对等）；渲染层预览用 `lib/mdPreview.ts` 的 markdown-it 版。两侧不得互相替代，也不得为了省事改成「渲染层生成 HTML 再传后端」。
- **`src/bridge` 无业务规则**：只做调用转发、参数整形、错误转 `Error`；任何判定/规整/合并逻辑必须落在 Rust。
- **右键菜单**：统一走 `components/menu/` 的 `useContextMenu()` + App 根部唯一的 `<ContextMenuHost />`；菜单只放没有按钮入口的操作。Host 会统一追加「刷新 + 开发者工具」，调用方不要自己加。复制一律走 `window.hqsf.copyText`。
- 渲染层状态用 Zustand；UI 文案简体中文。
- **无边框窗口拖拽**：`-webkit-app-region` 只在 Electron 生效，WebKit 下无效；Tauri 由 `src/bridge/drag.ts` 兜底——可拖拽区根节点必须带 `data-hqsf-drag-region`（现为顶栏、左栏、登录/协议页拖拽条），拖拽区内的可点击元素用原生 `button/input/a` 或标 `data-hqsf-no-drag`（如左栏拖宽分隔条）。新增「拖拽区」时两处都要补：根节点属性 + 确认子元素是交互元素或带 no-drag 标记。
- **远程图片一律走图片缓存协议**：`<img src={...}>`、`style={{backgroundImage:url(...)}}`、正文 HTML 里的图片都必须经 `lib/sanitize.ts` 的 `cachedImageUrl()`（内部是 `bridge/protocol.ts` 的 `imageCacheUrl`，把 https 换成 `hqsf-img` 协议，非 http(s) 原样返回、幂等）。直接写 `src={远端url}` 在 Tauri 的 WebView 里拿不到图（v2.0.14 的推荐页轮播封面、左下角用户头像就是这么丢的），也没有离线缓存。
- **内核编码约定**详见 `doc/design/Rust实现约定.md`（含文件所有权、端口使用、测试写法）；多 agent 并行时严格遵守其中的单写者清单。

- **内嵌媒体必须留在应用内**：阅读正文里的播放器是 `<iframe>`（网易云 / QQ 音乐 / B 站嵌入页），壳层 `src-tauri/src/lib.rs` 的 `on_navigation` 用 `hqsf_core::domain::embed::is_embedded_media_url` 放行这三个端点。原因是 wry 的 `decide-policy`（`PolicyDecisionType::NavigationAction`）**不区分主框架与子框架**，子框架导航也会问一次；一律拒绝就会得到「一块透明空白」，并且会把播放页弹到系统浏览器。新增播放器来源时同时改 `crates/hqsf-core/src/domain/embed.rs` 的白名单与 `src/renderer/src/lib/sanitize.ts` 的 `playerFromUrl`。

## Notes

- **本机沙箱限制**：`~` 根只读 → `~/.cargo`、`~/.cache` 不可写，cargo 必须 `export CARGO_HOME=$PWD/.cargo-home`；本机**没有全局 npm**（需要时用 `COREPACK_HOME=$PWD/.corepack corepack npm …`；脚本直接用 `node_modules/.bin/*`）；`/tmp` 不跨命令持久；删文件用 `find -delete`（`rm` 走回收站会报只读）。
- **本机没有 pkg-config / WebKitGTK**，`src-tauri` 编译不了；因此 `src-tauri` 的改动只能靠静态自查 + CI 的 `shell` job，务必：`node --check` 脚本、`gen-tauri-commands.mjs --verify`、`prepare-resources.mjs --check`。
- **金标准语料的生成方式**：`scripts/gen-markdown-corpus.mjs` import `scripts/markdown-oracle/md2html.ts`（从 1.x 冻结而来的真实现，**不要修改**）+ `src/shared/*` + `node_modules/turndown` 产出 JSONL 并冻结入库；不要手写期望值。comrak / KaTeX / turndown 升级后必须重跑语料（`infra/markdown/tests.rs` 会逐条打印首差字节）。
- **KaTeX/turndown 资产同版本约束**：`crates/hqsf-core/assets/katex.min.js` 必须与 `node_modules/katex` 同版本（现 0.18.4），升级前端 KaTeX 时同步替换该资产，否则公式 HTML 与线上不再逐字节一致。
- **依赖与 lock**：本机无全局 npm 时用 corepack 版 npm 维护 `package-lock.json`；**不要删掉 lock 从零解析**（会撞上某个依赖的 `workspace:*` 协议直接失败），用 `npm install --package-lock-only` 增量更新。
- **启动冒烟**：CI `smoke` job 用 `xvfb-run + dbus-run-session` 真启动 Tauri 应用，判定「进程存活 + `xdotool` 按标题找到窗口 + 数据目录出现 `hqsf.db` + 截图非白屏」；本地跑：`xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bash scripts/smoke-tauri.sh <可执行文件>`。失败详情看 `smoke-logs` 分支（`git fetch --force origin smoke-logs && git show origin/smoke-logs:README.md`）。
- **产物自检**：`node scripts/verify-bundles.mjs [--expect-version X]` 检查安装包内容——deb 的 Version/Depends（必须 webkit2gtk-4.1）/包内资源、NSIS 的 ProductVersion、dmg 的 CFBundleIdentifier/版本/资源；`release.yml` 每个平台构建后自动跑，打 tag 时还会校验 tag 号与 `tauri.conf.json` 的 `version` 一致。新增打包资源时同步改脚本里的 `RESOURCES`。
- **API 配置来源**：运行期先读 `<data_dir>/api.config.json`（用户/运维可写，用于把安装包指向另一套后端），再读包内 `resource_dir/api.config.json`；CI 出包优先用仓库 secret **`HQSF_API_CONFIG_B64`**（本地 `api.config.json` 的 base64，`base64 -w0 api.config.json` 得到），没有才退回示例配置并告警。
- **出包与打包验证**：细节与全部已知坑见 skill `.dsh/skills/release-packaging/`（`SKILL.md` + `scripts/read-status.sh`）。速记：`release.yml` 由 tag `v*`（正式、建 draft Release）、分支 `build-only`（只构建+上传产物，不打 tag）、手动 dispatch（`version` 必填、`dry_run`）触发；结论回写到 `ci-status` / `release-status` / `release-logs` / `ci-logs` / `smoke-logs` 分支，用 `bash .dsh/skills/release-packaging/scripts/read-status.sh` 读（勿烧 GitHub API 限额、`raw.githubusercontent.com` 本机不可达）。用 `cargo install tauri-cli` + `cargo tauri build`，不要引入 `@tauri-apps/cli`（会破坏 `npm ci` 的 lock 一致性）。CI 出包用 `api.config.example.json` 兜底，**正式发布必须提供真实 `api.config.json`**（secret `HQSF_API_CONFIG_B64`）。