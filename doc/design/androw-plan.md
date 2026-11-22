# 荒启科幻 Android 开发计划（多智能体执行版）

> 版本：v1 草案 · 2026-11-22
> 依据：`doc/design/androw-design.md`（界面设计 v2）、`doc/design/Tauri迁移计划.md` §9（Android 复用内核）、`doc/design/Rust实现约定.md`、`doc/design/真机验证清单.md`
> 范围：Android 手机端首个可发布版本（内部 Beta APK）。平板/折叠屏、应用商店上架、App 内自动更新不在本期。

## 实施状态（2026-11-22）

- **已交付**：`2.1.16` debug/release APK；HONOR AGT-AN00（Android 15，arm64-v8a）真机验证通过。
- **已完成**：手机独立壳（五导航 + 页面栈 + 返回键）、首页四栏目/作品库二级分类、我的（未登录/登录壳 + 用户页页签）、写作（本地存档 + 四态 + 编辑器 + 键盘 inset）、消息/设置、文章阅读页 + 底部操作条、协议/资源/TLS。
- **降级/未完成**：SAF 导出（当前提示“暂未接系统文件选择器”）、Keystore（当前 `FileSecrets` 落 `data_dir/secrets.json`）、服务端推送、平板/折叠屏（v2）、应用商店合规、CI Android 构建 job、登录后发布/评审的真机全链路（缺可用测试账号）。
- **构建**：`bash scripts/build-android.sh`（debug）/ `--release`；release 产物再用 `.android-sdk/build-tools/37.0.0/apksigner` 签名。
- **签名**：本地 keystore `.android-keystore/hqsf-release.jks`（gitignored，密码在同目录 `password.txt`，务必另行备份；CI 需转成 secret）。

## 0. 目标与边界

### 0.1 目标

在 9 周内交付一个可安装、可日常使用的 Android APK：

- 复用 `crates/hqsf-core`，不重写业务逻辑；桌面端 85 条 IPC 契约保持不变。
- 完成 Android 平台层：文件（SAF/私有目录）、密钥（Keystore）、返回键/手势、IME、权限、通知、深链、生命周期。
- 完成手机布局：底部导航、一级页签、返回栈、右侧抽屉、文章页/编辑器全屏。
- 功能与 `androw-design.md` §8 验收清单一致；桌面端现有功能不回归。

### 0.2 不做

- 平板/折叠屏三栏（v2）；SAF 与桌面共用草稿文件夹；应用商店合规与上架；APK 自动更新；桌面端功能重构。

### 0.3 成功标准

- 一台 Android 10+ 真机可完成：启动 → 协议 → 浏览 → 登录 → 阅读 → 评审 → 写作 → 发布草稿 → 消息 → 返回，全程无崩溃。
- CI 每次合并都能产出 debug APK；release 分支能产出签名 APK。
- 关键路径有自动化冒烟；其余按真机清单人工验收并存证。

## 1. 交付物

| 交付物 | 说明 | 负责人 |
|---|---|---|
| Android debug/release APK | `applicationId=com.huangqisf.client`，版本跟 `tauri.conf.json` | release |
| CI 流水线 | Android 构建、单测、lint、冒烟、产物上传 | release |
| 平台层实现 | SAF FileStore、Keystore SecretStore、Android Platform/通知/权限 | platform-ports + android-shell |
| 手机 UI | 底部导航、页签、返回栈、抽屉、各页面 | ui-foundation + 4 条 lane |
| 测试证据 | 真机清单结果、截图/logcat、冒烟报告 | verifier |
| 文档 | 本计划、平台契约、构建/签名说明、已知问题 | lead + release |

## 2. 团队编制

同时最多 **4 个写代码智能体 + 1 个只读验证者**；平台层先行，随后 4 条功能 lane 并行。P0 例外：工具链 spike 需要 release 并行搭 CI，允许 5 个写手；P1 起回到 4 写手 + 1 验证者。

| 角色 | 代号 | 职责 | 写域（worktree 内） | 不做什么 |
|---|---|---|---|---|
| 编排/集成 | `lead` | 拆卡、定契约、评审、合并、发布决策；兼集成者 | 共享文件（见 §3.3）、`doc/design/androw-plan.md` | 不写业务代码，不直接改 lane 文件 |
| Android 壳层 | `android-shell` | Gradle/Manifest、MainActivity、生命周期、返回键、深链、权限、IME insets、通知通道 | `src-tauri/gen/android/**`、`src-tauri/src/mobile/**`、`src-tauri/capabilities/mobile.json` | 不改 `lib.rs`（提变更单给 lead）、不改渲染层 |
| 平台端口 | `platform-ports` | Android 上 Rust 侧端口实现：SAF/私有目录 `FileStore`、Keystore `SecretStore`、Platform/通知事件、路径策略；与 Kotlin 壳的 JNI/插件边界 | `src-tauri/src/runtime/android/**`（新建）；需要改 `crates/hqsf-core/src/{ports,sandbox}.rs` 时走变更单给 lead | 不改 Gradle/Manifest；不改核心业务规则；不改 commands/registry |
| UI 基础 | `ui-foundation` | 底部导航、页签 pager、返回栈、抽屉、安全区、登录/协议壳 | `src/renderer/src/features/mobile/shell/**`、`lib/backStack.ts`、`stores/mobileNav.ts` | 不实现具体业务页面 |
| Lane A 首页 | `lane-home` | 推荐/活动/连载/作品库/搜索 | `src/renderer/src/features/mobile/home/**` | 不改桌面 feature 文件；需要时提变更单 |
| Lane B 阅读 | `lane-reader` | 文章页、目录/评论/评审抽屉、评分、互动 | `src/renderer/src/features/mobile/reader/**` | 不改桌面 ReaderView；通过包装复用 |
| Lane C 我的/消息 | `lane-user` | 我的 7 页签、他人主页、消息 3 页签、私聊、历史 | `src/renderer/src/features/mobile/user/**`、`mobile/messages/**` | 不改桌面 user/notifications |
| Lane D 写作 | `lane-writing` | 写作 5 页签、本地存档、编辑器、发布表单 | `src/renderer/src/features/mobile/writing/**` | 不改桌面 editor；通过 wrapper/适配层 |
| 验证 | `verifier` | 只读验收、真机矩阵、安全抽查、回归；写报告 | `doc/qa/android/**`、`scripts/e2e/android/**` | 不改产品代码 |
| 发布 | `release` | Android CI、签名、版本、产物、回滚 | `.github/workflows/android.yml`、`scripts/android/**`、`doc/release/android.md` | 不改业务代码 |

说明：

- lane 优先“包装复用”桌面组件（`features/<原有域>` 只读），避免同一文件被桌面与 Android 两处修改。确实需要改桌面组件时，走变更单由 lead 批准并指定唯一写者。
- `src-tauri/src/lib.rs`、各 `mod.rs`、`Cargo.toml`、`tauri.conf.json`、`src/shared/generated/**`、契约 testdata 仍按 `Tauri迁移计划.md` §3.4 由 lead 独占。
- 每个 agent 一个 worktree：`.worktrees/android-<role>/`，`node_modules` 软链，独立 `CARGO_TARGET_DIR`；禁止共享 target 目录。

## 3. 协作规则

### 3.1 任务卡

每张卡必须包含：

```
id / subject
owner / write_scopes / blocked_by
必读：文档与文件（含行号）
产出：文件、命令、截图/报告
不做：明确排除项
验收：可执行命令 + 人工步骤
```

示例：

```
id: AND-P1-04
subject: 手机返回栈与系统返回
owner: ui-foundation
write_scopes: src/renderer/src/features/mobile/shell/**, src/renderer/src/lib/backStack.ts, scripts/test-back-stack.mjs
blocked_by: AND-P0-02（返回手势 spike）
必读: androw-design.md §3、§6.2；Tauri迁移计划.md §3
产出: backStack.ts、返回规则测试脚本、3 条录屏
不做: 不改各业务页内部导航
验收: node_modules/.bin/tsc -p tsconfig.web.json && node --experimental-strip-types scripts/test-back-stack.mjs
```

### 3.2 节奏

- 每天 10:00 站会（各 agent 三句话：昨天/今天/阻塞）；每天 2 个集成窗口（13:00、18:00），只在该窗口合并。
- 每张卡完成即提 PR；lead 按 `blocked_by` 拓扑合并，合并前跑全量门禁。
- 卡住超过 1 个工作日：拆卡或改派；同一文件冲突两次：缩小写域或改由 lead 串行完成。

### 3.3 共享文件与契约

- 单写者清单：`src-tauri/src/lib.rs`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/*`（`mobile.json` 除外）、所有 `mod.rs`、`crates/hqsf-core/Cargo.toml`、`commands/registry.rs`、`src/shared/generated/**`、`src/bridge/hqsf.ts`、`.github/workflows/*`（android 除外）、`AGENTS.md`、`doc/design/*`。
- 需要新端口/新错误/新依赖/新 IPC：先提变更单给 lead，冻结后再写。
- IPC 不新增通用转发；确需新命令时遵守“一通道一命令”，类型从 Rust 生成，跑 bindings 漂移门禁。
- 平台契约（P1 冻结）：返回事件、文件导入/导出、通知权限、深链、生命周期、IME insets、图片选择。冻结后变更走版本化变更单。

### 3.4 合并门禁

每次合并至少跑：

```bash
export CARGO_HOME=$PWD/.cargo-home
cargo test -q -p hqsf-core --lib
cargo clippy -q --all-targets -- -D warnings
cargo fmt --all -- --check
cargo run -q -p hqsf-bindings -- --check
node src-tauri/scripts/gen-tauri-commands.mjs --verify
node_modules/.bin/tsc -p tsconfig.web.json
node_modules/.bin/vite build --config vite.web.config.ts
```

Android 相关合并追加：`cd src-tauri/gen/android && ./gradlew assembleDebug`（CI 执行，本机无 Android SDK 时由 CI 兜底）。

## 4. 阶段计划

总量约 **9 周 / 66 agent-day**。每周按 5 个工作日计；W1 的 5 个 spike 并行，之后进入 4 lane。

| 阶段 | 周 | 目标 | 主要 agent | 出口门禁 |
|---|---|---|---|---|
| P0 风险验证 | W1 | 证明 Android 能跑、关键平台能力可行 | android-shell、platform-ports、ui-foundation、verifier、release | 2 台真机跑通 hello APK；5 份 spike 报告；go/no-go |
| P1 契约与骨架 | W2 | 冻结平台契约，搭出手机壳和返回栈 | lead、android-shell、platform-ports、ui-foundation | 契约文档签字；壳层可导航；SAF/Keystore 单测通过 |
| P2 垂直切片 | W3–W4 | 一条端到端链路跑通 | 上述四人 + lane-reader | 真机 10 步 e2e 通过；冒烟脚本可重复 |
| P3 四路并行 | W5–W7 | 首页/阅读/我的/写作四条 lane 完成 | 4 lane + ui-foundation 支持 | 每条 lane 验收清单全绿；无 P0/P1 缺陷 |
| P4 集成加固 | W8 | 设备矩阵、性能、离线、权限、回归 | verifier、lead、各 lane 修复 | 全量验收 + 真机矩阵通过；无阻塞缺陷 |
| P5 Beta | W9 | 签名 APK、发布说明、回滚 | release、lead、verifier | 签名包可安装；发布清单签字 |

### P0 风险验证（W1，5 路并行，8 agent-day）

| Spike | 问题 | 负责 | 产出 |
|---|---|---|---|
| S1 工具链 | Tauri 2 + Android SDK/NDK/JDK 能否稳定构建；CI 能否出 APK | android-shell + release | hello APK、CI job、构建说明 |
| S2 系统行为 | 返回手势、安全区、IME/`visualViewport`、旋转/分屏 | ui-foundation + android-shell | 行为录屏、返回栈原型、insets 方案 |
| S3 文件 | SAF 选目录/导入/导出、私有目录、路径与 `assert_inside` 的冲突 | platform-ports | `SAFFileStore` 原型 + 单测；结论：私有目录/SAF 取舍 |
| S4 安全与系统集成 | Keystore 存 token、权限申请、通知通道、深链 | platform-ports + android-shell | `AndroidSecretStore` 原型、权限矩阵 |
| S5 渲染与媒体 | WebView 下 markdown/KaTeX/rquickjs NDK、iframe 媒体、图片缓存协议 | lane-reader + verifier | 渲染对照截图、性能数据、阻塞清单 |

P0 出口：hello APK 在至少 2 台真机（不同 OEM/Android 版本）安装启动；每个 spike 给出“可行/需替代方案/不可行”；lead 据此决定是否调整技术路线（例如 Tauri Android 阻塞时，评估 Kotlin 壳 + Rust JNI 的退路，并重估 +2–3 周）。

### P1 契约与骨架（W2，10 agent-day）

- `lead`：冻结平台契约文档（`doc/design/android-platform-contract.md`）；拆 P2 卡；确认共享文件变更单。
- `android-shell`：Manifest/权限/FileProvider/深链/通知通道/生命周期；系统返回转发到渲染层；前后台切换暂停同步。
- `platform-ports`：SAF/私有目录 FileStore、Keystore SecretStore、Android Platform（通知、网络状态、版本）、路径策略；端口单测用 testkit。
- `ui-foundation`：底部导航 + 一级页签 pager + 返回栈 + 抽屉 + 安全区 + 登录/协议壳；首页/我的/写作/消息/设置空壳可切换。
- `verifier`：只读评审契约与代码，准备真机清单。

出口：契约冻结；壳层可在真机导航；SAF/Keystore 单测通过；`cargo clippy` 与 `tsc` 全绿。

### P2 垂直切片（W3–W4，12 agent-day）

链路：启动 → 协议 → 首页推荐 → 文章页 → 文章栏（目录）→ 登录（覆盖层）→ 我的动态 → 返回。

- `ui-foundation`：返回栈覆盖首页/文章/我的；冷启动与深链栈底补全。
- `lane-reader`：文章页包装、正文渲染、图片缓存、iframe 媒体、底部操作条、评审入口。
- `lane-user`：我的壳、登录引导、动态列表。
- `android-shell`：返回键与手势联调；深链联调。
- `release`：CI 产出 debug APK 并上传 artifact。
- `verifier`：真机 10 步 e2e；记录首屏时间、内存、崩溃。

出口：10 步链路在 2 台真机通过；冒烟脚本可重复执行；无 P0 缺陷。

### P3 四路并行（W5–W7，24 agent-day）

| Lane | 范围 | 关键验收 |
|---|---|---|
| A `lane-home` | 推荐、活动（红点）、连载、作品库（动态分类+兜底）、搜索四类结果、搜索态推荐/精选 | 首页 4 页签可滑/可点；搜索返回恢复位置；活动红点正确 |
| B `lane-reader` | 目录/评论/评审抽屉、评分、投币/点赞/收藏/分享、评论加载更多 | 评审闭环可走通；媒体播放不空白；长文滚动不卡 |
| C `lane-user` | 我的 7 页签（默认动态、每次回顶部）、粉丝/关注、他人主页、消息 3 页签、私聊、历史 | 未登录引导正确；红点与已读同桌面；他人主页返回正确 |
| D `lane-writing` | 本地存档树、长按菜单、导出、草稿四态、编辑器、发布表单全屏 | 新建→编辑→保存→同步草稿→发布链路通；键盘不遮工具栏 |

规则：每条 lane 只改自己的 `features/mobile/<lane>/**`；公共组件需求提给 `ui-foundation`；桌面 feature 文件只读。W6 中做一次跨 lane 联调，W7 末 lane 冻结。

出口：每条 lane 验收清单全绿；跨 lane 无回归；性能与崩溃在预算内。

### P4 集成加固（W8，8 agent-day）

- 设备矩阵：Android 10/12/14/15，至少 2 个 OEM，360dp 与 411dp 宽，含一台低端机。
- 回归：桌面端关键路径（构建、阅读、编辑器、设置）不被复用改动破坏。
- 质量：冷启动、文章页滚动、图片缓存命中、离线阅读、弱网、权限拒绝、深链、旋转/分屏。
- 安全：token 不出现在日志/渲染层；路径穿越；导出文件不越界；WebView 不允许任意导航。
- 修复：只修 P0/P1；P2 进已知问题。

出口：验收清单与真机矩阵通过；verifier 报告签字。

### P5 Beta（W9，4 agent-day）

- 签名 APK（keystore 归 release 保管，不入库）；版本号与 `tauri.conf.json` 对齐。
- 发布说明、安装说明、已知问题、回滚方案（保留上一版 APK）。
- 内测分发；收集崩溃/日志（`renderer.log` + logcat）。
- 复盘：把 spike 结论、契约变更、坑写回文档。

出口：签名包在干净设备安装成功；release 清单签字。

## 5. 关键路径与依赖

```
S1 工具链 ─┬→ P1 壳层 ─→ P2 垂直切片 ─┬→ Lane A ─┐
S2 系统行为 ┘                          ├→ Lane B ─┤
S3 文件 ────→ P1 端口 ─────────────────┤→ Lane C ─┼→ P4 集成 → P5 Beta
S4 安全 ────┘                          └→ Lane D ─┘
S5 渲染/media ─────────────→ Lane B/D 提前排险
```

- 最长路径：S1/S3 → P1 → P2 → Lane D（编辑器）→ P4 → P5。
- Lane D 风险最高，P0 的 S5 就要覆盖编辑器 IME/工具栏；P2 期间 lane-writing 可提前做只读原型。
- 平台层（android-shell/platform-ports）是全局阻塞，P1 必须一次做对；P2 后只接受变更单。

## 6. 质量门禁

### 6.1 每次合并

`Rust实现约定.md` 的全套自检 + `tsc` + `vite build` + Android `assembleDebug`（CI）。

### 6.2 每阶段

- P0：真机安装启动 + spike 结论。
- P1：契约评审 + 端口单测 + 壳层导航录屏。
- P2：10 步 e2e + 冒烟脚本。
- P3：lane 验收清单 + 跨 lane 联调。
- P4：设备矩阵 + 安全抽查 + 桌面回归。
- P5：签名包安装 + 发布清单。

### 6.3 自动化边界

- 能自动化的：Rust 单测、TS 单测、构建、APK 安装启动、`adb` 截图、logcat 关键字、uiautomator 关键节点断言。
- 不能自动化的：IME 手感、手势冲突、媒体播放、长文滚动、权限弹窗，按 `真机验证清单.md` 人工验收并录屏。

## 7. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Tauri 2 Android 工具链/插件不成熟 | 阻塞全部 | P0 S1 先验证；准备 Kotlin 壳 + Rust JNI 退路（+2–3 周），P0 出口拍板 |
| SAF 性能差/路径语义与 `assert_inside` 冲突 | 写作/存档不可用 | 首版私有目录 + 导出；SAF 只做导入导出；P0 S3 给数据 |
| WebView IME/`visualViewport` 行为差异 | 编辑器不可用 | 真机矩阵早测；工具栏用 insets 方案；必要时原生输入桥 |
| rquickjs/KaTeX 在 Android 失败 | markdown/公式不对等 | S5 提前验证；失败则服务端/预编译兜底，保功能不保逐字节 |
| iframe 媒体被拦或空白 | 阅读体验缺失 | 复用桌面白名单；失败则“在浏览器打开”降级 |
| 低端机性能/内存 | 崩溃、卡顿 | P2 起每阶段测低端机；图片缓存限内存；长列表虚拟化 |
| 多 agent 合并冲突 | 拖慢集成 | worktree + 写域 + 单写者 + 每日集成窗口；冲突两次即缩域 |
| 签名/分发 | 无法安装 | release 提前管 keystore；每版留上一版权回滚 |
| 无本地 Android 设备/模拟器 | 验证不足 | CI emulator + 至少 2 台真机；verifier 统一保管测试机 |

## 8. 智能体启动包

每个 agent 启动时只拿四样东西，避免上下文污染：

1. 角色卡：职责、写域、不做什么（本文件 §2）。
2. 任务卡：当前一张，含必读、产出、验收（§3.1）。
3. 基线：`doc/design/androw-design.md`、`doc/design/Rust实现约定.md`、相关源码路径。
4. 规则：worktree、单写者、合并门禁、报告格式。

报告格式（每次交付）：

```
task: AND-Px-yy
status: done | blocked | partial
changed: <文件列表>
verified: <执行的命令与结果>
evidence: <截图/日志/录屏路径>
next: <下一步或阻塞点>
```

## 9. 需拍板的事项

1. **minSdk**：按 Tauri 2 模板默认（暂定 24），是否提高到 26（WebView/通知行为更可控）。
2. **分发**：只内部 APK，还是同时准备应用市场包（不含合规上架）。
3. **通知**：首版只做本地未读红点，还是接服务端推送。
4. **平板/折叠屏**：v2 是否排在 Beta 之后立即启动。
5. **签名 keystore**：由谁保管、是否进 CI secret。
6. **真机**：团队现有设备型号/Android 版本，能否覆盖 2 个 OEM + 1 台低端机。

以上 6 项不影响 W1 的 P0 启动；第 1、5、6 项需在 P0 出口前定。