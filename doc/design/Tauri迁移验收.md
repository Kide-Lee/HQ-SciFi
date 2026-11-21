# Tauri + 全 Rust 迁移验收记录

> 配套文档：[Tauri迁移计划.md](./Tauri迁移计划.md)（本文记录**执行结果**，计划变更以计划 §10/§11 为准）
> 基线：`hqsf-client` v1.2.13（Electron 34.5.8 + 主进程 TS）
> 目标：Tauri 2.12 + 后端 100% Rust（`crates/hqsf-core`），TS 只保留 UI 与传输门面
> 记录时间：2026-11-21

---

## 0. 一句话结论

**逻辑级迁移已完成**：85/85 条 IPC 通道在 Rust 侧有实现，521 个 Rust 测试全绿，markdown 渲染与 1.x **逐字节相等**（143/143 + 22/22 + 22/22），契约、绑定、类型三者有无漂移的自动门禁。

**产品级尚未验证**：本机没有 WebKitGTK / pkg-config，`src-tauri` 壳层无法编译，因此 GUI、中文输入法、媒体播放、安装包、真机数据迁移**全部待 CI 与真机**（见 §4）。

「完成」按两级定义：

| 级别 | 含义 | 当前 |
| --- | --- | --- |
| 逻辑级 | 内核可 `cargo test`、可 `clippy -D warnings`、契约/绑定/类型零漂移、markdown 零差异、85 条 dispatch 全量生成且契约仿真校验通过 | ✅ 达成 |
| 产品级 | 壳层可编译、三平台出包、GUI 与 1.x 行为对等、真机迁移成功 | ⏳ 待 CI / 真机 |

---

## 1. 交付物清单

### 1.1 Rust 内核（本机可编译可测）

| 路径 | 行数 | 说明 |
| --- | --- | --- |
| `crates/hqsf-core/src/` | 26,386 | adapters 7,400 / commands 4,479 / infra 8,424 / services 3,568 / domain 1,376 / 其余（ports/ctx/error/testkit/registry） |
| `crates/hqsf-bindings/src/main.rs` | 263 | 无头绑定生成器（98 个根类型 + 85 条命令） |
| `crates/hqsf-core/testdata/` | — | `markdown/corpus.jsonl`（143 条）、`frontmatter.jsonl`（22）、`html2md.jsonl`（22） |
| `crates/hqsf-core/assets/` | — | `katex.min.js`（272,179 B，0.18.4 MIT）、`turndown.js`（588 KB，7.2.4 MIT + domino） |

分层与 1.x 一一对应：`adapters`（字段规整）→ `domain`（纯规则）→ `services`（用例编排）→ `commands`（IPC 入口）→ `infra`（DB/FS/网络/会话/设置/媒体/markdown/迁移）。全部 IO 经 `ctx` 的端口（`FileStore`/`SecretStore`/`HttpTransport`/`EventSink`/`Clock`/`AppPaths`/`Platform`），内核零 `tauri` 依赖。

### 1.2 壳层（本机不可编译，代码已就位）

`src-tauri/`：`tauri.conf.json`（1200×800 / min 900×600 / `decorations:false` / `frontendDist:"../out/renderer"`）、`capabilities/default.json`（仅 `core:default` + `core:window:allow-start-dragging`）、`src/lib.rs`（启动编排 / 单实例 / `hqsf-img` 协议 / 窗口回调）、`src/dispatch.rs`、`src/runtime/*`（端口真实实现）、`scripts/gen-tauri-commands.mjs`（85 命令 dispatch 生成 + `--verify`）。

### 1.3 TS 传输门面（渲染层业务零改动）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `src/bridge/index.ts` | 260 | 85 方法门面，保留 `window.hqsf` 形状（81 顶层 + `windowControls` 4 嵌套 + 2 事件） |
| `src/bridge/invoke.ts` | 145 | `__TAURI_INTERNALS__.invoke` 薄包装（不引入 `@tauri-apps/api`） |
| `src/bridge/protocol.ts` | 45 | `hqsf-img` URL 平台化（Win/Android `http://hqsf-img.localhost`，其余 `hqsf-img://localhost`） |

改动面：`src/renderer/src/main.tsx`（+9 装桥）、`lib/sanitize.ts`（+9/−4 委托）、`lib/mdPreview.ts`（+9/−3）、`index.html`（`img-src` 加 `http://hqsf-img.localhost`）、`tsconfig.web.json`（+1 include）。**141 个渲染层业务文件 0 改动**。

### 1.4 生成物（纳入版本库，CI 校验漂移）

- `src/shared/generated/types.ts`（30,026 B，101 个 `export type`）
- `src/shared/generated/commands.ts`（9,308 B，85 条 `COMMAND_BY_CHANNEL` + `COMMAND_META`）
- `src-tauri/testdata/contracts/commands.json`（P1 冻结契约，85 通道 + 2 事件 + 10 异常）
- `src-tauri/testdata/contracts/commands.generated.json`

### 1.5 工程设施

- `.github/workflows/ci.yml`：`core`（fmt/clippy/test/bindings 漂移）、`tsc`（`npm run typecheck`）、`shell`（装 WebKitGTK 依赖后 `cargo check --manifest-path src-tauri/Cargo.toml`）
- `.github/workflows/release.yml`：tag `v*` → 三平台 `tauri-action` 出 deb/appimage/nsis/dmg（draft release）
- 文档：`doc/design/{Tauri迁移计划,Tauri命令契约,Rust实现约定,Tauri迁移验收}.md`、`doc/spike/{markdown,data-migration}.md`

---

## 2. 逻辑级验证证据（本机实测，可复现）

复现命令：

```bash
export CARGO_HOME=$PWD/.cargo-home   # 本机 ~/.cargo 只读
cargo test -q -p hqsf-core --lib
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
cargo run -q -p hqsf-bindings -- --check
node_modules/.bin/tsc --noEmit -p tsconfig.web.json
node_modules/.bin/tsc --noEmit -p tsconfig.node.json
```

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| `cargo test -p hqsf-core` | **521 passed / 0 failed / 0 ignored** | 55 个测试模块，含金标准对拍与表驱动用例 |
| `cargo clippy --all-targets -D warnings` | exit 0 | 无任何警告 |
| `cargo fmt --all --check` | exit 0 | |
| `hqsf-bindings --check` | `bindings 无漂移（85 条命令，98 个根类型）` | 改任一通道名/字段即失败 |
| `tsc -p tsconfig.web.json` / `node.json` | exit 0 | 渲染层与主进程两侧类型都过 |

### 2.1 契约对等（85/85）

三源交叉核对后冻结：`src/shared/contracts/ipc.ts` 的 `IPC_CHANNEL_BY_METHOD`（87 方法键 / 86 唯一通道名）、18 个 `src/main/ipc/*.handlers.ts` 的 85 处 `ipcMain.handle`、`src/preload/index.ts` 的 85 invoke + 2 on —— **集合双向全等，零缺失、零多余**。

两层自动门禁守着这条：

1. `commands::registry::registry_matches_the_frozen_snapshot_exactly` / `events_match_the_frozen_snapshot_exactly`：注册表与冻结 JSON 双向比对（通道名、Rust 命令名、模块、lane）。
2. `commands::registry::every_registered_command_has_an_implementation`：用 `include_str!` 扫 18 个 `commands/*.rs`，断言 85 条命令每条都有同名 `pub fn`（源码级，不需要壳层编译）。

### 2.2 markdown 金标准（SP-5 硬门禁，零例外）

| 项 | 语料 | 结果 |
| --- | --- | --- |
| `md_to_html` | 143 篇 / 1.4 MB（repo 真实 md 49 篇 + 手写边界 94 条） | **143/143 逐字节相等**（L0） |
| `frontmatter` 解析 | 22 条 | 22/22 与 TS 真实现逐字段相等 |
| `html_to_md`（turndown） | 22 条 | 22/22 逐字节相等 |

为什么这一项是硬门禁：`mdToHtml` 不是显示用途，而是**发布链路写进接口的 HTML**（`sync-service.ts:488`、`:563` 推送、`read.adapter.ts:1025` 摘要、`agreement.adapter.ts:45` 协议）。语料由 `scripts/gen-markdown-corpus.mjs` 直接 import 1.x 真实现生成（可重跑、幂等），Rust 侧 comrak + 三段预处理 + AST 手术 + linkify 移植 + 字节级后处理复刻，数学公式用 `rquickjs` 加载**同一份** `katex.min.js` 渲染，因此连 KaTeX 的 HTML 都逐字节一致。

### 2.3 数据迁移（SP-4）

`crates/hqsf-core/src/infra/migrate.rs`（1,630 行 / 10 测试）：源指纹 → 幂等判定 → staging 复制（含 `-wal`）→ `integrity_check` + `wal_checkpoint(TRUNCATE)` → 无 WAL 复核逐字节一致 → marker → rename 落位 → 落盘前复核源哈希。

本机真实数据实测：`~/.config/hqsf-client/hqsf.db` 1,683,456 B + `-wal` 601,552 B（146 帧未 checkpoint），`articles=0`、`read_cache=18`、`meta=0`；DDL 与 1.x **零列差异**；迁移后行数与指纹一致；二次运行幂等；损坏源 exit=1 且不留半成品。

**关键坑（已规避）**：只复制 `.db` 丢掉 `-wal` → `read_cache` 会从 18 行静默变 6 行（丢 151,793 B，且 `integrity_check` 仍报 ok）。

### 2.4 安全不变式

| 不变式 | 状态 |
| --- | --- |
| token 不出 Rust（只进 `SecretStore`，`SecretData.token` 标 `skip_serializing`） | ✅ |
| 无通用 `invoke` 代理，只有 85 条具名命令 | ✅ 契约与 dispatch 生成器双重约束 |
| 一切文件路径经 `assert_inside` | ✅（`infra::sandbox` + `infra::fs` 双实现，含 symlink 用例） |
| `open_external` 只放行 http(s) | ✅ 壳层 `Launcher` |
| 无远程脚本加载 / capabilities 最小集 | ✅ 仅 `core:default` + `start-dragging` |
| `src/bridge` 无业务规则 | ✅ 450 行纯传输 |

---

## 3. 异常与偏差处置

### 3.1 契约冻结发现的 10 个异常（A1–A10）

| 编号 | 异常 | 处置 |
| --- | --- | --- |
| A1 | `media:pick-upload-image` 是全表唯一非 `hqsf:` 前缀通道 | **保留原名**（渲染层零改动优先），生成器对其做命名例外 |
| A2 | `hqsf:update-state` 同时是 invoke 与事件 | 保留双语义：命令 `update_state` + 事件 `EVENT_UPDATE_STATE`；注册表 `EVENTS` 单列 |
| A3 | `fail('未登录')` 传字符串导致 `error: undefined` | **修正**为正常 `{ok:false,error:"未登录"}`（`check-forbidden`、`pick-upload-image`） |
| A4 | `hqsf:add-log` 无 try/catch，抛错会让 invoke reject | 双层语义：校验失败 `Err`、请求失败 `Ok(LogOpResult{ok:false,error})` |
| A5 | `hqsf:toggle-devtools` 无 try/catch | 归一为 `CoreResult<()>`，壳层转 `{ok:false,error}` |
| A6 | 计划写「84 条」，实测 85（漏计 `hqsf:show-message-box`） | 计划全文改为 85，注册表 `EXPECTED_INVOKE_TOTAL = 85` |
| A7 | 计划 §4.2 lane 标数与逐通道映射有差异 | 以 `commands.json` 的逐通道 `lane` 字段为准 |
| A8–A10 | 参数命名/信封差异等细节 | 逐条落入 `commands.json` 的 `anomalies` 字段并在契约文档标注 |

### 3.2 与 1.x 的有意偏差（全部有理由，随代码留注释）

| 领域 | 偏差 | 理由 |
| --- | --- | --- |
| 会话 | `keyring` 取代 Electron `safeStorage`；无 Linux `basic_text` 降级；`insecure` 恒 false；钥匙串不可用直接报错 | safeStorage 是 Electron 私有格式，Tauri 侧无法解密；显式失败好过静默降级 |
| 文件删除 | 走系统回收站（`launcher.trash`），不再直接删 | 用户可恢复；与 1.x `shell.trashItem` 对齐 |
| 目录排序 | 目录优先 + 忽略大小写字典序 | Rust 侧无 ICU，`localeCompare('zh')` 拼音序无法逐字复刻（TODO） |
| 文本长度 | 统一 UTF-16 码元计数（对齐 JS `.length`） | 评语 10 字/评论 2000 字门禁必须与前端一致 |
| 路径安全 | `dirRel` 额外 `assert_inside` | 1.x 此处有路径穿越口子，属加固 |
| 图片缓存 Content-Type | 固定 `application/octet-stream` | `download_image` 只回字节（TODO：回 `(bytes, ct)`） |
| 图片兜底文件名 | sha256 前 8 位（原 md5） | 避免引 md5 依赖，仅作文件名 |
| `htmlToMd` 引擎异常 | panic（1.x 抛异常） | 不静默写坏本地文件 |
| 通知/动态聚合 | 顺序请求（1.x 并发 4） | 结果一致，行为更可预测 |
| `uninstall` | 打开卸载器 + `app.exit(0)` | Tauri 无等价 API |
| 自动更新检查 | 定时器由壳层编排，内核只给纯函数 | 内核不持有运行时状态 |

---

## 4. 未验证项（必须 CI / 真机，按风险排序）

| # | 项 | 风险 | 为什么本机做不了 | 验证方式 |
| --- | --- | --- | --- | --- |
| 1 | **中文输入法 + contenteditable**（Milkdown/ProseMirror/CodeMirror） | 高 | 需 WebKitGTK 图形环境 | Linux 真机手测：拼音/五笔候选窗、长文本、撤销栈 |
| 2 | **媒体播放**（正文三个 iframe：music.163.com / i.y.qq.com / player.bilibili.com） | 高 | 需 GStreamer `gst-libav` | Linux deb 安装后放 H.264 视频；Windows 走 WebView2 |
| 3 | **壳层编译**（`src-tauri` 1,909 行 + 85 命令 dispatch） | 高 | 无 pkg-config / libwebkit2gtk-4.1-dev | CI `shell` job 的 `cargo check`；先跑 `gen-tauri-commands.mjs --verify` |
| 4 | 三平台出包与体积指标 | 中 | 交叉编译不可行 | `release.yml` 首次真跑，记录 §6.3 量化指标 |
| 5 | 真机数据迁移（含 146 帧 WAL 的真实库） | 中 | 需在真机 appData 上跑 | 装包后首次启动，核对 read_cache 18 行与文章数 |
| 6 | keyring 在 Linux（Secret Service）/ Windows（DPAPI）的行为 | 中 | 同上 | 登录→重启→会话恢复 |
| 7 | `executableName` 变化（1.x `huangqi-scifi` → Tauri `hq-scifi`） | 中 | 需真机 | 确认快捷方式/升级路径；必要时在 `tauri.conf.json` 显式指定 |
| 8 | 自定义 CSS/JS 注入的实际效果 | 中 | 需 GUI | 设置里写一段 CSS，确认 `insert_css` 的 `<style>` 生效且 reload 后重放 |
| 9 | Ctrl+F12 devtools（`__TAURI_INTERNALS__.invoke` 非公开 API） | 低 | 需 GUI | release 包用 `devtools` feature 版验证 |
| 10 | 中文排序拼音序 | 低 | 需 ICU | 与产品确认是否接受字典序 |
| 11 | **无边框窗口拖拽**（`-webkit-app-region` 在 WebKit 无效） | 中 | 需 GUI | Windows/Linux 装包后拖顶栏、拖左栏空白、双击最大化；见 §4.3 |

---

## 4.1 壳层集成的两个「只能靠推理发现」的坑（已修，记录备查）

本机编译不了 `src-tauri`，所以这两处在写代码时是「看起来对、跑起来必错」的：

1. **`#[tauri::command]` 的参数名大小写**
   实际读 `tauri-macros-2.5.0` 的 `src/command/wrapper.rs`：`argument_case` 默认值是 `ArgumentCase::Camel`，即 `dir_rel` 默认就去找 JS 对象的 `dirRel`。**结论：默认已是 camelCase**，桥接层与契约的 `dirRel/oldRel/newRel/reviewId/filePath/isDraft` 天然对得上。生成器仍然**显式**逐条写 `rename_all = "camelCase"`——不是修 bug，而是不依赖上游默认值（默认值一变就是 4 条通道静默失效）。
2. **结构体入参必须吃整个 payload**
   Tauri 按「声明参数名」去 JS 对象里取键。若生成 `args: ListReviewsArgs`，它就会去找 `args` 键，而桥接层发的是平铺对象（`{opts: …}`）→ 运行时 `invalid args`。修法：`WholePayload<T>` 实现 `tauri::ipc::CommandArg`，直接 `command.message.payload()` 反序列化整个 body。**32 条结构体入参通道**都依赖这一点。
   附带好处：3 条载荷里有 `type` 键的通道（`list-metas`/`add-log`/`set-review-attitude`）由内核 `#[serde(rename = "type")]` 还原，绕开了「Rust 形参不能叫 `type`」的问题。

这两条都进了 `gen-tauri-commands.mjs --verify` 的静态校验：每条命令必须带 `rename_all`；平铺命令逐位比对契约参数名；整包命令断言 `*Args` 的 serde wire 字段集合 ⊇ 契约参数名集合。

## 4.3 无边框窗口拖拽：从 CSS 私有属性改为 JS 端口调用

1.x 靠 Chromium 私有 CSS `-webkit-app-region: drag|no-drag`（`src/renderer/src/styles/index.css` 共 9 处）让无边框窗口可拖动。**这条声明在 WebKitGTK / WKWebView 里是无效属性**，而 `tauri.conf.json` 在 Windows/Linux 上是 `decorations:false`（自绘 36px 顶栏），照搬 CSS 会导致这两个平台**窗口完全拖不动**——一个容易漏掉的功能回归。

修法（保留 Electron 原行为，Tauri 补一层）：

- 渲染层三个「可拖拽区」根节点加 `data-hqsf-drag-region`：`features/navigation/TopBar.tsx` 的 `<header class="topbar">`、`features/navigation/Sidebar.tsx` 的 `<aside class="sidebar">`、`features/auth/{LoginView,FirstRunAgreement}.tsx` 的 `.window-drag-bar`；
- 新增 `src/bridge/drag.ts`：Tauri 环境下捕获阶段监听 `mousedown`，从 target 向上找 `data-hqsf-drag-region`，**中途碰到交互元素**（`button/input/textarea/select/a/[contenteditable]/[role=button]/[data-hqsf-no-drag]`）就放弃；命中则 `invoke('plugin:window|start_dragging')`；`event.detail === 2` 时改调 `window.hqsf.windowControls.toggleMaximize()`（等价 1.x 双击标题栏最大化）；
- 左栏拖宽分隔条 `.sidebar-resizer` 标 `data-hqsf-no-drag`（它自己有 mousedown 处理，不能被拖窗口抢走）；
- 不用 Tauri 内置的 `data-tauri-drag-region`：它的判定只看 **mousedown 目标元素本身**是否带属性，而顶栏标题、图标都是子元素（1.x 里点子元素也能拖），逐个子元素补属性会随 UI 改动失效。

对应权限：`capabilities/default.json` 的 `core:window:allow-start-dragging`（双击最大化走应用自己的 `hqsf:window-maximize-toggle`，不需要额外 window 权限）。

## 4.2 集成完成情况（第二轮）

| 项 | 状态 |
| --- | --- |
| 85 条 dispatch | ✅ 85/85 自动生成、MANUAL 0、`--verify` 通过（含漂移检测实测会拦） |
| 命令注册 | ✅ `register()` 静态 `generate_handler!`，无通用转发命令 |
| `hqsf-img` 协议 | ✅ 异步协议 → `media::shared().get_with_content_type`，404/403/502 分类，`no-store` + CORS |
| 启动数据迁移 | ✅ `Db::open` 之前调 `migrate_legacy_data`，`NoSource/AlreadyMigrated/DryRun` 静默、`Err` 走 `PendingStartupError` 弹框 |
| 设置即时生效 | ✅ `on_page_load(Finished)` 每次重放 zoom/css/js；**内核侧已修**「customCss 清空不生效」的残留（空串也调 `insert_css`，壳层语义=只清理），加了回归测试 |
| 更新状态 | ✅ `AppState.updater: Arc<UpdateStateStore>`，四条 `update-*` 共享 |

---

## 5. 回滚与共存

- **回滚**：迁移只**复制**不删除 Electron 数据（`migrate_legacy_data` 只读源、写 staging、rename 落位到新目录），旧 `~/.config/hqsf-client/` 保持原样，1.2.13 仍可直接运行。
- **共存**：Tauri 2.0.0 使用独立 appId 数据目录；首次启动检测到旧数据即迁移，`--force` 可重跑（源指纹变化才允许）。
- **双轨期**：`src/bridge` 保留 Electron 分支（`protocol.ts` 按 `window.hqsf` 是否存在分派），`npm run dev`（Electron）在迁移窗口期内仍可用。

---

## 6. 剩余工作

1. ✅ 壳层集成（dispatch / 协议 / 迁移 / 设置重放）——代码级完成。
2. ⏳ **CI 首次真跑**：`shell` job 的 `cargo check --manifest-path src-tauri/Cargo.toml` 是第一个真正的编译校验，重点看 CI 的 Top 5（`State<'_, AppState>` 生命周期、`WholePayload` 的 `CommandArg` 与 tauri 2.12 trait 是否完全对上、`generate_context!` 嵌入 `out/renderer`、异步协议 handler 的 `Send` 约束、capabilities 最小集是否够用）。
3. ⏳ 三平台真机验证（§4 列表），记录 §6.3 量化指标。
4. ⏳ 发布：`v2.0.0` tag → draft release → 对外；发布前必须在构建机提供真实 `api.config.json`（当前 `release.yml` 用 example 兜底，装出来会连示例地址）。
5. ⏳ 收尾清理：真机验证通过后删除 `src/main`/`src/preload`（1.x Electron 主进程）、`better-sqlite3` 依赖与 `electron-builder.yml`、`scripts/win-prebuild.mjs`。