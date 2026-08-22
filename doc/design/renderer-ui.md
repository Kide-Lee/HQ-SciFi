# 渲染层重要 UI 组件设计

> 本文件是 `doc/design-1.md` 的子系统文档之一，描述渲染层的通用 UI 组件与各 feature 重要组件的设计。

## 1. 通用 UI 组件

### 1.1 概述

- 通用 UI 组件是跨多个 feature 复用、语义稳定、不承载具体业务取数的展示/交互基座。
- “卡片”是其中一类；此外还包括反馈与占位、图像与媒体、用户身份、弹窗/模态、列表通用件、表单控件等。
- 判断标准：同一个组件被两个以上 feature 使用时，才抽到通用层；只在单个 feature 内使用的组件保留在对应 feature，不强行通用化。
- 目标目录：`renderer/src/components/` 下按职能分目录，例如 `cards/`、`feedback/`、`media/`、`user/`、`modal/`、`list/`、`form/`、`common/`。

### 1.2 卡片体系

#### 定位
- 应用各界面通用的信息承载体，用于展示文章、评审、评论、用户、活动、栏目、AI 模型、通知、私聊会话等。
- 卡片不仅是展示组件，也承担大量核心交互：进入文章/评审/评论、进入用户页、回复/评论、关注/私聊、态度表态、编辑评审、标记已读等。
- 目标是把卡片视觉与交互语义统一起来：统一封面兜底、统一评分/排名/徽章规则、统一用户身份与匿名规则，避免各页面样式漂移。

#### 现状
| 卡片类型 | 现状位置 | 说明 |
| --- | --- | --- |
| 文章卡片 | `ArticleListView.tsx` 的 `ArticleCard` | 列表/栏目首页/用户页/收藏/动态共用，含封面、摘要、作者、统计、评分、排名、任务/已评审徽章 |
| 评审摘要卡 | `FeedCards.tsx` 的 `ReviewFeedCard` | 推荐首页「最新评审」、用户页、通知中心共用，点击进入对应文章评审，支持评论入口 |
| 评论摘要卡 | `FeedCards.tsx` 的 `CommentFeedCard` | 推荐首页「最新讨论」、用户页、通知中心共用，支持回复入口与评审讨论标识 |
| 完整评审卡 | `ReaderView.tsx` 的 `ReviewItemCard` | 阅读页评审面板，展示五维评分/评语、态度、内嵌评论、我的评审编辑 |
| 完整评论卡 | `ReaderComments.tsx` 的 `CommentCard` | 评论区/评审内嵌评论，支持楼中楼、父评论引用单行省略、回复 |
| 用户/粉丝卡 | `UserView.tsx` 的 `user-follow-card` | 用户页粉丝/关注列表，含进入主页、关注/取关、私聊 |
| 活动卡 | `ActivityHome.tsx` 的 `activity-card` | 活动列表，含封面、状态徽章、描述、统计信息 |
| 栏目/合集卡 | `SerialHome.tsx` 的 `meta-card` | 连载/合集入口，含封面、名称、描述、数量 |
| AI 模型卡 | `GptListView.tsx` 的 `gpt-card` | 推荐栏目 AI 模型卡片 |
| 私聊会话卡 | `NotificationPanel.tsx` 的 `ChatSessionCard` | 消息中心私聊会话，含未读状态 |
| 左栏用户卡 | `Sidebar.tsx` 的 `user-card` | 左栏用户头像/昵称/签到/登录入口 |

#### 目标模块
- `renderer/src/components/cards/`：通用、跨 feature 的展示卡片，如 `ArticleCard`、`ReviewFeedCard`、`CommentFeedCard`、`MetaCard`、`ActivityCard`、`GptCard`、`UserFollowCard`。
- `renderer/src/features/reader/cards/`：阅读页专属的 `ReviewItemCard`、`CommentCard`、`ReviewInlineComments`。
- `renderer/src/features/navigation/cards/`：左栏用户卡 `UserCard`。
- `renderer/src/features/notifications/cards/`：通知类卡片与 `ChatSessionCard`。

#### 关键交互与状态
- **文章卡片**：点击进入阅读；作者头像/名称可进入用户页；任务徽章（待评审/已评审）；榜单排名与并列名次；评分隔离（进行中/评审中活动、分类禁用评审）；封面失败兜底；统一高度。
- **评审卡片**：点击进入对应文章评审；评者头像可进入用户页；态度（开心/有用/认真）；评论数；我的评审可编辑/隐藏评分；活动期不暴露评分；匿名规则。
- **评论卡片**：回复；父评论引用单行省略；楼中楼；匿名作者脱敏；头像用户页。
- **用户卡片**：进入用户页、关注/取关、私聊。
- **活动/栏目卡**：点击打开对应文章列表/合集；状态徽章；封面/统计信息。
- **公共能力**：`CoverImage` 统一封面加载失败占位；`cachedImageUrl` 统一图片缓存协议；`UserLevelBadge` 统一等级样式；`userDisplayName`、`anonymousAuthorDisplayName`、`scoreColor`、`formatTs`、`formatSize` 统一展示语义。
- **重构要点**：统一 props 约定；纯计算逻辑抽到 `lib/` 或卡片工具函数；卡片保持“纯展示 + 回调”；骨架屏与真实卡片同构。

### 1.3 反馈与占位组件

#### 定位
- 覆盖加载中、加载失败、空结果、无更多数据、无摘要等状态。
- 与卡片/列表/页面同级，但跨页面复用。

#### 现状
- `Skeletons.tsx`：`SkeletonArticleCard`、`SkeletonFeedCard`、`SkeletonActivityCard`、`SkeletonMetaCard`、`SkeletonGptCard`、`SkeletonReader`、`SkeletonComment`。
- `ErrorBanner.tsx`：错误横幅与错误文案工具 `errorHint`。
- 页面内各类空态：`app-loading`、`list-empty`、`placeholder-card`、`article-card-excerpt-none` 等。

#### 目标模块
- `renderer/src/components/feedback/`：`Skeleton`、`SkeletonArticleCard`、`ErrorBanner`、`EmptyState`、`LoadingState`。

#### 关键点
- 骨架屏应与真实内容同构，减少加载态到内容态跳动。
- 错误态需要可重试入口与稳定文案。
- 空态文案统一由组件或 lib 提供，不在各页面重复拼写。

### 1.4 图像、头像与媒体展示

#### 定位
- 封面图、用户头像、文章内媒体占位等展示能力。
- 统一图片缓存协议、懒加载、失败兜底、外链安全策略。

#### 现状
- `CoverImage.tsx`：封面加载失败占位。
- `FeedCards.tsx` 的 `FeedAvatar`：头像或昵称首字占位。
- `lib/sanitize.ts`：`cachedImageUrl`、`userAvatarUrl`。
- `lib/mediaParse.ts` / `mediaNode.ts` / `mathClick.ts`：文章媒体标签解析与交互。
- 编辑器媒体弹窗：`MusicModal`、`VideoModal`、`MathModal`。

#### 目标模块
- `renderer/src/components/media/`：`CoverImage`、`Avatar`、`MediaFallback`、`MediaRenderer`。
- `renderer/src/lib/media.ts`：媒体标签解析、缓存 URL、安全校验等纯函数。

#### 关键点
- 图片必须走缓存协议与 `referrerPolicy="no-referrer"`。
- 封面/头像失败态要有占位，不能出现破图。
- 媒体渲染负责把远端 HTML 中的音乐/视频占位展开成可交互组件，但要保持净化后无 XSS。

### 1.5 用户身份与等级

#### 定位
- 用户头像、昵称、等级、匿名规则、用户页入口等身份展示语义。
- 被文章卡、评审卡、评论卡、用户页、通知中心等多处复用。

#### 现状
- `UserLevelBadge.tsx`：等级徽章。
- `FeedCards.tsx` 的 `FeedAvatarWrap`：可点击头像进入用户页，匿名不可点。
- `lib/sanitize.ts`：`userDisplayName`、`anonymousAuthorDisplayName`。
- 各卡片/评论区中的“作者可点、匿名不可点”逻辑目前重复实现。

#### 目标模块
- `renderer/src/components/user/`：`UserAvatar`、`UserName`、`UserLevelBadge`、`UserLink`。
- `renderer/src/lib/userDisplay.ts`：用户名、匿名规则、等级计算等纯函数。

#### 关键点
- 统一“谁可以进入用户页 / 匿名不可点”的判定。
- 统一匿名规则：匿名文章作者的本人评审/评论显示「匿名用户」。
- 等级/经验展示语义一致，避免各页面样式漂移。

### 1.6 弹窗、模态与提示

#### 定位
- 应用内模态、覆盖层、确认/输入弹窗、原生消息框的通用容器与行为。
- 业务弹窗（登录、协议、设置、发布、私聊、媒体）在其 feature 内，但共用弹窗基础能力。

#### 现状
- 通用输入弹窗：`PromptModal.tsx`。
- 业务弹窗：`LoginView`、`FirstRunAgreement`、`AgreementModal`、`SettingsModal`、`PublishModal`、`PrivateChatModal`、`MusicModal`、`VideoModal`、`MathModal`。
- 原生消息桥：`window.hqsf.showMessageBox`。

#### 目标模块
- `renderer/src/components/modal/`：`Modal`（遮罩、关闭、Esc、焦点管理）、`ConfirmModal`、`PromptModal`。
- 业务弹窗保留在对应 feature，但统一使用 Modal 容器。

#### 关键点
- 避免 Electron `alert/confirm`，统一走应用内模态或原生 messageBox。
- 模态打开时应处理焦点、Esc、滚动锁定与关闭竞态。
- 登录/协议/设置等覆盖层的打开与关闭状态集中在对应 store。

### 1.7 列表通用件

#### 定位
- 列表的排序栏、筛选栏、升降序切换、空态、加载更多、无限滚动哨兵等通用能力。
- 文章列表、用户页列表、活动列表、通知列表都可能复用。

#### 现状
- `ArticleListView.tsx`：排序栏、升降序按钮、无限滚动哨兵、加载更多、空态。
- `RecommendHome`、`SerialHome`、`ActivityHome`、`LibraryHome`、`UserView`、`NotificationPanel`：各自重复排序/分页/空态样式。

#### 目标模块
- `renderer/src/components/list/`：`SortBar`、`OrderToggle`、`InfiniteScrollSentinel`、`ListPager`、`ListEmpty`。
- `renderer/src/lib/list.ts`：排序键值、并列排名、页码计算等纯函数。

#### 关键点
- 排序方向共用一个 `OrderToggle`，服务端降序为默认。
- 无限滚动使用哨兵 + 防重入，避免重复加载。
- 空态/加载更多文案统一，避免各页面各写一套。
- 榜单排名的“并列同名次”规则抽到 `lib/list.ts`，所有列表共用。

### 1.8 表单控件

#### 定位
- 输入框、自动增高 textarea、下拉、多选、开关、滑块、颜色/字体选择等表单原子组件。
- 供登录、发布、设置、评审、评论等表单复用。

#### 现状
- 自动增高输入框：`ReaderView.tsx` 中的 `ReviewGrowTextarea`。
- 评论/发布/设置表单：`ReaderComments.tsx`、`PublishModal.tsx`、`SettingsModal.tsx`、`LoginView.tsx` 内各自实现。
- 设置界面包含主题、颜色、字体、缩放、开关、自定义 CSS/JS 等控件。

#### 目标模块
- `renderer/src/components/form/`：`TextField`、`TextArea`、`AutoGrowTextArea`、`Select`、`MultiSelect`、`Toggle`、`Slider`、`ColorPicker`、`FontPicker`。
- `renderer/src/lib/form.ts`：校验、格式化、字数统计等纯函数。

#### 关键点
- 评审/评论编辑框应自动增高、不显示滚动条、不可手动调整高度。
- 发布表单的元数据字段（类型/标签/活动/公开阅读）使用统一控件。
- 设置项增多后优先复用表单控件，减少大组件继续膨胀。

---

## 2. 应用壳与导航路由

### 组件
- `App`、`MainArea`、`TopBar`、`Sidebar`。

### 定位
- 决定当前视图：写作、阅读、栏目列表、用户页。
- 管理左栏折叠/宽度、右栏开关、顶栏标题与窗口控件。

### 现状
- `App.tsx`、`MainArea.tsx`、`TopBar.tsx`、`Sidebar.tsx`。

### 目标模块
- `renderer/src/app/`
- `renderer/src/features/navigation/`

### 关键交互与状态
- 当前视图由 `ui` store 中的 `section/listContext/readingCid/userPageUid` 等驱动。
- 启动默认 `section='recommend'`，始终进入推荐首页；用户页通过用户卡/头像进入。
- 右栏状态全局共享，便于各视图唤起。
- 用户页进入/返回保留原视图状态。

---

## 3. 左栏 Sidebar

### 定位
- 五大栏目入口、用户卡、写作文件树、远端四态分组、活动树、用户页 tab 树。
- 折叠、宽度拖拽、树展开/收起、正在阅读高亮、待评审/已评审徽章。

### 现状
- `Sidebar.tsx`（879 行）。

### 目标模块
- `renderer/src/features/navigation/`

### 关键交互与状态
- 数据来源：`docs`/`reader`/`user`/`ui` stores。
- 本地存档树仅显示 md 文件与文件夹；文件/文件夹支持重命名与移动（文件树右键菜单 + 写作首页卡片菜单）。
- 重构目标是按“栏目树/写作树/活动树/用户树”拆分为子组件。
- 状态收敛到 navigation feature 内部，减少对全局 store 的依赖。

---

## 4. 顶栏 TopBar

### 定位
- 页面标题、返回按钮、窗口控制、右栏按钮、折叠按钮、编辑模式切换、通知入口。

### 现状
- `TopBar.tsx`（236 行）。

### 目标模块
- `renderer/src/features/navigation/TopBar`

### 关键交互与状态
- 窗口状态通过 preload 订阅。
- 标题与返回由当前视图上下文决定。

---

## 5. 右栏 RightPanel / 搜索面板

### 定位
- 全局右栏容器：目录、评论、评审、搜索/替换、消息。
- 支持 tab 切换、通知态切换、触发展开/收起。

### 现状
- `RightPanel.tsx`、`SearchPanel.tsx`。

### 目标模块
- `renderer/src/features/panel/`

### 关键交互与状态
- `panelOpen`、`panelTab`、`panelNotificationOnly` 全局共享。
- 搜索/替换状态（query/regex/active）跨视图保持。
- 目录/预览/搜索等 tab 由宿主视图提供。

---

## 6. 写作与编辑器

### 组件
- `EditorPane`、`EditorBar`、`MilkdownEditor`、`MilkdownToolbar`、`SplitEditor`、`EditorPreview`。

### 定位
- 可视化/源码双模式编辑。
- 自动保存、Ctrl+S、保存/同步/发布、字数统计、状态角标。
- 插入图片/音乐/视频/公式、违禁词检测。

### 现状
- `EditorPane.tsx`（590 行）、`SplitEditor.tsx`、`MilkdownEditor.tsx`、`MilkdownToolbar.tsx` 等。

### 目标模块
- `renderer/src/features/editor/`

### 关键交互与状态
- 编辑器状态由 `editor` store 管理。
- 新建草稿为纯空白。
- 媒体上传失败时保留本地占位、就地提示并允许重试。
- Milkdown/CodeMirror 作为技术细节封装在 feature 内部。
- 发布表单与元数据（类型/标签/活动/公开阅读）独立为子组件；发布后本地状态为待审核。

---

## 7. 阅读页

### 组件
- `ReaderView`、`ReaderInteractions`、`ReaderComments`、评审面板。

### 定位
- 文章正文安全渲染、元信息展示。
- 右栏目录/评论/评审一体。
- 互动按钮悬浮、投币/点赞/收藏/分享。
- 文章作者识别与匿名规则展示。

### 现状
- `ReaderView.tsx`（1,294 行）、`ReaderInteractions.tsx`、`ReaderComments.tsx`。

### 目标模块
- `renderer/src/features/reader/`

### 关键交互与状态
- 阅读页状态在 `reader` store；评论/评审子状态可下沉到 feature 局部。
- 右栏默认不打开；打开后默认进入目录/评论/评审中当前需要的位置。
- 评审面板默认显示“所有评审”；支持我的评审/编辑/态度。
- 目录生成、正文净化、媒体展开等纯逻辑放 `lib/`。
- 评审面板独立组件，支持我的评审/所有评审/编辑/态度。

---

## 8. 栏目首页与文章列表

### 组件
- `RecommendHome`、`SerialHome`、`ActivityHome`、`LibraryHome`、`ArticleListView`、`GptListView`。

### 定位
- 各栏目首页与列表页。
- 排序/分页/搜索/标签跳转/活动状态展示。
- 文章卡片统一尺寸、封面兜底、评分榜隔离。

### 现状
- `RecommendHome.tsx`（533 行）、`SerialHome.tsx`、`ActivityHome.tsx`、`LibraryHome.tsx`、`ArticleListView.tsx`（378 行）。

### 目标模块
- `renderer/src/features/browse/`

### 关键交互与状态
- 列表取数使用 `reader` store 或 browse feature 局部 store。
- 默认排序：推荐/连载/活动时间降序；作品库评分降序；无评分分类回退时间降序且不显示评分榜。
- 首页数据汇总到 store 供右栏搜索使用。
- 排序方向、分页、hasMore 等边界集中管理。

---

## 9. 用户页

### 组件
- `UserView`、用户页子页（动态/收藏/粉丝/文章/评审/评论）。

### 定位
- 用户资料展示、统计直达、关注/取关、私聊。
- 主页四栏与左栏子页导航。
- 当前用户与匿名用户的差异化展示。

### 现状
- `UserView.tsx`（710 行）。

### 目标模块
- `renderer/src/features/user/`

### 关键交互与状态
- 用户页状态在 `user` store。
- 左上头像/任意头像进入用户页。
- 子页切换、动态聚合、关注列表等拆分独立组件。

---

## 10. 登录与协议门

### 组件
- `LoginView`、`FirstRunAgreement`、`AgreementModal`。

### 定位
- 登录覆盖层模态。
- 首启协议门与荒启平台协议展示。

### 现状
- `LoginView.tsx`、`FirstRunAgreement.tsx`、`AgreementModal.tsx`。

### 目标模块
- `renderer/src/features/auth/`

### 关键交互与状态
- 登录状态在 `auth` store。
- 协议同意状态持久化在 localStorage。
- 未登录可浏览/写作，登录作为覆盖层。

---

## 11. 设置弹窗与更新横幅

### 组件
- `SettingsModal`、`UpdateBanner`。

### 定位
- 系统/界面/用户三组设置。
- 自动更新提示、检查更新、下载/安装。

### 现状
- `SettingsModal.tsx`（716 行）、`UpdateBanner.tsx`。

### 目标模块
- `renderer/src/features/settings/`

### 关键交互与状态
- UI 外观设置存 localStorage；主进程设置走 IPC。
- 布局持久化：左栏折叠/宽度、右栏开关/宽度、评审分栏比例。
- 更新状态由主进程推送，渲染层订阅。
- 设置弹窗按“系统 / 界面 / 用户”拆分为子表单组件。

---

## 12. 通知、私聊与其他弹窗

### 组件
- `NotificationPanel`、`PrivateChatModal`、`PromptModal`、`MathModal`、`MusicModal`、`VideoModal` 等。

### 定位
- 消息中心、私聊会话。
- 通用确认/输入弹窗。
- 编辑器插入媒体相关弹窗。

### 现状
- `NotificationPanel.tsx`（306 行）、`PrivateChatModal.tsx`（143 行）等。

### 目标模块
- 通知 → `renderer/src/features/notifications/`
- 私聊 → `renderer/src/features/chat/`
- 通用弹窗 → `renderer/src/components/`
- 媒体弹窗 → `renderer/src/features/editor/` 或 `components/`

### 关键交互与状态
- 通知未读数由 `notifications` store 管理。
- 私聊会话与消息由 `chat` store 管理。
- 弹窗统一走原生消息框或应用内模态，避免 Electron alert/confirm 问题。
