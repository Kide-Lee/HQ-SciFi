# 主进程子系统设计

> 本文件是 `doc/design-1.md` 的子系统文档之一，描述主进程各子系统的职责、现状、目标模块与关键设计点。

## 1. 启动与窗口子系统

### 职责
- 单实例锁、测试模式、硬件加速、平台开关。
- 启动编排：加载 API 配置 → 初始化数据库 → 注册图片协议 → 注册 IPC → 创建窗口。
- 窗口安全策略、无边框自绘、外部链接处理、开发者工具快捷键、焦点与输入法兼容。

### 现状
- `src/main/index.ts`、`src/main/window.ts`。

### 目标模块
- `main/bootstrap/`
- `main/window/`

### 关键设计点
- 启动编排独立成 `bootstrap/`，可读、可测、可替换。
- `window/` 只关心窗口行为，不关心业务。
- 保留现有的 fail-fast 与启动会话校验。

---

## 2. 认证与会话子系统

### 职责
- 账号密码登录、会话恢复、logout。
- token 安全存储（safeStorage），token 不下发渲染层。
- 启动/运行时会话有效性校验。

### 现状
- `src/main/auth.ts`、`src/main/session.ts`。

### 目标模块
- `main/services/auth-service.ts`
- `main/infra/session.ts`

### 关键设计点
- 渲染层只能感知 `UserSession`（不含 token）。
- 服务端明确失效才清会话；网络异常不误登出。
- 相关 IPC：`auth:*`。

---

## 3. 本地存档子系统

### 职责
- 本地存档根目录管理、路径安全。
- 读取/写入/新建/删除/重命名/移动 md 文件与目录。
- 本地文件树、文件信息（mtime/字数/摘要）生成。
- 移动/重命名时更新本地路径、保留远端关联，并让 `.image` 目录随动。

### 现状
- `src/main/fs.ts`。

### 目标模块
- `main/services/docs-service.ts`
- `main/infra/fs.ts`

### 关键设计点
- 所有文件路径经 `assertInside`。
- 文档正文以 md 文件存储，SQLite 不存正文。
- 重命名/移动：更新 `ArticleRow.filePath`，保留远端 `cid`/状态关联，并同步移动 `.image` 目录。
- 相关 IPC：`docs:*`、`files:*`。

---

## 4. 同步子系统

### 职责
- 拉取远端草稿/待审核/已发布/已拒绝并落盘。
- 推送本地文件到草稿。
- 发布与发布表单参数；发布成功后本地状态标记为待审核。
- 远端文章转存为草稿、编辑远端文章。
- 冲突检测：本地已修改时保留本地不回写远端，并提供冲突列表。

### 现状
- `src/main/sync.ts`。

### 目标模块
- `main/services/sync-service.ts`

### 关键设计点
- 同步逻辑与 API 细节分离：adapter 管接口，service 管流程和状态。
- 四态拉取参数、md↔HTML 转换、图片随文同步等规则集中管理。
- 相关 IPC：`sync:*`。

---

## 5. 文章/阅读子系统

### 职责
- 文章列表拉取（contentsList / selectContents / choiceList）。
- 文章详情拉取与字段规整。
- 列表补全、摘要/媒体标记剥离、正文净化材料准备。

### 现状
- `src/main/read.ts`（部分）。

### 目标模块
- `main/adapters/article.adapter.ts`
- `main/services/read-service.ts`

### 关键设计点
- 适配器负责接口路径、分页、字段规整。
- 服务层负责“该列表是否需要匿名/评分隔离/脱敏”等业务规则。
- 相关 IPC：`read:list`、`read:article`、`read:search`。

---

## 6. 评审子系统

### 职责
- 评审列表、我的评审、评审任务。
- 提交/编辑评审、评审态度。
- 活动期评分隔离与匿名规则。

### 现状
- `src/main/read.ts`（部分）、`src/main/activity-rules.ts`。

### 目标模块
- `main/adapters/review.adapter.ts`
- `main/services/review-service.ts`
- `main/domain/activity-rules.ts`

### 关键设计点
- 五维评分/评语的数据映射集中。
- 评审与文章、活动、用户、评论的关联在 service 层组装。
- 相关 IPC：`review:*`。

---

## 7. 评论与互动子系统

### 职责
- 评论列表、发表评论、回复评审评论。
- 点赞/收藏/投币、收藏状态、取消收藏。
- 全局搜索评论、最新评论流。

### 现状
- `src/main/read.ts`（部分）、`src/main/comment-request.ts`。

### 目标模块
- `main/adapters/comment.adapter.ts`
- `main/services/comment-service.ts`

### 关键设计点
- 评论与评审的关联（`reviewid`）由 adapter/service 统一处理。
- 活动期评论脱敏规则与文章匿名规则在 domain 层。
- 相关 IPC：`comment:*`、`interact:*`。

---

## 8. 用户子系统

### 职责
- 用户资料、用户统计、关注/取关、粉丝/关注列表。
- 用户文章/评审/评论列表、动态、收藏。
- 签到、个人资料编辑、私聊入口。

### 现状
- `src/main/user.ts`、`src/main/chat.ts`。

### 目标模块
- `main/adapters/user.adapter.ts`
- `main/services/user-service.ts`
- `main/adapters/chat.adapter.ts`
- `main/services/chat-service.ts`

### 关键设计点
- 用户页涉及的列表与阅读/评审/评论复用同一 adapter 能力，避免重复实现。
- token 相关参数只在 adapter 层出现。
- 相关 IPC：`user:*`、`chat:*`。

---

## 9. 通知与消息子系统

### 职责
- 未读数、收件箱、标记已读。
- 通知红点与消息中心。
- 私聊会话与消息。

### 现状
- `src/main/notify.ts`、`src/main/chat.ts`。

### 目标模块
- `main/adapters/notify.adapter.ts`
- `main/services/notify-service.ts`
- `main/adapters/chat.adapter.ts`、`main/services/chat-service.ts`

### 关键设计点
- 通知按类别区分（评论/评审/财务/系统/粉丝/私聊）。
- 未读定时刷新、窗口聚焦刷新属于 service 层。
- 相关 IPC：`notify:*`、`chat:*`。

---

## 10. 设置与更新子系统

### 职责
- 主进程设置持久化（硬件加速、缩放、自定义 CSS/JS、自动更新）。
- 更新检查、下载、安装、更新状态推送。
- 清除缓存、卸载入口。

### 现状
- `src/main/settings.ts`、`src/main/updater.ts`。

### 目标模块
- `main/services/settings-service.ts`
- `main/services/updater-service.ts`
- `main/infra/updater.ts`

### 关键设计点
- 设置按“主进程持久化”和“渲染层 UI 外观（localStorage）”明确分层。
- 自定义 CSS/JS 注入在窗口层完成，但设置数据由 service 管理。
- 相关 IPC：`settings:*`、`update:*`。

---

## 11. 图片与媒体子系统

### 职责
- 图片缓存协议。
- 图片随文下载、上传。
- md↔HTML 转换中的媒体标签处理。

### 现状
- `src/main/imgcache.ts`、`src/main/md2html.ts`。

### 目标模块
- `main/infra/media/`
- `main/services/media-service.ts`

### 关键设计点
- 缓存目录、协议注册、清除缓存集中。
- 上传接口集中在 API 适配器。
- 相关 IPC：`media:*`。

---

## 12. API 配置与请求基础子系统

### 职责
- 加载并校验 `api.config.json`。
- 统一请求、响应 envelope、分页、错误码、限流重试。
- 提供 `endpoint(name)` 与 `apiBaseUrl()`。

### 现状
- `src/main/net/api.ts`、`src/main/net/apiconfig.ts`。

### 目标模块
- `main/infra/net/`

### 关键设计点
- 代码不硬编码接口路径。
- 新增接口需同时更新配置与必需端点清单。
- GET/POST 参数差异统一由请求层处理。

---

## 13. 数据库索引子系统

### 职责
- better-sqlite3 初始化与迁移。
- 文章元数据、meta、读缓存等表的读写。
- 清理索引与缓存。

### 现状
- `src/main/db.ts`。

### 目标模块
- `main/infra/db/`

### 关键设计点
- 只存元数据，不存正文。
- 表结构变更需有迁移策略。
- 相关 IPC：`articles:*`。

---

## 14. 业务规则域

### 职责
- 活动期文章/评审评分隔离、匿名脱敏。
- 进行中/评审中活动的状态判定。
- 文章分类评审禁用规则。

### 现状
- `src/main/activity-rules.ts`。

### 目标模块
- `main/domain/activity-rules.ts`

### 关键设计点
- 纯函数/纯规则，可单测。
- 不依赖 Electron、不直接依赖 API。
- 被 `services` 与 `adapters` 引用。
