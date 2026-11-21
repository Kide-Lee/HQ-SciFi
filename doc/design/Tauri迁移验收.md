# Tauri + 全 Rust 迁移验收记录

> 配套文档：[Tauri迁移计划.md](./Tauri迁移计划.md)（本文记录**执行结果**，计划变更以计划 §10/§11 为准）
> 基线：`hqsf-client` v1.2.13（Electron 34.5.8 + 主进程 TS）
> 目标：Tauri 2.12 + 后端 100% Rust（`crates/hqsf-core`），TS 只保留 UI 与传输门面
> 记录时间：2026-11-21

---

## 0. 一句话结论

**逻辑级迁移已完成**：85/85 条 IPC 通道在 Rust 侧有实现，526 个 Rust 测试全绿，markdown 渲染与 1.x **逐字节相等**（127/127 + 22/22 + 22/22），契约、绑定、类型三者有无漂移的自动门禁。

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
| `crates/hqsf-core/testdata/` | — | `markdown/corpus.jsonl`（127 条）、`frontmatter.jsonl`（22）、`html2md.jsonl`（22） |
| `crates/hqsf-core/assets/` | — | `katex.min.js`（272,179 B，0.18.4 MIT）、`turndown.js`（588 KB，7.2.4 MIT + domino） |

分层与 1.x 一一对应：`adapters`（字段规整）→ `domain`（纯规则）→ `services`（用例编排）→ `commands`（IPC 入口）→ `infra`（DB/FS/网络/会话/设置/媒体/markdown/迁移）。全部 IO 经 `ctx` 的端口（`FileStore`/`SecretStore`/`HttpTransport`/`EventSink`/`Clock`/`AppPaths`/`Platform`），内核零 `tauri` 依赖。

### 1.2 壳层（本机不可编译，代码已就位）

`src-tauri/`：`tauri.conf.json`（1200×800 / min 900×600 / `decorations:false` / `frontendDist:"../out/web"`）、`capabilities/default.json`（仅 `core:default` + `core:window:allow-start-dragging`）、`src/lib.rs`（启动编排 / 单实例 / `hqsf-img` 协议 / 窗口回调）、`src/dispatch.rs`、`src/runtime/*`（端口真实实现）、`scripts/gen-tauri-commands.mjs`（85 命令 dispatch 生成 + `--verify`）。

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
| `md_to_html` | 127 篇 / 1.0 MB（repo 真实 md 33 篇 + 手写边界 94 条） | **127/127 逐字节相等**（L0） |
| `frontmatter` 解析 | 22 条 | 22/22 与 TS 真实现逐字段相等 |
| `html_to_md`（turndown） | 22 条 | 22/22 逐字节相等 |

为什么这一项是硬门禁：`mdToHtml` 不是显示用途，而是**发布链路写进接口的 HTML**（`sync-service.ts:488`、`:563` 推送、`read.adapter.ts:1025` 摘要、`agreement.adapter.ts:45` 协议）。语料由 `scripts/gen-markdown-corpus.mjs` 直接 import 1.x 真实现生成（可重跑、幂等），Rust 侧 comrak + 三段预处理 + AST 手术 + linkify 移植 + 字节级后处理复刻，数学公式用 `rquickjs` 加载**同一份** `katex.min.js` 渲染，因此连 KaTeX 的 HTML 都逐字节一致。


### 2.2.1 语料对拍抓到的一处真实差异（已修）

重生成语料（143 → 127 条，旧语料里混入的 `.shell-tmp/` 临时解包 md 已消失）后，`md_to_html` 由「全过」变成 **126/127**：`doc/design/真机验证清单.md` 里一行同时写了 ```js（未配对的三反引号）和 `` `$x^2$` ``，期望是 `<code>$x^2$</code>`，实际渲染成了 KaTeX 公式。

- 根因（用 comrak 原始 AST 验证）：**遇到未配对的长反引号串后，comrak 不再把后续单反引号配对成 `Code` 节点**，`$x^2$` 落进 `Text` 就被行内公式预处理当成公式；markdown-it 只是把 ``` 当字面量，后面的单反引号照常配对。这不是理论差异——用户在自己的文档里写代码围栏示例时就会踩到，而这段 HTML 会经 `contentsAdd`/`contentsUpdate` 推给线上。
- 修法：新增 `crates/hqsf-core/src/infra/markdown/inline_code.rs`，在块级公式预处理之后、行内公式探测之前，按 markdown-it 的 `code_inline` 语义重新配对（闭合串搜索不看反斜杠转义，扫描位置的串才看），把**未配对**的反引号串整体换成私有区哨兵 `U+E004`（长度不变），渲染后由 `postprocess` 还原成字面量反引号。配对成功的串原样交给 comrak。
- 结果：语料 **127/127 L0 逐字节相等**（新增回归测试 `stray_backticks_do_not_swallow_later_inline_code`），内核 **526 个测试**全绿。

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
| 3 | ~~**壳层编译**~~ ✅ 已通过 | — | 无 pkg-config / libwebkit2gtk-4.1-dev | CI `shell` job `cargo check --all-targets` 于 run 44879836235（`990af64`）通过；见 §4.4 |
| 4 | ~~三平台出包与体积指标~~ ✅ 已通过 | — | 交叉编译不可行 | `release.yml` 已跑通四类产物并记录体积（§4.5） |
| 5 | 真机数据迁移（含 146 帧 WAL 的真实库） | 中 | 需在真机 appData 上跑 | 装包后首次启动，核对 read_cache 18 行与文章数 |
| 6 | keyring 在 Linux（Secret Service）/ Windows（DPAPI）的行为 | 中 | 同上 | 登录→重启→会话恢复 |
| 7 | ~~`executableName` 变化~~ ✅ 已处理 | — | — | `tauri.conf.json` 显式设 `mainBinaryName: "huangqi-scifi"`，与 1.x 可执行文件名一致（快捷方式/防火墙规则/任务管理器里的名字不乱）；包名与产物名仍是 `hq-scifi` |
| 8 | 自定义 CSS/JS 注入的实际效果 | 中 | 需 GUI | 设置里写一段 CSS，确认 `insert_css` 的 `<style>` 生效且 reload 后重放 |
| 9 | Ctrl+F12 devtools（`__TAURI_INTERNALS__.invoke` 非公开 API） | 低 | 需 GUI | release 包用 `devtools` feature 版验证 |
| 10 | 中文排序拼音序 | 低 | 需 ICU | 与产品确认是否接受字典序 |
| 11 | **无边框窗口拖拽**（`-webkit-app-region` 在 WebKit 无效） | 中 | 需 GUI | Windows/Linux 装包后拖顶栏、拖左栏空白、双击最大化；见 §4.3 |
| 12 | ~~**应用能否启动 / 建窗 / 初始化本地库**~~ ✅ 已通过 | — | 无 WebKitGTK | CI `smoke` job 在 Xvfb 里真跑起来：窗口标题命中、进程存活、`hqsf.db` 落盘（§4.6） |

---

## 4.1 壳层集成的两个「只能靠推理发现」的坑（已修，记录备查）

本机编译不了 `src-tauri`，所以这两处在写代码时是「看起来对、跑起来必错」的：

1. **`#[tauri::command]` 的参数名大小写**
   实际读 `tauri-macros-2.5.0` 的 `src/command/wrapper.rs`：`argument_case` 默认值是 `ArgumentCase::Camel`，即 `dir_rel` 默认就去找 JS 对象的 `dirRel`。**结论：默认已是 camelCase**，桥接层与契约的 `dirRel/oldRel/newRel/reviewId/filePath/isDraft` 天然对得上。生成器仍然**显式**逐条写 `rename_all = "camelCase"`——不是修 bug，而是不依赖上游默认值（默认值一变就是 4 条通道静默失效）。
2. **结构体入参必须吃整个 payload**
   Tauri 按「声明参数名」去 JS 对象里取键。若生成 `args: ListReviewsArgs`，它就会去找 `args` 键，而桥接层发的是平铺对象（`{opts: …}`）→ 运行时 `invalid args`。修法：`WholePayload<T>` 实现 `tauri::ipc::CommandArg`，直接 `command.message.payload()` 反序列化整个 body。**32 条结构体入参通道**都依赖这一点。
   附带好处：3 条载荷里有 `type` 键的通道（`list-metas`/`add-log`/`set-review-attitude`）由内核 `#[serde(rename = "type")]` 还原，绕开了「Rust 形参不能叫 `type`」的问题。

这两条都进了 `gen-tauri-commands.mjs --verify` 的静态校验：每条命令必须带 `rename_all`；平铺命令逐位比对契约参数名；整包命令断言 `*Args` 的 serde wire 字段集合 ⊇ 契约参数名集合。

## 4.1.1 CI 首轮暴露的两个真集成问题（本机静态检查抓不到）

本机跑不了 `cargo check`，`--verify` 也只看生成物与契约，所以下面两类问题只有 CI 能暴露：

1. **`bundle.resources` 在编译期校验源文件存在**
   `tauri.conf.json` 的三项资源映射指向 `src-tauri/resources/*`，而这三个文件是 `src-tauri/scripts/prepare-resources.mjs` 的生成物、被 `src-tauri/.gitignore` 忽略。CI 检出后目录是空的 → `tauri-build` 直接报 `resource path 'resources/agreement.md' doesn't exist`。
   修法：壳层 job 在 `cargo check` 之前先跑「准备打包资源」步——`api.config.json` 缺失时用 `api.config.example.json` 兜底（带 `::warning::`），再执行 `prepare-resources.mjs`。
2. **内核同名公开类型会静默选错模块**
   `adapters::read::ArticleMeta`（评论/评审脱敏用）与 `domain::sync::ArticleMeta`（发布表单元数据）同名。生成器按「类型名 → core 模块」建索引，重名时保留先扫到的那个 → `hqsf:sync-push` 的 dispatch 把 `domain::sync::ArticleMeta` 写成 `adapters::read::ArticleMeta`，编译期 `E0308`。
   修法：改名 `ArticleMetaBrief`（仅适配器内部使用）；生成器入口新增同名检查——发现两个 `pub struct/enum/type` 同名就直接 `exit 1` 并列出两个模块，避免同类问题再次以「CI 才报」的形式出现。

> 这两个问题都是「生成物 / 索引」类错误：单看任何一个文件都正确，只有把生成物放进干净检出环境、或让名字发生碰撞时才显形。后续新增类型或资源时优先复查这两条。

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

## 4.4 CI 真跑记录（壳层编译已在干净环境通过）

| 轮次 | commit | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | `67c3ff5` | shell ❌ | 拿不到日志（匿名 API 需 admin、`raw.githubusercontent.com` 不可达）→ 建 `ci-logs` 回写通道 |
| 2 | `6d6dd41` | shell ❌ | `resource path 'resources/agreement.md' doesn't exist`：`bundle.resources` 编译期校验 gitignored 生成物 |
| 3 | `74f27d4` | shell ❌ | 同一根因：修法步骤被误插进 `tsc` job（两个 runner 隔离，壳层 job 仍缺文件） |
| 4 | `20b006e` | shell ❌ | 资源已就绪；暴露 `E0308`：dispatch 把 `domain::sync::ArticleMeta` 写成同名 `adapters::read::ArticleMeta` |
| 5 | `990af64` | shell ✅ | 改名 `ArticleMetaBrief` + 生成器同名门禁；`cargo check --all-targets` 通过（run 44879836235），内核/TS job 同轮通过 |
| 6 | `33cbac7` | **三 job 全绿** | `core=success tsc=success shell=success`（由新增的 `status` job 回写 `ci-status` 分支确认） |
| 7 | `85df4b5` | **四门禁全绿** | 渲染层切纯 Vite（`out/web`）：`core/tsc/shell/smoke` 全绿；同轮三平台出包成功、AppImage 冒烟 `unique_colors=916` |
| 8 | `dc56405` | **四门禁全绿** | 冒烟截图等首帧（`sleep 2`）+ 白屏阈值 100 色；裸二进制与 AppImage 均 916 色，消除中间态抖动 |

`ci-status` 分支（汇总 job）与 `ci-logs` 分支（壳层 cargo 输出）的用途：本机沙箱只有 `api.github.com` 可达且有 60 次/小时匿名限额、Actions 日志接口需要 admin，所以 CI 把「三个 job 结论」推到 `ci-status`（commit message 即 `core=… tsc=… shell=…`）、把「cargo 输出尾部」推到 `ci-logs`，本地 `git ls-remote origin ci-status` / `git fetch --force origin ci-logs` 即可判断，不烧 API 限额。

## 4.5 三平台打包（P5）：流水线与实测体积

`release.yml` 现在承担出包，`ci.yml` 只做门禁。三条触发路径：

| 触发 | 行为 | 用途 |
| --- | --- | --- |
| push tag `v*` | 三平台构建 + 创建 **draft** Release | 正式发布 |
| push 分支 `build-only` | 只构建 + 上传 artifacts（14 天），不建 Release、不打 tag | 打包验证（本次用） |
| 手动 `workflow_dispatch` | `version` 必填；`dry_run=true` 时同 build-only | 指定版本重跑 |

关键实现选择：

- **用 `cargo install tauri-cli` + `cargo tauri build`，不用 `tauri-apps/tauri-action`**：本仓没有 `@tauri-apps/cli` 依赖，加它必须同步改 `package-lock.json`（本机无 npm，`npm ci` 会因不一致直接失败）；cargo 版 CLI 不碰前端依赖图。
- 构建前必须补两个 gitignored 生成物（与 §4.1.1 同一类坑）：`gen-tauri-commands.mjs --write` 与 `prepare-resources.mjs`——前者缺 `commands_generated.rs` 直接编译失败，后者缺 `resources/*` 会让 `bundle.resources` 在编译期报 `doesn't exist`。
- `api.config.json` 不入库：CI 用 `api.config.example.json` 兜底并 `::warning::`；**正式发布必须在构建机提供真实配置**，否则装出来的客户端连示例地址。
- 产物先 `upload-artifact`、再统计体积：首轮（`d05c3f2`）三平台**打包本身全部成功**，却被我写在后面的 `du` 统计步骤判成失败（步骤顺序问题），所以统计改成 `continue-on-error`。
- 结论回写 `release-status` 分支（含各平台产物大小）：Actions 日志接口要 admin、`raw.githubusercontent.com` 不可达，只有 git 协议稳定可读。

产物自检（`scripts/verify-bundles.mjs`，每个平台构建后立刻跑，run 44889638130 起生效）：

- Linux：deb 的 `Version` 前缀与 `tauri.conf.json` 一致、`Depends` 必须含 `webkit2gtk-4.1` 且不得出现 `4.0`、deb 内含三个打包资源与 `/bin/<mainBinaryName ?? productName>`（现为 `/bin/huangqi-scifi`）、AppImage 有可执行位且不小于 20 MB（太小说明没打进运行时）。
- Windows：NSIS 安装包的 `ProductVersion` 必须是当前版本（读 `VersionInfo`）。
- macOS：挂载 dmg → 读 `.app/Contents/Info.plist` 的 `CFBundleIdentifier`（必须 `com.huangqisf.client`）与 `CFBundleShortVersionString`，并检查 `Contents/Resources` 下三个资源 → 卸载。
- 打 tag 时额外断言 `RELEASE_TAG` 与 `version` 一致，专门防「改了 Cargo.toml 忘了改 tauri.conf.json」这种版本漂移；本机跑（无产物时应报「没有找到 .deb 产物」）已验证脚本行为。

实测体积（run 44889638130，commit `4deb9d7`，2.0.14）：

| 产物 | Tauri 2.0.14 | Electron 1.2.13 | 变化 |
| --- | --- | --- | --- |
| Linux deb | **14 MB** | 94.8 MB | −85% |
| Windows NSIS | **7.8 MB** | 90.8 MB | −91% |
| macOS dmg (arm64) | **11 MB** | 115.4 MB | −90% |
| macOS dmg (x64) | **12 MB** | 120.2 MB | −90% |
| Linux AppImage | 87 MB | 124.2 MB | −30% |

两点必须说清楚，避免把体积收益说过头：

1. **AppImage 只小了 30%**：Tauri 的 AppImage 仍是自包含 rootfs（二进制 + 资源 + KaTeX/turndown 等），而 Electron 那 124 MB 里大头也是它自带的 Chromium。真正的量级差主要体现在 deb/NSIS/dmg 这类「只装应用本体」的格式上。
2. **Linux 不再自包含渲染引擎**：deb/AppImage 依赖系统 `libwebkit2gtk-4.1`，与 1.x「拷过去就能跑」不同；这是体积收益的代价，需在下载页写明依赖。

状态：**四类产物全部构建成功并上传**（run 44887380550，commit `f763510`；首次四平台全绿为 run 44886779679）：Linux deb/AppImage、Windows NSIS、macOS arm64 与 x64 dmg。macOS 的 x64 由 arm64 runner 用 `cargo tauri build --target x86_64-apple-darwin` 交叉产出（`macos-13` 这类 Intel runner 已排不到队，改为交叉编译更稳）。**仍未验证**：安装/首次启动/签名/公证/自动更新源。

## 4.6 启动冒烟：应用在干净 Linux runner 上真的起来了（CI）

新增 CI job `smoke`（`scripts/smoke-tauri.sh`）：装 `xvfb` + `dbus-x11` + `xdotool`，`cargo tauri build --no-bundle` 出可执行文件，再 `xvfb-run … dbus-run-session -- bash scripts/smoke-tauri.sh` 真正启动。

判定四条（全部满足才绿）：进程 30 秒内不退出、X11 里能按标题「黄芪饮片」找到窗口、数据目录里出现 `hqsf.db`、**截图不是白屏**。

第四条是后补的：窗口存在不等于界面画出来了（WebKit 初始化失败时窗口照样在，只是整片白）。所以 `scripts/smoke-tauri.sh` 用 `import -window` 截图、再用 ImageMagick 数颜色种数——正常界面有文字/图标/分栏底色，实测 **916 种颜色**，低于 100 种即判白屏失败。

截图前先 `sleep 2`：一找到窗口就截会撞上「窗口已映射、首帧未画完」的中间态——AppImage 冷启动时同一份产物两次跑出 916 / 438 两种颜色数，等首帧落定后再截才稳定可比。

首跑即通过（run 44888241049，commit `b866af6`）：

```
window_found=1
window_id=2097155
app_alive=1
db_count=1
--- 本地库 ---
.../.local/share/hqsf-test/hqsf.db
.../.local/share/hqsf-test/hqsf.db-wal
.../.local/share/hqsf-test/hqsf.db-shm
screenshot_ok=1 unique_colors=916
--- 截图尺寸 ---
.../shot.png PNG 1200x800 1200x800+0+0 8-bit sRGB 30712B
```

916 种颜色说明渲染层真的画出来了（React 挂载、样式加载、图标绘制），不是空白 WebView。

`app.log` 里唯一一条告警恰好是**预期行为**：

```
[hqsf] 启动会话校验：读取本地会话失败，跳过：系统钥匙串不可用（读取凭据 hqsf.session 失败）：
Platform secure storage failure: DBus error: The name org.freedesktop.secrets was not provided ...
```

即：无 Secret Service 的容器里 keyring 不可用 → 会话校验**降级跳过而不是崩溃**（这正是 §3 里说的「钥匙串不可用直接失败但只影响会话」的设计）。

这一步能证明的：GTK/WebView 初始化、窗口创建、**渲染层真实绘制**、`CoreCtx` 装配、`Db::open`、启动编排（单实例/迁移/设置重放/后台任务）在干净环境里都走通了。

`release.yml` 的 Linux 分支还会额外跑一次 **AppImage 冒烟**（`if: matrix.platform == 'ubuntu-22.04'`，apt 里装 `libfuse2`；run 44892563462 / commit `977389b` 实测通过：窗口 1200×800、`unique_colors=916`、`hqsf.db` 落盘，说明 type2 runtime + FUSE 挂载 + 打包后资源路径都正确），因为用户下载最多的是 AppImage，而 `ci.yml` 的冒烟跑的是 `--no-bundle` 裸二进制——type2 runtime、FUSE 挂载、打包后的资源路径只有真跑 AppImage 才验证得到。
这一步仍证明不了的：中文输入法（IME 与 contenteditable 的真实交互）、H.264/AAC 解码、真实 Secret Service、拖拽手感——这些必须在装了包的 GUI 真机上做（§4 第 1/2/6/11 项）。

---

## 4.5.2 正式发版：draft Release 的创建（三轮修复）

`v2.0.14` 是第一次走「tag → 构建 → 建 draft Release」的完整链路，`release` job 连挂三轮，每轮的错误都只能靠 `release-logs` 分支回读（Actions 日志接口要 admin）：

| 轮次 | commit | 失败点 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `3652c40` | `softprops/action-gh-release@v2` | 第三方 action 把 manifest 里的全部指纹当资产上传（`dist/` 里有 422 个文件：AppImage 的 `.AppDir/` 整树、dmg 的 `create-dmg` 脚本），并且它的报错文本拿不到 | 改用 `gh` CLI，自己控制文件清单，并把失败原因回写 `release-logs` |
| 2 | `4251e82` | 日志只有前 100 行清单 | GH Actions 的 `shell: bash` 默认带 `-e`，`find … | head -50` 触发 SIGPIPE（141）直接打死脚本，`gh` 从未执行 | 清单命令加 `|| true`；同时按扩展名只挑真的安装包（5 个：deb / AppImage / setup.exe / 两个 dmg） |
| 3 | `38cbd23` | `failed to run git: fatal: not a git repository` | `release` job 没有 `checkout`，`gh` 默认从 `.git` 推仓库上下文 | 所有 `gh` 命令显式 `--repo "$GITHUB_REPOSITORY"` |

最终 run 44911431158（`2a6abe0`）：`build=success`、`release=success`；同一 commit 的四门禁 run 44911418367 也是 `core/tsc/shell/smoke` 全绿。draft Release 里的 5 个资产名形如 `hq-scifi_2.0.14_amd64.deb`、`hq-scifi_2.0.14_amd64.AppImage`、`hq-scifi_2.0.14_x64-setup.exe`、`hq-scifi_2.0.14_aarch64.dmg`、`hq-scifi_2.0.14_x64.dmg`。

两条运维事实：
- **draft 只有登录的仓库成员看得到**，匿名 `GET /releases` 查不到，所以「匿名 API 里没有 v2.0.14」不等于失败。
- 该次构建**没有配置 `HQSF_API_CONFIG_B64` secret**，包内是示例配置；正式对外发布前需在仓库 Settings → Secrets 里加上（`base64 -w0 api.config.json`），再重打一版。

整条流程与全部已知坑已沉淀为项目 skill `.dsh/skills/release-packaging/`（含 `scripts/read-status.sh` 一键读五个回写分支）。

---

## 5. 回滚与共存

- **回滚**：迁移只**复制**不删除 Electron 数据（`migrate_legacy_data` 只读源、写 staging、rename 落位到新目录），旧 `~/.config/hqsf-client/` 保持原样，1.2.13 仍可直接运行。
- **共存**：Tauri 2.0.14 使用独立 appId 数据目录；首次启动检测到旧数据即迁移，`--force` 可重跑（源指纹变化才允许）。
- **回滚手段**：1.x 的安装包仍在 GitHub Releases（v1.2.13），需要回退时装回即可；**1.x 源码已从仓库删除**（`doc/archive/1.x/` 保留设计文档），不再维护 `1.x-maintenance` 分支。`src/bridge` 里的 Electron 分支仅作为「非 Tauri 环境（如纯浏览器预览）」的降级路径保留，不再有 Electron 宿主。

---

## 6. 剩余工作

1. ✅ 壳层集成（dispatch / 协议 / 迁移 / 设置重放）——代码级完成。
2. ✅ **CI 首次真跑**：`shell` job 的 `cargo check --all-targets` 已于 `990af64` 通过（`State<'_, AppState>`、`WholePayload: CommandArg`、`generate_context!`、异步协议 handler、capabilities 都在真实编译里过了）；失败与修复过程见 §4.1.1 与 §4.4。
3. ✅ **三平台打包**：`release.yml` 经 `build-only` 分支验证（run 44884693708，commit `3251c68`），Linux deb 14 MB / AppImage 87 MB、Windows NSIS 7.8 MB、macOS dmg 11 MB，产物已上传（见 §4.5）；Intel macOS 已加入矩阵。
4. ✅ **产物自检**（run 44890975878，commit `8cdb81b`，四类产物全绿）：deb `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`、包内三个资源齐全；dmg `id=com.huangqisf.client version=2.0.14`；NSIS `ProductVersion: 2.0.14`；可执行文件名 `huangqi-scifi` 已随 `mainBinaryName` 落地。证据见 `release-status` 分支的「产物自检」段。
5. ✅ **启动冒烟**：CI `smoke` job 在 Xvfb 里真启动（§4.6），四道门禁（core/tsc/shell/smoke）在 `8cdb81b` 全绿。
6. ⏳ 装包与真机验证（§4 第 1/2/5/6/8/9/10/11 项）：按 `doc/design/真机验证清单.md` 逐项执行并回填结果。
7. ⏳ 发布：`v2.0.14` tag → draft release → 对外；发布前必须在构建机提供真实 `api.config.json`（当前 `release.yml` 用 example 兜底，装出来会连示例地址）。tag 号与 `tauri.conf.json` 的 `version` 现在由产物自检强制对齐。
8. ✅ 收尾清理（用户指示 `m02087` 后执行）：已删除 `src/main`/`src/preload`、`electron.vite.config.ts`、`electron-builder.yml`、`tsconfig.node.json`、`scripts/win-prebuild.mjs`、`scripts/archive-release.mjs`、1.x 专用测试脚本与 `.dsh/skills/cdp-debugging`；依赖移除 electron 系与 better-sqlite3，`package-lock.json` 重生成（`npm ci` dry-run 通过）；1.x 文档归档到 `doc/archive/1.x/`；`README`/`AGENTS`/`CHANGELOG` 同步改写。
   - 前置耦合**已解除**（`85df4b5`）：渲染层改用纯 Vite 构建（`vite.web.config.ts` → `out/web`，`npm run build:web`），`tauri.conf.json` 的 `frontendDist` 指向 `out/web`；`npm run build`（electron-vite）仅剩 1.x 自用。删 1.x 时只需删文件与依赖，不必动 Tauri 构建链路。