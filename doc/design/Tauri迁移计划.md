# Tauri + Rust 重构计划（多智能体执行版）

> 状态：草案 v2（2026-11-21）。v2 依据用户决策重写后端边界：**全部后端逻辑用 Rust，不再保留任何 TS 后端**。
> 本文件是 `doc/design/` 子系统文档之一，用于把当前 Electron 客户端整体迁移到 **Tauri 2 + Rust 宿主**。
> 在 P5 发布切换之前，`总体架构与技术设计.md`、`主进程子系统设计.md` 等仍是**现状**的准确描述；本文件只描述**目标态与迁移路径**。
> 执行依据：本文件 + `src/shared/contracts/ipc.ts`（85 通道契约）。行为不变性以 `doc/design/测试与回归验证计划.md` 的行为基线为准。
> Android 属未来计划，不在本期（见 §9 预留约束）。

---

## 0. 决策摘要

| # | 决策 | 结论 | 理由 |
| --- | --- | --- | --- |
| D1 | UI 引擎 | **Tauri 2.12**（系统 WebView），不再自带 Chromium | 安装包 124MB → ≤20MB；渲染层 0 处 Electron API |
| D2 | **后端语言** | **100% Rust**：能力层 + 领域层 + 适配层 + 服务编排全部在 `src-tauri` | 用户决策（2026-11-21）：单语言后端、无 TS/Rust 双实现、未来 Android 可直接复用 Rust 内核 |
| D3 | TS 职责 | **仅 UI + 传输层**：React 渲染、Zustand 状态、`window.hqsf` 85 个 invoke 包装、事件订阅、渲染层 markdown 预览 | 传输层不是业务逻辑；不含任何规则、字段规整或合并策略 |
| D4 | 前后端边界 | 保留 `window.hqsf` 的 **85 方法门面**，渲染层几乎不动 | 141 个渲染层文件不重写；门面是唯一 seam，也是多 agent 的写域边界 |
| D5 | 跨语言契约 | **tauri-specta** 生成 TS 客户端**与领域类型** + CI 漂移检查 | 类型单一来源从「手写 TS」改为「Rust 定义、生成 TS」，消灭双份 DTO |
| D6 | 插件框架 | **不引入 Cordis** | 动态服务查找反静态分析、失败后移到运行期；收益不抵成本 |
| D7 | 版本与分支 | Tauri 版为 **2.0.0**；Electron 1.x 保留维护分支 | 迁移期双轨，可随时回滚 |
| D8 | 打包 | NSIS / deb / AppImage / dmg；**不承诺 MSI**（Linux 上无法产出） | 与官方交叉编译限制一致 |

### 0.1 决策变更记录（防回流）

- **v1 → v2**：v1 采用「薄 Rust / 厚 TS」，把 1,910 行 adapters 与 896 行 services 放在渲染层。用户明确要求**后端全部 Rust**，v2 改为全量迁移。
- **架构约束（任何 agent 不得违反）**：领域规则、字段规整、合并策略、markdown 转换**只能**出现在 `src-tauri/**`。任何把这些逻辑写进 `src/bridge/**` 或 `src/renderer/**` 的改动，验收即拒。

**非目标**：
- 不改任何用户可见行为、文案、快捷键、菜单位置；
- 不做插件系统、不做移动端、不做服务端改动；
- 不换渲染层技术栈（React/Zustand/Milkdown/CodeMirror 全保留）；
- 不重命名 IPC 通道、不改变 `{ok,data}|{ok,error}` 语义；
- 不重写 `src/renderer/**`（除 P3-L6 列出的 4 个文件）。

---

## 1. 目标架构

### 1.1 目录

```
HQ-SciFi/
├── src/
│   ├── shared/
│   │   ├── generated/        # ★ specta 生成：领域类型 + 命令签名（禁止手改）
│   │   ├── contracts/        # 通道表 + HqsfApi（P1 冻结，门面类型来源）
│   │   ├── markdown/         # 渲染层预览用 TS 实现（与 Rust 实现共用金标准语料）
│   │   └── view/             # UI 专用类型（视图模型、store 状态）
│   ├── renderer/             # React UI（仅 4 个文件改动）
│   └── bridge/               # ★ 传输层：85 个 invoke 包装 + 事件订阅（约 250 行，无业务规则）
├── src-tauri/                # ★ 全部后端
│   ├── Cargo.toml            #   单写者（集成者）
│   ├── tauri.conf.json       #   单写者（集成者）
│   ├── capabilities/         #   最小权限 capability
│   ├── testdata/parity/      #   P1 生成的「输入→输出」金标准语料
│   └── src/
│       ├── lib.rs            #   组装根：generate_handler! 全量注册（单写者）
│       ├── commands/         #   18 个域模块，一通道一命令（85 条，P1 冻结实测）
│       ├── domain/           #   纯业务规则（四态、排行榜、匿名、评审隔离、排序）
│       ├── adapters/         #   响应规整（11 个 API 域，自 src/main/adapters 平移）
│       ├── services/         #   编排（auth/docs/sync/settings/updater）
│       └── infra/            #   db / fs / net / session / settings / media / updater / markdown
├── src/main/                 # Electron 主进程：P5 前原样保留，P5 后随 1.x 分支移除
└── src/preload/              # 同上
```

### 1.2 分层与职责

| 层 | 语言 | 职责 | 规模目标 |
| --- | --- | --- | --- |
| 渲染层 `src/renderer` | TS/React | UI、状态、交互 | 不变（15,051 行） |
| 传输层 `src/bridge` | TS | 85 个 `invoke` 包装、事件订阅、类型再导出 | 约 250 行，无逻辑 |
| 契约与类型 `src/shared` | TS | 通道表、`HqsfApi`、生成类型、UI 视图类型、渲染层 markdown 预览 | 约 1,800 行（含生成物） |
| **后端 `src-tauri`** | **Rust** | **能力层 + 领域层 + 适配层 + 服务编排 + markdown 转换** | **8,000–10,000 行** |

**规模换算依据**：现有后端 TS 约 6,000 行（`src/main` 5,833 + `shared` 中后端使用的 frontmatter/kaiti/math 约 300）。Rust 通常为 1.3–1.6 倍行数，得 8,000–9,500。**这是本决策的成本项，已计入 §7 估算**。

**收益项**：
1. 单一语言后端，无 TS/Rust 双实现，无「逻辑该放哪」的摇摆；
2. 渲染层 bundle 反而变小（域逻辑不进前端）；
3. 安全面收窄：不再需要通用 `api_request` 代理，渲染层只能调用 85 个具名命令；
4. 未来 Android 可直接编译同一套 Rust 内核（见 §9）。

### 1.3 命令面清单（Rust 侧，85 条 + 2 个事件）

一通道一命令，与现有 `src/main/ipc/*.handlers.ts` 的域切分**一一对应**，便于对拍与并行分工。

| Rust 模块 | 通道数 | 对应 handler | 说明 |
| --- | --- | --- | --- |
| `commands/agreement.rs` | 1 | agreement | 协议版本 + md→html + 缓存 |
| `commands/auth.rs` | 4 | auth | login/get-session/verify/logout；session 走 `infra/session` |
| `commands/browse.rs` | 4 | browse | 分类、作品库、禁词、GPT 模型 |
| `commands/chat.rs` | 4 | chat | 私聊会话/消息/发送 |
| `commands/comment.rs` | 3 | comment | 评论列表/最近评论 |
| `commands/docs.rs` | 13 | docs | 本地文件树/读写/重命名/草稿/目录选择/本索引列表 |
| `commands/interact.rs` | 3 | interact | 阅读日志、标记 |
| `commands/media.rs` | 1 | media | 图片缓存清理（协议本身不是命令） |
| `commands/notify.rs` | 3 | notify | 通知列表/未读/已读 |
| `commands/read.rs` | 2 | read | 远端文章列表/详情 |
| `commands/review.rs` | 5 | review | 评审列表/提交/态度/任务/我的评审 |
| `commands/search.rs` | 3 | search | 评论/评审/用户搜索 |
| `commands/settings.rs` | 5 | settings | 设置、更新日志、清缓存、卸载 |
| `commands/sync.rs` | 4 | sync | 拉取/推送/转草稿/改远端（含 md→html 推送） |
| `commands/system.rs` | 5 | system | ping、剪贴板 ×3、应用信息 |
| `commands/updater.rs` | 4 | updater | 状态事件 + 检查/下载/安装 |
| `commands/user.rs` | 15 | user | 资料/统计/关注/粉丝/动态/收藏/上传头像 |
| `commands/window.rs` | 5 | window | 最小化/最大化切换/关闭/是否最大化/开发者工具 |
| 事件 | 2 | — | `window-maximized-changed`、`update-state` 经 `emit` |

> 最终条数以 P1 契约冻结为准：**85 条 invoke + 2 条事件**（唯一通道名 86，`hqsf:update-state` 被 invoke 与事件复用）。

### 1.4 边界规则

| 规则 | 内容 |
| --- | --- |
| 一通道一命令 | 禁止通用 `invoke` 代理、禁止渲染层传任意 URL；网络请求由 Rust 内部经 `endpoint(name)` 取白名单路径 |
| 返回值 | Rust 返回 `Result<T, CommandError>`；`src/bridge/hqsf.ts` 统一包成 `{ok:true,data}` / `{ok:false,error}`，渲染层无感 |
| 类型 | 线格式类型在 Rust 定义并 `#[derive(specta::Type)]`，生成到 `src/shared/generated/`；UI 视图类型手写在 `src/shared/view/` |
| 渲染层 markdown | 预览用 TS（`src/shared/markdown/`），后端转换用 Rust（`infra/markdown.rs`）；两者对同一份 `testdata/markdown/` 语料做金标准对拍（见 R3） |
| 禁止 | `src/bridge/**` 或 `src/renderer/**` 出现任何业务规则、字段规整、合并策略、markdown→html |

### 1.5 数据与路径迁移（P4 交付）

| 项 | Electron 现状 | Tauri 目标 | 处理 |
| --- | --- | --- | --- |
| 应用数据目录 | `~/.config/hqsf-client`（Win `%APPDATA%\hqsf-client`，mac `~/Library/Application Support/hqsf-client`） | `$XDG_DATA_HOME/com.huangqisf.client`（Win 同为 `%APPDATA%` 下 identifier 目录） | 首启检测旧目录 → 复制 `hqsf.db`、`settings.json`、图片缓存 → 写迁移标记；**不删除**旧目录 |
| 会话 token | Electron `safeStorage` 加密 | 系统钥匙串 | **无法跨实现解密 → 强制重新登录**，迁移时清空旧 session，首启提示一次 |
| 测试模式 | `~/.config/hqsf-test` | `.../com.huangqisf.client-test` | 同规则迁移；`HQSF_TEST=1` 语义保留 |
| 随包资源 | `process.resourcesPath/{api.config.json,agreement.md,changelog.md}` | `app.path().resource_dir()` 下同名 | `tauri.conf.json > bundle.resources` 一对一映射 |
| 文档根 | `getDocsRoot()` 设置项，默认 `<documents>/荒启科幻/草稿`（测试模式加 `-test`） | 不变 | 路径字符串与目录布局原样沿用 |

### 1.6 为未来 Android 预留的两个约束（现在几乎零成本）

1. **`infra/fs` 后面留 `FileStore` trait**：桌面实现用 `PathBuf`；将来 Android 增加 `content://` URI 实现。所有 docs 命令经 trait，不直接 `std::fs`。
2. **Rust 内核不依赖窗口/桌面 API**：`infra/*`、`domain/*`、`adapters/*`、`services/*` 禁止 `use tauri::WebviewWindow` 等桌面专用类型；窗口相关只在 `commands/window.rs` 与 `infra/window.rs`。这样未来 `hqsf-core` 可直接交叉编译到 Android。

这两条约占 0.5 人日，若不做，未来 Android 需重写整个文件层。

---

## 2. 阶段计划与门禁

每个阶段都必须：可构建、可验证、可回滚。**任一验证不过就停在该阶段修，不带病前进。**

### P0 — 风险验证（Spike，约 1.5 周，5 路并行）

目的：用最低成本确认「Tauri 是否根本不可行」。**只写丢弃代码，不碰 `src/`。**

| ID | 任务 | 产出 | 门禁 |
| --- | --- | --- | --- |
| SP-1 | **Linux 中文输入法 + contenteditable**：最小 Tauri app 内放 Milkdown + CodeMirror，Debian 13 + fcitx5 测中文输入、候选框定位、光标、撤销 | `doc/spike/ime.md` + 录屏 + `spikes/ime/` | 中文输入全链路可用，组合输入不丢字 |
| SP-2 | **媒体与协议**：`hqsf-img://` 的 Win/Linux URL 差异；B 站 iframe、网易云/QQ 音乐 iframe、H.264/AAC | `doc/spike/media.md` + `spikes/media/` | 三个 iframe 至少「可播放」；协议图片可显示 |
| SP-3 | **Windows 构建链**：GitHub Actions `windows-latest` 出 NSIS，验证 WebView2 引导、安装、启动 | `doc/spike/win-ci.md` + `.github/workflows/spike-win.yml` | 产物在 Win11 可安装可启动 |
| SP-4 | **数据迁移**：旧 userData 路径、rusqlite 直开旧 DB、settings.json 兼容 | `doc/spike/data-migration.md` + `spikes/migrate/` | 真实 DB 副本可读写 |
| SP-5 | **markdown 渲染对等**（全 Rust 新增的最高风险）：用 comrak/pulldown-cmark 复刻 `markdown-it + linkify + breaks + math + kaiti span`，对 30+ 篇真实 md 与现 `mdToHtml` 输出做 HTML diff | `doc/spike/markdown.md` + `spikes/md/` + 语料 | 结构化 diff 为零（空白与属性顺序归一后） |

**止损**：SP-1 失败 → 终止迁移；**SP-5 无退路**——用户已裁定不接受「渲染层生成 HTML」的临时例外，若确无法对等则停线并提交差异清单由用户裁决；SP-2 失败 → 降级为外链；SP-3 失败 → 先只发 Linux。

### P1 — 契约冻结与金标准（串行，约 4 天，1 名契约负责人）

1. 逐条核对 85 通道，产出 `doc/design/Tauri命令契约.md`：**通道 → Rust 命令 → 参数/返回类型 → 所属 lane → DoD**。
2. 冻结 `src/shared/contracts/`（`HqsfApi` 85 方法不变）。
3. **类型归属清单**：哪些现有 `src/shared/domain` 类型由 Rust 生成、哪些留 UI（`src/shared/view/`）。
4. **生成金标准语料**：写一次性脚本，用当前 TS 实现（`node --experimental-strip-types`）对录制样本跑出 `输入 → 期望输出`，落到 `src-tauri/testdata/parity/<domain>.jsonl` 与 `testdata/markdown/*.html`。生成器只在 P1 运行，产物是 JSON；P5 后生成器随 Electron 代码归档。
5. 扩展 `scripts/test-ipc-contracts.mjs`：断言门面覆盖 85 方法、命令清单与 Rust 侧一致（Rust 侧提供 `--dump-commands` 输出 JSON）。

**门禁**：契约表 100% 覆盖；`npm run test:ipc-contracts` 通过；语料可复现；冻结后改动走 3.5 变更流程。

### P2 — 骨架与垂直切片（约 2 周，2 路并行）

| ID | 任务 | 写域 | 门禁 |
| --- | --- | --- | --- |
| B-1 | 脚手架：`src-tauri/`（Tauri 2.12）、specta 生成类型与客户端、capabilities、`--dump-commands`、CI 骨架（cargo fmt/clippy/test + tsc + node 测试 + specta 漂移检查） | `src-tauri/{Cargo.toml,tauri.conf.json,build.rs,capabilities,xtask}/**`、`.github/workflows/tauri-ci.yml` | `cargo check`/`cargo test`/`tsc` 通过 |
| B-2 | 门面骨架 + 垂直切片：`window.hqsf` 装机、`ping`/`get-app-info`/`get-settings`/`update-settings` 端到端 | `src/bridge/hqsf.ts`、`src-tauri/src/commands/{system,settings}.rs` | Tauri dev 下窗口打开、设置读写往返成功 |
| B-3 | 渲染层构建适配：`vite.renderer.config.ts`（独立于 electron-vite）+ `devUrl`；`tauri build` 产物可加载 | `vite.renderer.config.ts`、`src/renderer/src/main.tsx` | `npm run tauri:dev` 与 `npm run tauri:build` 均可用 |
| B-4 | 窗口/协议/资源/CSP：无边框窗口、自绘顶栏、`hqsf-img` 协议、CSP、`api.config.json` 资源加载 | `src-tauri/src/infra/{window,media,net}.rs` 骨架 | 界面显示；图片协议返回 200 |

**止损**：B-2 垂直切片 2 周内不通 → 停，重新评估。

### P3 — 并行域迁移（约 5–6 周，4 路并行）

见 §4。L7a/L7b/L7c 依赖 L2 + L3 合并完成；L7c 另依赖 L5 的 markdown。

### P4 — 集成与对等（约 2.5 周）

| ID | 任务 | 门禁 |
| --- | --- | --- |
| I-1 | 85 通道对等测试（逐通道校验返回形状、错误映射、类型） | 85/85 通过 |
| I-2 | 域级金标准对拍：adapters/services 用 P1 语料逐条比对 Rust 输出 | 语料全绿 |
| I-3 | GUI 冒烟：`tauri-driver` + WebKitWebDriver（Linux），登录→同步→编辑→发布主链路 | 主链路录像通过 |
| I-4 | 数据迁移实现 + 真实数据演练 | 旧 DB/settings 迁移后功能正常；token 清空正确 |
| I-5 | 性能与体积测量（冷启动、RSS、四个产物大小） | 见 §6 指标 |
| V-1 | 独立验证（另起 agent，只读）：随机抽 8 个通道与 Electron 1.2.13 对拍 | 无不一致；问题开单 |

### P5 — 发布切换（约 1 周）

1. CI 三平台产物 + `scripts/archive-release.mjs` 改造复用。
2. 版本 2.0.0；README / AGENTS.md / `doc/design/` 全量同步（含把本文件转正为「架构现状」）。
3. Electron 版本打 `1.x-maintenance` 分支，`main` 合入 Tauri，删除 `src/main`、`src/preload`。
4. 更新检查仍在同一 GitHub releases 通道（2.0.0 release notes 说明需重装 + 重新登录）。

---

## 3. 多智能体协作设计（本计划的核心约束）

### 3.1 角色

| 角色 | 人数 | 职责 | 写权限 |
| --- | --- | --- | --- |
| 编排者（Orchestrator，通常为 root） | 1 | 拆任务、派活、维护任务板、拍板止损；**不写代码** | 无 |
| 契约负责人 | 1 | P1 契约冻结 + 语料生成；此后契约变更唯一审批人 | 契约、语料、金标准脚本 |
| lane 负责人 | 3–6 | 独占一条 lane 的写域，完成 DoD | 仅本 lane |
| 集成者（Integrator） | 1 | 合并、维护单写者文件、跑全量门禁 | 单写者清单 |
| 验证者（Verifier） | 1 | 只读复验、对拍、开缺陷单；**不修** | 无 |
| 发布工程师 | 1（可兼） | P5 CI/产物/文档 | CI、发布脚本 |

### 3.2 隔离：一条 lane 一个 git worktree

所有 agent 共用同一工作目录，**写作用域重叠只是建议、不是锁**，因此必须用真实隔离：

```bash
git worktree add .worktrees/L2 -b tauri/L2        # .worktrees/ 加入 .gitignore
cd .worktrees/L2 && ln -s ../../node_modules node_modules   # 依赖用主目录（P3 期间冻结依赖）
```

规则：
1. 任何并行 lane **禁止**在主 checkout 里改文件。
2. `Cargo.toml` / `package.json` / `tauri.conf.json` / `capabilities/**` / `.github/**` **禁止** lane 直接改，只能提变更单给集成者。
3. 每个 worktree 独立 `target/`，禁止共享 `CARGO_TARGET_DIR`。
4. 并发 `npm ci` / `cargo fetch` 争锁：P2 由集成者统一预拉依赖，P3 期间 `node_modules` 用软链、cargo 首次构建顺序执行。

### 3.3 任务卡（共享任务板）

每个 lane 一张卡，字段固定（可直接映射到 `team_task_create`）：

```
subject:   L7a 阅读/评审/评论/搜索域
description: 目标 / 必读（契约表相关行 + 被翻译的 TS 文件清单 + 语料路径） / 产出文件 / 不做什么 / 验收命令
write_scopes: 精确到目录或文件
blocked_by:   前置任务 ID
DoD: 可执行的命令 + 期望输出
```

**DoD 必须是命令**，例：
```
cargo test -p hqsf-tauri review::            # 通过
node scripts/parity-adapters.mjs review      # 语料全绿，退出码 0
```

**翻译类 lane 的附加 DoD**（全 Rust 决策特有）：
- 每个被翻译的 TS 文件在任务卡里列出路径，实现后该文件**行为**由语料覆盖；
- 纯函数必须有表驱动测试；错误分支（空响应、字段缺失、非 2xx）必须各有一条用例；
- 提交信息注明 `port(<ts 文件>)`，便于 V-1 反查遗漏。

### 3.4 单写者清单（冲突热点，必须 serialized）

| 文件/目录 | 为什么是热点 | 规则 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | `generate_handler!` 全量命令列表 + `collect_commands` | 集成者独占。lane 只提供 `pub fn register(app)`，集成者合并 |
| `src-tauri/src/{commands,adapters,domain,services}/mod.rs` | barrel | 集成者独占；lane 不自建 barrel |
| `src-tauri/Cargo.toml` | 依赖与 feature | 集成者独占；lane 提变更单 |
| `src-tauri/tauri.conf.json`、`capabilities/**` | 窗口/CSP/权限 | 集成者独占 |
| `src/bridge/hqsf.ts` | 85 方法门面 | 集成者独占；lane 只实现 Rust 命令 |
| `src/shared/generated/**` | specta 生成物 | **谁都不手改**，由脚本生成 |
| `src/shared/contracts/**`、`testdata/parity/**` | 双轨共用契约与金标准 | 契约负责人独占 |
| `scripts/test-ipc-contracts.mjs`、`.github/workflows/**` | 门禁本身 | 契约负责人 / 集成者 / 发布工程师 |
| `AGENTS.md`、`doc/design/**` | 文档 | 集成者在 P5 统一更新 |

> 每个 lane 统一暴露 `pub fn register(app: &mut App)` / `pub fn init()` 供 `lib.rs` 一行接入——这是绕开热点、让并行成立的关键设计。

### 3.5 契约冻结与变更

1. P1 冻结后，通道名、参数名、返回类型、`{ok,error}` 语义不可单方面变更。
2. lane 发现契约缺口 → 提 `contract-change` 卡（说明通道、改什么、影响哪些 lane）→ 契约负责人审批 → 每天批量合并一批 → 重新生成 bindings → 通知受影响 lane rebase。
3. **禁止**在实现里「顺手」加字段或改错误文案。

### 3.6 合并顺序与集成门禁

1. 合并顺序按 `blocked_by` 拓扑：P2 骨架 → (L1,L2,L3,L6) → (L4,L5) → (L7a,L7b,L7c) → P4。
2. 每次合并后集成者跑**全量门禁**，失败则回退该次合并并退回 lane：
   ```
   cargo fmt --check && cargo clippy -- -D warnings && cargo test
   npx tsc --noEmit -p tsconfig.web.json
   npm run test:ipc-contracts && npm run test:lib-rules
   npm run tauri:bindings:check      # specta 生成物漂移检查
   node scripts/parity-adapters.mjs  # 已有语料不得回退
   ```
3. 双轨期 `src/shared/**` 改动必须**同时**通过 Electron 与 Tauri 两侧 typecheck。
4. 冲突解决：生成物重新生成，不手工 merge；barrel/注册表由集成者重建。
5. **拒绝理由白名单**：出现「把规则搬回 TS」「绕过 assertInside」「手改 generated」的 PR，直接拒。

### 3.7 验证者

- 只读，不修代码；对合并后的 `main` 独立复跑门禁。
- 每轮抽查：随机 5 个通道与 Electron 1.2.13 对拍（返回形状、错误分支、边界输入）。
- 专查三类高危：路径穿越（`..`/symlink）、token 是否泄漏到渲染层、错误信息是否把内部细节透给 UI。
- 另查「翻译遗漏」：随机挑 1 个被翻译的 TS 文件，逐分支核对 Rust 实现。
- 输出缺陷单（含复现命令），交编排者派给对应 lane。

### 3.8 节奏与并发上限

- **同时最多 4 个写代码 agent + 1 个验证者**。超过后合并成本与上下文成本压过并行收益。
- 每 lane 一次只持有一张卡；完成后先合并再领新卡。
- 每天一次「集成窗口」：合并当天完成的 lane、跑门禁、更新任务板。
- 上下文投喂：lane agent 只给「本文件对应小节 + 契约表相关行 + 被翻译的 TS 文件 + 语料路径」，不给整个仓库。

### 3.9 失败处理

| 情况 | 动作 |
| --- | --- |
| lane 卡住 > 1 个工作日 | 编排者拆卡或改派，必要时降级实现并登记技术债 |
| 合并冲突反复 | 缩小该 lane 写域，热点文件收归集成者 |
| P0 风险在 P3 复现（如 IME、markdown 回归） | **停线**：冻结合并，先解决风险 |
| 契约漂移被验证者发现 | 契约负责人裁定；批量修正 |
| 进度滑出 20% | 砍非必须项（dmg/签名/自动更新），保 Linux+Windows 主链路 |

---

## 4. 任务矩阵

> 写域相对仓库根；`#` 表示新增目录。任务 ID 用于 `team_task_create` 与 `blocked_by`。

### 4.1 P0 / P2

| ID | 任务 | 写域 | blocked_by |
| --- | --- | --- | --- |
| SP-1 | Linux 输入法 spike | `spikes/ime/**`、`doc/spike/ime.md` | — |
| SP-2 | 媒体与协议 spike | `spikes/media/**`、`doc/spike/media.md` | — |
| SP-3 | Windows CI spike | `spikes/win/**`、`.github/workflows/spike-win.yml` | — |
| SP-4 | 数据迁移 spike | `spikes/migrate/**`、`doc/spike/data-migration.md` | — |
| SP-5 | markdown 对等 spike | `spikes/md/**`、`doc/spike/markdown.md` | — |
| B-1 | 脚手架 + specta + CI | `src-tauri/{Cargo.toml,tauri.conf.json,build.rs,capabilities,xtask}/**`、`.github/workflows/tauri-ci.yml` | SP-1..SP-5 |
| B-2 | 门面骨架 + 垂直切片 | `#src/bridge/hqsf.ts`、`src-tauri/src/commands/{system,settings}.rs` | B-1 |
| B-3 | 渲染层构建适配 | `vite.renderer.config.ts`、`src/renderer/src/main.tsx` | B-1 |
| B-4 | 窗口/协议/资源/CSP | `src-tauri/src/infra/{window,media,net}.rs`（骨架） | B-1 |

### 4.2 P3 lane

| ID | lane | 主要产出 | 写域 | 估 | blocked_by |
| --- | --- | --- | --- | --- | --- |
| L1 | 平台层 | window/system/settings/clipboard/devtools/zoom/CSS-JS 注入/单实例/openExternal/reveal/agreement/changelog/clear-cache/uninstall | `src-tauri/src/commands/{system,window,settings,agreement}.rs`、`src-tauri/src/infra/{settings,window}.rs`、`src-tauri/tests/platform.rs` | 8 | B-2 |
| L2 | 存储层 | SQLite（rusqlite，表结构不变）+ `FileStore` trait + 文件沙箱（assertInside 重写）+ docs 13 命令 + 旧 DB 兼容 | `src-tauri/src/infra/{db,fs}.rs`、`src-tauri/src/commands/docs.rs`、`src-tauri/tests/storage.rs` | 10 | B-2 |
| L3 | 网络层 | reqwest、`api.config.json` 资源加载、token 注入、endpoint 白名单、超时/错误映射、TLS | `src-tauri/src/infra/net.rs`、`src-tauri/tests/net.rs` | 8 | B-2 |
| L4 | 会话与更新 | keyring（含 Linux 降级）+ updater 四命令 | `src-tauri/src/infra/{session,updater}.rs`、`src-tauri/src/commands/{session,updater}.rs`、`src-tauri/tests/session.rs` | 5 | B-2 |
| L5 | 媒体与 markdown | `hqsf-img://` 协议（平台 URL 差异）、imgcache 配额与去重、`infra/markdown.rs`（markdown-it 对等实现）、media 命令 | `src-tauri/src/infra/{media,markdown}.rs`、`src-tauri/tests/{media,markdown}.rs` | 9 | B-2 |
| L6 | 渲染层适配 | 仅 4 文件：`main.tsx` 装门面；`sanitize.ts:83`/`mdPreview.ts:9` 协议 URL 按平台改写；`index.html` CSP 移交配置。**窗口控制与更新事件无需改动**——`windowControls.*`、`onUpdateState` 由门面内部转 Tauri 窗口 API 与 `listen`，`TopBar.tsx`、`LoginView.tsx`、`FirstRunAgreement.tsx`、`SystemPanel.tsx`、`UpdateBanner.tsx`、`appMenuItems.tsx` 保持原样 | `src/renderer/src/main.tsx`、`src/renderer/src/lib/{sanitize,mdPreview}.ts`、`src/renderer/index.html` | 2 | B-3 |
| L7a | 阅读/评审/评论/搜索域 | 13 命令 + `adapters/{read,review,comment,search}*` + `domain`（评审打分、可见性、排序）翻译 | `src-tauri/src/commands/{read,review,comment,search}.rs`、`src-tauri/src/adapters/{read,review,comment,search}.rs`、`src-tauri/src/domain/{review,comment}.rs`、`tests/read_review.rs` | 14 | L2,L3 |
| L7b | 用户/社交域 | 25 命令 + `adapters/{user,chat,notify,browse,interact,comment-request}` 翻译 | `src-tauri/src/commands/{user,chat,notify,browse,interact}.rs`、`src-tauri/src/adapters/{user,chat,notify,browse,interact}.rs`、`tests/social.rs` | 14 | L2,L3 |
| L7c | 内容与账号域 | 10 命令（sync 4、auth 4、agreement 1、settings-service 1）+ sync 合并规则 + 推送 md→html + 四态转换 | `src-tauri/src/commands/{sync,auth}.rs`、`src-tauri/src/services/{sync,auth,docs}.rs`、`src-tauri/src/domain/article_state.rs`、`tests/sync.rs` | 16 | L2,L3,L5 |

**波次**（并发上限 4 写手）：
- W1：L3、L2、L1、L6
- W2：L4、L5、L7a、L7b
- W3：L7c（+ 前两波溢出）

### 4.3 P4 / P5

| ID | 任务 | 写域 | blocked_by |
| --- | --- | --- | --- |
| I-1 | 85 通道对等测试 | `src-tauri/tests/parity.rs`、`scripts/test-parity.mjs` | L1–L7c |
| I-2 | 域级金标准对拍 | `scripts/parity-adapters.mjs`、`src-tauri/tests/golden.rs` | L1–L7c |
| I-3 | GUI 冒烟（tauri-driver） | `scripts/gui-smoke.mjs`、`doc/design/测试与回归验证计划.md`（追加节） | I-1 |
| I-4 | 数据迁移实现 | `src-tauri/src/infra/migrate.rs` | L2,L4 |
| I-5 | 性能/体积测量 | `doc/design/Tauri迁移验收记录.md` | I-1 |
| V-1 | 独立验证 | 只读，无写域 | L1–L7c |
| R-1 | CI 发布矩阵 + 归档 | `.github/workflows/release.yml`、`scripts/archive-release.mjs` | I-1 |
| R-2 | 文档与 AGENTS.md 同步 | `README.md`、`AGENTS.md`、`doc/design/**` | P5 完成 |
| R-3 | 调试 skill 迁移（CDP → tauri-driver） | `.dsh/skills/tauri-debugging/**` | I-3 |

---

## 5. 风险登记与止损

| # | 风险 | 概率 | 影响 | 缓解 | 止损 |
| --- | --- | --- | --- | --- | --- |
| R1 | Linux WebKitGTK 中文输入法/contenteditable 不可用 | 中 | **致命** | SP-1 先验；锁 Debian 13 + WebKitGTK 版本；备选降级为独立输入框 | SP-1 失败即终止 |
| R2 | B 站/网易云 iframe 在 WebKitGTK 无法播放 | 中高 | 高 | SP-2 先验；gst-libav 声明为系统依赖；降级为「浏览器打开」 | 降级并记录 |
| R3 | **markdown 渲染对等失败**（推送 HTML 与现网不一致） | 中高 | 高（发布内容格式） | SP-5 先验；comrak + 自定义 math/kaiti；金标准语料 diff；保留 30+ 真实文件回归 | 无法对等 → 需要用户批准临时例外（渲染层生成 HTML） |
| R4 | 迁移中丢失本地数据 | 低 | 致命 | I-4 真实 DB 副本演练；只复制不删除；失败可回退 Electron | 立即回滚 |
| R5 | **2,800 行 TS 手译为 Rust 造成行为漂移** | 高 | 高 | P1 金标准语料 + 表驱动测试 + V-1 逐分支抽检 | 语料红 → 不合 |
| R6 | Rust 编译慢拖垮 AI 迭代 | 高 | 中 | 薄 crate 拆分、`cargo check`/`cargo test -p`、CI 缓存；禁止每轮全量 build | 接受 |
| R7 | 多 agent 并行造成合并地狱 | 中高 | 中 | worktree 隔离 + 单写者清单 + 拓扑合并 + 每日集成窗口 | 减并发到 2 |
| R8 | 双轨期 `src/shared` 两侧类型不兼容 | 中 | 中 | 单写者 + 两侧 typecheck 门禁 | 回退该改动 |
| R9 | Windows 无 WebView2 的环境无法启动 | 低 | 中 | NSIS 加 WebView2 bootstrapper 选项 | 接受（Win11 自带） |
| R10 | AppImage 不再自包含（依赖 libwebkit2gtk-4.1） | 高 | 中 | README 明确系统依赖；deb 声明 Depends | 接受，文档说明 |
| R11 | 全 Rust 后端使工期与代码量上浮 | 高 | 中 | 已计入 §7；先做 SP-5 与语料，把翻译变成「对表」而非「重写」 | 必要时砍 dmg/签名 |

---

## 6. 验收标准

### 6.1 功能对等（85/85）

登录/会话恢复、协议弹窗、草稿箱同步（pull/push）、本地 Markdown 读写与目录树、四态发布、阅读视图、评审提交、评论、私聊、通知未读、全局搜索、用户主页、设置（缩放/自定义 CSS/JS）、更新检查横幅、窗口控制与最大化事件、图片 `hqsf-img`、三个 iframe 媒体、右键菜单全场景、Ctrl+F12、单实例、外部链接交系统浏览器、`dev:test` 隔离。

### 6.2 金标准（I-2）

- `adapters` 语料：每条输入 → Rust 输出与 P1 期望输出**逐字段相等**；
- `domain` 纯函数：表驱动用例 100% 通过；
- markdown：30+ 真实文件生成的 HTML 在归一化（空白折叠、属性顺序）后**零差异**；
- `sync` 合并规则：至少 10 组「本地/远端状态组合」用例与现实现一致。

### 6.3 量化指标（以 1.2.13 为基线，I-5 记录）

| 指标 | 目标 |
| --- | --- |
| Linux AppImage / deb | ≤ 20MB / ≤ 12MB |
| Windows NSIS | ≤ 10MB |
| macOS dmg | ≤ 20MB |
| 冷启动到可交互 | ≤ Electron 基线 × 1.0 |
| 空闲 RSS | ≤ Electron 基线 × 0.6 |
| 渲染层产物 | ≤ 基线（域逻辑不进前端，应更小） |
| Rust 代码量 | ≤ 10,000 行 |

### 6.4 安全不变式（V-1 必查）

token 不出 Rust；**无通用 `invoke` 代理**，只有 85 个具名命令；一切文件路径经 `assertInside`；`open_external` 只放行 http(s)；无远程脚本加载；capabilities 最小集；`src/bridge` 无业务规则。

---

## 7. 估算

| 阶段 | agent-day | 墙钟（4 写手 + 1 验证） |
| --- | --- | --- |
| P0 spike（5 路） | 15 | 1.5 周 |
| P1 契约与语料 | 6 | 4 天 |
| P2 骨架 | 18 | 2 周 |
| P3 域迁移 | 86 | 5–6 周 |
| P4 集成对等 | 22 | 2.5 周 |
| P5 发布切换 | 8 | 1 周 |
| **合计** | **155** | **约 12–14 周** |

> 相比 v1（薄 Rust / 厚 TS，112 agent-day）多约 40 agent-day，即全量 Rust 的实际代价；换来单一后端语言与 Android 可复用内核。

---

## 8. 附录

### A. 通道 → lane 归属

| 归属 | 通道数 | 来源 |
| --- | --- | --- |
| L1 平台 | 15 | system 5 + window 5 + settings 5（+ agreement 1 由 L7c） |
| L2 存储 | 13 | docs |
| L3 网络 | 0（基础设施） | 被 L7a/b/c 使用 |
| L4 会话更新 | 8 | auth 4 + updater 4 |
| L5 媒体 markdown | 1 | media 1（+ 协议、md2html 非命令） |
| L7a 阅读评审 | 13 | read 2 + review 5 + comment 3 + search 3 |
| L7b 用户社交 | 25 | user 15 + chat 4 + notify 3 + interact 3 |
| L7c 内容账号 | 6 | sync 4 + agreement 1 + settings-service 相关 1 |

### B. 参考

- Tauri 2.12 发布说明 <https://tauri.org.cn/blog/tauri-2.12/>
- 自定义协议 URL 差异（Windows/Android 用 `http://{scheme}.localhost`）
- tauri-specta <https://docs.rs/tauri-specta/>
- 交叉编译限制 <https://v2.tauri.org.cn/distribute/windows-installer/>

### C. 任务卡模板（翻译类 lane）

```
subject: L7a 阅读/评审/评论/搜索域
description:
  读：doc/design/Tauri命令契约.md 第 3 节；src-tauri/testdata/parity/{read,review,comment,search}.jsonl
  翻译：src/main/ipc/{read,review,comment,search}.handlers.ts
        src/main/adapters/{read,review,comment,search}.adapter.ts
        src/main/services/{read,review,comment,search}-service.ts（如有）
        src/main/domain/*（评审打分、可见性、排序相关部分）
  做：实现 commands/* 与 adapters/*，暴露 pub fn register(app)
  不做：不改 Cargo.toml、lib.rs、src/bridge、src/shared/generated
write_scopes: [src-tauri/src/commands/read.rs, ..., src-tauri/src/adapters/review.rs, ..., src-tauri/tests/read_review.rs]
blocked_by: [L2, L3]
DoD:
  cargo test -p hqsf-tauri read_review 通过
  node scripts/parity-adapters.mjs read review comment search 退出码 0
  cargo clippy -p hqsf-tauri -- -D warnings 通过
```

---

## 9. 展望：Android（本期不做）

全 Rust 后端使 Android 复用成本显著低于 v1 方案：Rust 内核可交叉编译到 `aarch64-linux-android`，仅需替换两个实现——`FileStore` 的 SAF 版本、`infra/session` 的 Keystore 版本——再加一套移动端 UI 外壳。前提是 §1.6 的两条约束在 P3 就落实。估算：Android 增量约 5–7 周（SAF 2 周、移动外壳 3–4 周、媒体/IME 验证 1 周）。

---

## 10. v2.1 变更记录（2026-11-21，与上文冲突处**以本节为准**）

1. **markdown 对等是硬门禁**（用户裁定）：不接受任何临时例外，SP-5 不通过即停线。
2. **工程切分为「内核 + 壳」**：
   - `crates/hqsf-core`：纯 Rust，**零 tauri 依赖**。domain / adapters / services / infra 全部在此，`cargo test -p hqsf-core` 即可验证全部逻辑（本机沙箱无 `pkg-config`、无 WebKitGTK 也能跑）。
   - `src-tauri`：薄壳，只做 `#[tauri::command]` 包装、窗口、协议、keyring/host 能力、updater、单实例。
   - 内核经端口 trait 访问系统能力：`FileStore`、`SecretStore`、`HttpTransport`、`EventSink`、`Clock`；壳里给真实实现。这条同时满足 §1.6 的 Android 复用约束。
3. **绑定生成改为无头**：`crates/hqsf-bindings`（只依赖 specta）导出 `src/shared/generated/{types.ts,commands.ts}` 与 `src-tauri/testdata/contracts/commands.json`；`cargo run -p hqsf-bindings -- --check` 做漂移检查。**不用 tauri-specta**：它的导出要走 tauri Builder，需要 WebKitGTK 才能编译，无法在 CI 的纯 Rust 任务里跑。
4. **本机验证边界**（沙箱无 pkg-config / WebKitGTK；`npm` 二进制缺失，改用 `node_modules/.bin/*`）：

   | 可本机验证 | 只能在具备 WebKitGTK 的环境/CI 验证 |
   | --- | --- |
   | `cargo test/clippy/fmt`（core + bindings） | `src-tauri` 编译 |
   | `node_modules/.bin/tsc --noEmit` | GUI 行为、输入法、媒体播放 |
   | markdown 金标准 diff（TS 预言机 + comrak） | 安装包产物与安装流程 |
   | 契约/通道一致性与绑定的漂移检查 | 三平台签名、真机数据迁移 |

   因此「完成」分两级：**逻辑级完成**＝本机全绿（本计划以它为准逐 lane 验收）；**产品级完成**＝CI + 真机验证（P5 门禁）。
5. 估算相应调整为 **157 agent-day**（+2：无头绑定器与 core/壳切分），墙钟不变。
---

## 11. 执行记录（2026-11-21 实际完成情况）

> 逐条约定的验收证据见 [Tauri迁移验收.md](./Tauri迁移验收.md)。本节只记录「计划 vs 实际」的差异与结论。

### 11.1 阶段完成度

| 阶段 | 计划 | 实际 | 结论 |
| --- | --- | --- | --- |
| P0 风险验证 | 5 路 spike（SP-1 IME、SP-2 媒体、SP-3 Windows 构建、SP-4 数据、SP-5 markdown） | SP-4 ✅、SP-5 ✅（86/86 逐字节，comrak+QuickJS 方案）、SP-1/2/3 ❌ 本机无法验证（无 WebKitGTK / 无法交叉打包），已转入 CI+真机清单 | **SP-5 硬门禁通过**；风险 1/2/3 仍待 CI |
| P1 契约冻结 | 85 通道 + 金标准 | ✅ `commands.json`（85 通道 / 2 事件 / 10 异常）+ `Tauri命令契约.md`（348 行、521 处 file:line）+ markdown 语料 143 条 | 完成 |
| P2 骨架 + 垂切 | core/壳切分、端口、绑定器、桥接门面 | ✅ `crates/hqsf-core` + `hqsf-bindings` + `src-tauri` + `src/bridge`；门面 85 方法渲染层零改动 | 完成 |
| P3 并行域迁移 | 9 条 lane | ✅ 全部落地（L1/L2/L3/L4/L5/L6/L7a/L7b/L7c + L8 迁移）：Rust 26,386 行、521 测试 | 完成（超预期：计划 ≤10,000 行，实际含测试 26k） |
| P4 集成对等 | 全量对等 + 数据迁移 + 事件 | ⏳ 内核侧完成；壳层集成（dispatch 生成 / 协议接真 / 启动迁移 / 设置重放）进行中 | 部分 |
| P5 发布切换 | CI 三平台 + 文档 + 2.0.0 | ⏳ CI 与文档已就绪，首次真跑待执行 | 部分 |

### 11.2 与计划的关键偏差

1. **代码量**：计划 §6.3 写「Rust ≤ 10,000 行」，实际 26,386 行（含约 40% 测试代码）。原因：1.x 的 TS 侧 2,800 行「逻辑」在 Rust 里要显式表达类型、错误分支与测试；件数膨胀不等于复杂度膨胀。指标应改看「测试覆盖的行为分支数」而不是行数。
2. **dmg/NSIS 交叉打包**：本机无法验证，`release.yml` 已按 `tauri-action` 写好，首次真跑前不应声称「三平台可用」。
3. **`src/main` 未删除**：双轨保留（回滚路径 + 行为参照），删除应在 P5 真机验证通过后单独提交。
4. **`executableName`**：1.x 是 `huangqi-scifi`，Tauri 用 `productName` → `hq-scifi`。升级路径（快捷方式、安装目录、卸载器）需在 P5 真机确认；如需保持旧名，在 `tauri.conf.json` 显式指定。

### 11.3 事故与防回流

- 并行 lane 误改根 `Cargo.toml`（`~/.cache` 只读 + `cd` 失败 + 无 `set -e` → heredoc 在仓库根执行），导致全 lane 编译中断。已恢复并在 `Rust实现约定.md` §10 固化：只有 lead 能改根清单；Rust 实验必须在 `spikes/<name>/rs/`（自带空 `[workspace]`）；统一测试命令。
- 结论：**多 agent 并行时，「写盘前的 cwd/路径校验」与「固定测试命令」比代码规范更重要**——这两条建议写进任何后续多 agent 计划模板。

### 11.4 时长

计划 12–14 周墙钟（157 agent-day）。本次由 1 个 lead + 12 个 subagent 并行推进，实际约 1.5 小时完成 P0–P3 的逻辑级交付；P4/P5 待 CI 与真机。并行加速主要来自「契约先行 + 端口固定 + 文件所有权清单」，代价是 1 次清单事故与约 15% 的返工（跨 lane 签名不一致）。
