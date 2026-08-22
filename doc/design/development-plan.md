# 开发计划（AI 执行版）

> 本文件是 `doc/design-1.md` 的子系统文档之一，是给 AI（后续开发代理/助手）执行重构的具体计划。
> 执行原则：**重构不改变用户可见功能**；每阶段提交都必须可构建、可验证、可回滚。

---

## 1. 执行方式

1. AI 按阶段顺序执行；每个阶段完成后更新本文件中的状态勾选。
2. 每个阶段只做本文件列出的范围，不做“顺手优化”和“额外重构”。
3. 每次改动前先读取对应设计文档：
   - `architecture.md`：总体架构与目录规划
   - `main-process.md`：主进程子系统设计
   - `renderer-ui.md`：渲染层 UI 设计
   - `shared-contracts.md`：共享契约设计
   - `ipc-inventory.md`：IPC 通道清单与切分映射
   - `task-matrix.md`：现状文件 → 目标文件 → 阶段
   - `test-plan.md`：验证与回归计划
   - `decisions.md`：已确认的产品与 UX 决策
4. 每阶段完成后至少执行：
   - `npm run typecheck`
   - `npm run build`
   - 本阶段列出的回归验证项
5. 任一验证不通过，先修复再进入下一阶段；若无法在合理范围内修复，回滚到上一阶段并记录原因。

---

## 2. 全局约束

| 约束 | 说明 |
| --- | --- |
| 功能冻结 | 不改变用户可见功能、文案、交互、样式 |
| 兼容现有数据 | SQLite、settings.json、localStorage、本地存档路径、`.image` 目录格式保持不变 |
| IPC 通道兼容 | 前期保持 `window.hqsf.*` 方法名不变；通道名仅在阶段 4 统一 |
| 安全不变 | `contextIsolation/sandbox`、IPC 白名单、路径防穿越、HTML 净化、token 不下发 |
| 多平台 | Windows / Linux / macOS 及 `dev:test` 模式行为一致 |
| 产品决策 | 已确认决策以 `decisions.md` 为准；新的用户可见变更须先登记并获确认 |
| 小步提交 | 每次提交尽量只做一类改动，便于回滚 |

---

## 3. 行为基线（先建立，后续每阶段复用）

以下路径在重构各阶段都必须保持可用：

- [ ] 首次启动：协议门 → 未登录可浏览/写作。
- [ ] 登录：账号密码登录、会话恢复、退出登录。
- [ ] 写作：新建草稿 → 编辑（可视化/源码）→ 保存 → 同步到草稿 → 发布。
- [ ] 四态：草稿 / 待审核 / 已发布 / 已拒绝 在左栏与索引中正确展示。
- [ ] 阅读：推荐 / 连载 / 活动 / 作品库 栏目可浏览，文章可打开。
- [ ] 评审：打开非本人文章 → 查看所有评审 → 提交/编辑评审 → 态度表态。
- [ ] 评论：文章评论区可加载、发表、回复；评审评论可展开与回复。
- [ ] 用户：头像进入用户页，资料/关注/粉丝/文章/评审/评论/动态可查看。
- [ ] 设置：主题、字体、缩放、自定义 CSS/JS、自动更新开关、清除缓存。
- [ ] 通知与私聊：未读红点、消息中心、私聊会话可打开。
- [ ] 启动：始终进入推荐首页；已登录用户可从用户卡进入用户页。
- [ ] 文件操作：支持文件/文件夹重命名与移动；配图自动跟随；保留远端关联；入口在文件树和写作首页卡片菜单。
- [ ] 默认排序：推荐/连载/活动时间降序；作品库评分降序；无评分分类回退时间降序且不显示评分榜。
- [ ] 阅读页右栏默认不打开；评审面板默认“所有评审”。
- [ ] 发布后本地状态标记为待审核。
- [ ] 新建草稿纯空白；文件树仅显示 md 文件与文件夹。
- [ ] 媒体上传失败保留本地占位并提示错误、允许重试。
- [ ] 通知点击跳转到对应文章/评审/评论/用户页。
- [ ] 空态/错误态采用简洁文字 + 可操作按钮。
- [ ] 布局持久化：左栏折叠/宽度、右栏开关/宽度、评审分栏比例。
- [ ] 多平台：`dev:test` 模式独立运行；`build` 通过；打包脚本不回归。

---

## 4. 阶段计划

### 阶段 0：建立基线

#### 目标
- 在开始结构性重构前，先建立“行为不变”的验证基线。
- 修正文档与代码的第一处漂移（AGENTS.md 中 IPC 数量）。

#### 任务
1. [ ] 按 `decisions.md` 整理用户可见功能清单与用户可见变更登记表，补齐到本文件“行为基线”中。
2. [ ] 按 `test-plan.md` 建立可重复执行的手工/自动化验证脚本说明（可用现有 CDP 调试工具或 `dev:test`）。
3. [ ] 跑通 `npm run typecheck`、`npm run build`，记录当前基线结果。
4. [ ] 按 `ipc-inventory.md` 盘点当前 IPC：统计 `ipcMain.handle` / `window.hqsf.*` 实际数量，更新 `AGENTS.md` 与 `architecture.md`。
5. [ ] 抽取高风险纯函数（排行榜/匿名规则/评分隔离）的当前行为样本，供后续回归对照。
6. [ ] 按 `task-matrix.md` 确认旧设计文档 `design.md` 中需要迁移的条款清单。

#### 验收标准
- [ ] 行为基线清单完整覆盖主要功能路径。
- [ ] `typecheck` + `build` 通过。
- [ ] `AGENTS.md` 中的 IPC 数量与实际一致。
- [ ] 高风险纯函数有至少一份行为样本（输入/输出记录）。

#### 验证方式
- 手工/GUI 验证核心路径；`dev:test` 验证测试模式。
- 无代码结构改动，只允许文档与脚本补充。

#### 风险与回滚
- 本阶段风险低；若某验证项需要真实账号，则记录为“待正常桌面环境验证”。

---

### 阶段 1：共享契约先行

#### 目标
- 在拆 IPC 前先建立跨端契约，避免后续重复定义接口类型。

#### 任务
1. [ ] 创建 `src/shared/contracts/`，把 IPC channel 名与 Request/Response 类型集中。
2. [ ] 按 `ipc-inventory.md` 建立“现有 `window.hqsf.*` 方法名 ↔ IPC channel”对应表，并固化为共享契约。
3. [ ] 按 `task-matrix.md` 把现有 `shared/types.ts` 中的跨端领域类型迁移/整理到 `shared/domain/`，不破坏现有 import。
4. [ ] 为 preload 与主进程 handler 提供同一份契约引用（手写即可，不强制生成）。
5. [ ] 标记旧裸值接口（`ping` / `getAppInfo`）为兼容历史接口。

#### 验收标准
- [ ] `window.hqsf.*` 暴露的方法签名未变。
- [ ] `shared/contracts/` 能描述现有主要 IPC 通道。
- [ ] 主进程与 preload 都从共享契约 import 类型。
- [ ] `typecheck` + `build` 通过。

#### 验证方式
- 类型检查；抽查 preload 与 IPC handler 的类型一致性。
- 手工验证登录、同步、阅读等至少各一条路径。

#### 风险与回滚
- 风险：迁移类型可能引起大量 import 变化。
- 回滚：保留旧 `types.ts` 导出重定向（`export * from './domain/...'`），确保旧 import 不失效。

---

### 阶段 2：IPC 切分

#### 目标
- 解开 `ipc.ts` 巨石，每个领域一个 handler 文件，通道名与 `window.hqsf.*` 保持不变。

#### 任务
1. [ ] 建立 `src/main/ipc/` 目录，抽出通用 `ok` / `fail` / `trusted` 工具。
2. [ ] 按 `ipc-inventory.md` 与 `task-matrix.md` 创建领域 handler 文件：
   - `auth.handlers.ts`
   - `docs.handlers.ts`
   - `sync.handlers.ts`
   - `read.handlers.ts`（文章/评论/互动）
   - `review.handlers.ts`
   - `browse.handlers.ts`（栏目/AI/违禁词）
   - `comment.handlers.ts` / `interact.handlers.ts`
   - `user.handlers.ts`
   - `notify.handlers.ts`
   - `settings.handlers.ts` / `updater.handlers.ts`
   - `agreement.handlers.ts`
   - `system.handlers.ts` / `window.handlers.ts`
   - `chat.handlers.ts`
   - `media.handlers.ts`
3. [ ] 将 `ipc.ts` 中对应 handler 按 `task-matrix.md` 逐个迁移到新文件，迁移一个验证一个。
4. [ ] `ipc/index.ts` 只负责注册全部 handler 文件。
5. [ ] 不改变任何 channel 名与返回约定。
6. [ ] 检查所有 handler 参数校验与 `trusted` 校验是否保留。

#### 验收标准
- [ ] `ipc.ts` 不再包含业务 handler 定义（只保留注册/工具）。
- [ ] 每个领域 handler 文件职责单一。
- [ ] `window.hqsf.*` 方法名与 channel 未变。
- [ ] `typecheck` + `build` 通过。
- [ ] 至少验证登录、同步、阅读、评审、用户、设置各一条路径。

#### 验证方式
- 对比迁移前后 handler 清单；跑核心路径手工验证。
- 使用 `dev:test` 或 API mock 验证不依赖真实网络的部分。

#### 风险与回滚
- 风险：漏迁 handler 或重复注册。
- 回滚：保留原 `ipc.ts` 为备份，逐文件迁移；每个文件提交后可独立回退。

---

### 阶段 3：主进程服务化

#### 目标
- 将主进程领域逻辑与 API 适配分离，拆开 `read.ts` / `user.ts` / `sync.ts` 等大文件。

#### 任务
1. [ ] 先抽 `domain/`：把活动期评分隔离、匿名脱敏、文章/评审禁用规则移到纯函数模块。
2. [ ] 建立 `main/adapters/`：
   - `article.adapter.ts`
   - `review.adapter.ts`
   - `comment.adapter.ts`
   - `user.adapter.ts`
   - `notify.adapter.ts`
   - `chat.adapter.ts`
3. [ ] 建立 `main/services/`：
   - `read-service.ts`
   - `review-service.ts`
   - `comment-service.ts`
   - `user-service.ts`
   - `notify-service.ts`
   - `chat-service.ts`
   - `sync-service.ts`
   - `auth-service.ts` / `settings-service.ts` / `updater-service.ts`
4. [ ] 把 `read.ts` / `user.ts` / `sync.ts` 中的字段规整函数移到各自 adapter。
5. [ ] 把跨域复用工具（`num` / `str` / `normTs` 等）移到 `shared/` 或 `main/domain/utils.ts`，消除 `read.ts` ↔ `user.ts` 反向依赖。
6. [ ] IPC handler 改为调用 service，不在 handler 中写业务。
7. [ ] 保证 token 只在 adapter 层使用。
8. [ ] `docs-service` 支持文件/文件夹重命名与移动：更新本地路径、保留远端关联、`.image` 目录随动。
9. [ ] `sync-service` 发布成功后把本地索引状态标记为“待审核”。

#### 验收标准
- [ ] `read.ts` / `user.ts` / `sync.ts` 单文件行数显著下降。
- [ ] 主进程不再存在 `read.ts` 被 `user.ts` 反向依赖。
- [ ] handler 文件中没有直接 API 请求/文件读写/SQLite 操作。
- [ ] `typecheck` + `build` 通过。
- [ ] 写作闭环、阅读、评审、用户页、设置、通知等核心路径全部验证通过。

#### 验证方式
- 单元测试优先覆盖 domain 纯函数与 adapter 字段规整。
- 使用 `dev:test` / 本地 RuleApi 验证同步与发布流程。
- 真实账号验证安排在正常桌面环境。

#### 风险与回滚
- 风险：拆分时改变业务规则或字段映射。
- 回滚：每个 adapter/service 迁移独立提交；先保留旧模块作为临时包装，确认无回归后再删除。

---

### 阶段 4：渲染层 feature 化

#### 目标
- 将大组件/大 Store 按业务 feature 拆分，同时沉淀通用 UI 组件。

#### 任务
1. [ ] 按 `task-matrix.md` 先做通用 UI 组件抽取：
   - `components/feedback/`：Skeleton、EmptyState、ErrorBanner。
   - `components/media/`：CoverImage、Avatar、MediaRenderer。
   - `components/user/`：UserAvatar、UserLevelBadge、UserLink。
   - `components/modal/`：Modal、ConfirmModal、PromptModal。
   - `components/list/`：SortBar、OrderToggle、InfiniteScrollSentinel、ListPager、ListEmpty。
   - `components/form/`：AutoGrowTextArea、Select、MultiSelect、Toggle、Slider。
   - `components/cards/`：先落 ArticleCard / ReviewFeedCard / CommentFeedCard。
2. [ ] 按 `task-matrix.md` 拆分 feature：
   - `features/editor/`
   - `features/reader/`
   - `features/browse/`
   - `features/user/`
   - `features/settings/`
   - `features/auth/`
   - `features/navigation/`
   - `features/panel/`
   - `features/notifications/`
   - `features/chat/`
3. [ ] 拆分 `Sidebar` / `ReaderView` / `SettingsModal` / `UserView` 等大组件。
4. [ ] 把纯计算逻辑（排名、评分颜色、匿名规则、媒体解析、搜索）移到 `lib/`。
5. [ ] 收敛 store：跨 feature 共享的 `ui` 保留；其余按 feature 分拆或下沉。
6. [ ] 每个 feature 拆分后按 `test-plan.md` 执行对应验证项。
7. [ ] 实现 `decisions.md` 中已确认的用户可见变更：
   - 启动始终进入推荐首页，保留用户卡进入用户页。
   - 本地文件树右键菜单与写作首页卡片菜单提供重命名/移动。
   - 作品库默认评分排序；无评分分类回退时间降序且不显示评分榜。
   - 阅读页右栏默认不打开；评审面板默认“所有评审”。
   - 新建草稿纯空白；文件树仅显示 md 文件与文件夹。
   - 媒体上传失败保留占位并提示错误、允许重试。
   - 通知点击跳转到对应文章/评审/评论/用户页。
   - 空态/错误态简洁文字 + 可操作按钮。
   - 布局持久化补充右栏宽度与评审分栏比例。

#### 验收标准
- [ ] 每个 feature 内组件可独立阅读，单组件不再超 500 行（目标值，特殊情况注明）。
- [ ] 通用 UI 组件未被重复实现。
- [ ] 功能路径、交互、样式无可见变化。
- [ ] `typecheck` + `build` 通过。
- [ ] 核心路径全部人工/半自动验证通过。

#### 验证方式
- 逐 feature 验证：写作、阅读、评审、评论、用户、设置、通知、私聊。
- 对比重构前后截图（可借助现有 CDP 调试工具）。
- 检查 `window.hqsf.*` 调用点是否全部使用同一 shared contract。

#### 风险与回滚
- 风险：大组件拆分容易破坏交互时序、滚动、焦点、右栏状态。
- 回滚：拆分按 feature 小步进行；每个 feature 拆分前后都做截图/行为对比。

---

### 阶段 5：统一契约、文档收敛与质量增强

#### 目标
- 统一 IPC 命名，更新文档，补齐可复用测试与静态检查。

#### 任务
1. [ ] 按 `ipc-inventory.md` 将历史裸值接口迁到 `system:*` 命名空间（或明确标注不迁移）。
2. [ ] 统一剩余 channel 命名，并同步更新 `ipc-inventory.md`、preload 与渲染层调用点。
3. [ ] 更新 `README.md`、`AGENTS.md`、`doc/design.md` 中过时描述。
4. [ ] 将 `doc/design-1.md` 相关内容与拆分后的 `doc/design/*.md` 对齐。
5. [ ] 为 domain 纯函数、adapter 字段规整、关键 service 补齐单测。
6. [ ] 按 `test-plan.md` 为核心流程补端到端验证脚本或记录性测试。
7. [ ] 评估是否引入 lint；若引入，先小范围启用，不改行为。

#### 验收标准
- [ ] 文档中所有架构描述与代码结构一致。
- [ ] `AGENTS.md` 的 handler 数量与实际一致。
- [ ] 单测覆盖至少：活动期评分隔离、匿名规则、排名规则、文章/评审字段规整。
- [ ] `typecheck` + `build` 通过。
- [ ] 全量行为基线验证通过。

#### 风险与回滚
- 风险：统一 channel 命名会影响 preload 与渲染层大量调用点。
- 回滚：保留旧方法名兼容层一个发布周期，再删除。

---

## 5. 阶段依赖与顺序

```
阶段 0 基线 ──> 阶段 1 契约 ──> 阶段 2 IPC 切分 ──> 阶段 3 主进程服务化 ──> 阶段 4 渲染层 feature 化 ──> 阶段 5 文档与质量增强
```

- 阶段 1 必须在阶段 2 之前：契约先行，避免后续重复定义。
- 阶段 3 与阶段 4 可以部分并行，但建议先主进程后渲染层，降低 UI 侧调试成本。
- 阶段 5 的文档同步应贯穿各阶段，最后统一校对。

---

## 6. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 无自动化测试 | 回归难发现 | 阶段 0 建立行为基线；阶段 3 起补 domain/adapter 单测 |
| 外部 API 无版本承诺 | 接口变化影响重构 | 契约快照/录制回放；adapter 层集中隔离 |
| GUI 依赖真实桌面环境 | 验证受限 | 使用 `dev:test`、CDP 调试、截图对比；标注待真实环境验证项 |
| 大组件拆分引发交互回归 | 用户可见行为变化 | 小步拆分，每 feature 前后截图/行为对照 |
| 共享契约迁移引入类型爆炸 | 构建编译失败 | 保留旧类型重定向，逐文件迁移 |
| 多平台打包差异 | Windows/Linux/macOS 行为不一致 | 各阶段至少跑一个平台的 `build`；打包脚本修改单独验证 |

---

## 7. 状态跟踪

| 阶段 | 状态 | 备注 |
| --- | --- | --- |
| 阶段 0：建立基线 | 未开始 | 任务见上 |
| 阶段 1：共享契约先行 | 未开始 | |
| 阶段 2：IPC 切分 | 未开始 | |
| 阶段 3：主进程服务化 | 未开始 | |
| 阶段 4：渲染层 feature 化 | 未开始 | |
| 阶段 5：统一契约、文档收敛与质量增强 | 未开始 | |
