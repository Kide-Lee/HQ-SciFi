import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgreementData,
  ApiResult,
  AppNotification,
  ChatMessage,
  ArticleDetail,
  ArticleListOptions,
  ArticleRow,
  ClockResult,
  CommentItem,
  CommentListResult,
  CommentSubmitResult,
  ConvertDraftResult,
  EditRemoteResult,
  FollowFeedItem,
  GptModel,
  LocalNode,
  LoginResult,
  LogOpResult,
  MarkStatus,
  MetaInfo,
  PullResult,
  PushResult,
  RemoteArticle,
  ReviewItem,
  ReviewPayload,
  ReviewSubmitResult,
  ReviewTaskItem,
  SelfStatus,
  UserFollowItem,
  UserMarkItem,
  UserProfile,
  UserSearchResult,
  UserSession,
  UserStats
} from '../shared/types'
import type { ArticleMeta } from '../shared/frontmatter'

/**
 * 暴露给渲染进程的白名单 API（window.hqsf）。
 * 渲染层唯一入口：不暴露 ipcRenderer 本体，杜绝任意 IPC。
 * 约定：认证/同步/文件/索引类均返回 ApiResult（{ ok:true, data } | { ok:false, error }）；
 * ping/getAppInfo 为 M0 保留的裸值接口。token 不经过本层下发，只留在主进程。
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('hqsf:ping'),
  getAppInfo: (): Promise<{ version: string; platform: string; arch: string; packaged: boolean }> =>
    ipcRenderer.invoke('hqsf:get-app-info'),
  copyText: (text: string): Promise<ApiResult<null>> => ipcRenderer.invoke('hqsf:copy-text', text),
  /** 原生消息弹窗（替代渲染层 alert/confirm，避免 Electron 弹窗后输入框失焦的已知问题） */
  showMessageBox: (options: {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning'
    title?: string
    message: string
    detail?: string
    buttons?: string[]
    cancelId?: number
    defaultId?: number
  }): Promise<ApiResult<{ response: number }>> => ipcRenderer.invoke('hqsf:show-message-box', options),
  // ---- 消息中心（v0.0.9：真实收件箱 API） ----
  listNotifications: (): Promise<ApiResult<{ items: AppNotification[]; totalUnread: number }>> =>
    ipcRenderer.invoke('hqsf:list-notifications'),
  getUnreadCount: (): Promise<ApiResult<{ total: number }>> => ipcRenderer.invoke('hqsf:get-unread-count'),
  markNotificationsRead: (categories: string[]): Promise<ApiResult<null>> =>
    ipcRenderer.invoke('hqsf:mark-notifications-read', categories),
  // ---- 全局搜索（作品库首页） ----
  searchComments: (keyword: string, limit?: number): Promise<ApiResult<{ items: CommentItem[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:search-comments', keyword, limit),
  searchReviews: (keyword: string, limit?: number): Promise<ApiResult<{ items: ReviewItem[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:search-reviews', keyword, limit),
  searchUsers: (keyword: string, limit?: number): Promise<ApiResult<{ items: UserSearchResult[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:search-users', keyword, limit),
  // ---- 私聊（hqChat/） ----
  getPrivateChat: (touid: number | string): Promise<ApiResult<{ chatid: string }>> =>
    ipcRenderer.invoke('hqsf:get-private-chat', touid),
  listChatMessages: (chatid: string): Promise<ApiResult<{ items: ChatMessage[] }>> =>
    ipcRenderer.invoke('hqsf:list-chat-messages', chatid),
  sendChatMessage: (chatid: string, msg: string): Promise<ApiResult<null>> =>
    ipcRenderer.invoke('hqsf:send-chat-message', chatid, msg),

  // ---- 用户协议（登录前须阅读并同意） ----
  getAgreement: (): Promise<ApiResult<AgreementData>> => ipcRenderer.invoke('hqsf:get-agreement'),
  /** 荒启平台用户协议（网络抓取；失败时渲染层禁用勾选） */
  getHuangqiAgreement: (): Promise<ApiResult<{ html: string }>> => ipcRenderer.invoke('hqsf:get-huangqi-agreement'),

  // ---- 窗口控制（v0.0.3 无边框窗口自绘顶栏；裸值接口，失败静默） ----
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke('hqsf:window-minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('hqsf:window-maximize-toggle'),
    close: (): Promise<void> => ipcRenderer.invoke('hqsf:window-close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('hqsf:window-is-maximized'),
    /** 订阅最大化状态变化，返回取消订阅函数 */
    onMaximizedChanged: (cb: (max: boolean) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, max: boolean): void => cb(max)
      ipcRenderer.on('hqsf:window-maximized-changed', listener)
      return () => ipcRenderer.removeListener('hqsf:window-maximized-changed', listener)
    }
  },

  // ---- 认证 ----
  loginPassword: (name: string, password: string): Promise<ApiResult<LoginResult>> =>
    ipcRenderer.invoke('hqsf:login-password', name, password),
  getSession: (): Promise<ApiResult<UserSession | null>> => ipcRenderer.invoke('hqsf:get-session'),
  verifySession: (): Promise<ApiResult<{ valid: boolean; reachable: boolean }>> =>
    ipcRenderer.invoke('hqsf:verify-session'),
  logout: (): Promise<ApiResult<null>> => ipcRenderer.invoke('hqsf:logout'),

  // ---- 同步 ----
  syncPull: (): Promise<ApiResult<PullResult>> => ipcRenderer.invoke('hqsf:sync-pull'),
  syncPush: (filePath: string, isDraft: boolean, meta?: ArticleMeta): Promise<ApiResult<PushResult>> =>
    ipcRenderer.invoke('hqsf:sync-push', filePath, isDraft, meta),
  /** 远端文章转存为草稿（服务端处理；converted=false=原本就是草稿） */
  convertToDraft: (cid: string): Promise<ApiResult<ConvertDraftResult>> =>
    ipcRenderer.invoke('hqsf:convert-to-draft', cid),
  /** 编辑远端文章：非草稿先转存草稿（服务端），再同步到本地存档并返回本地文件路径 */
  editRemoteArticle: (cid: string): Promise<ApiResult<EditRemoteResult>> =>
    ipcRenderer.invoke('hqsf:edit-remote-article', cid),

  // ---- 本地存档 ----
  getDocsRoot: (): Promise<ApiResult<string>> => ipcRenderer.invoke('hqsf:get-docs-root'),
  openDocsDir: (): Promise<ApiResult<null>> => ipcRenderer.invoke('hqsf:open-docs-dir'),
  listLocalDocs: (): Promise<ApiResult<LocalNode[]>> => ipcRenderer.invoke('hqsf:list-local-docs'),
  readLocalFile: (path: string): Promise<ApiResult<string>> => ipcRenderer.invoke('hqsf:read-local-file', path),
  /** 本地文件是否存在（侧栏打开远端索引项时校验；路径越界按不存在处理） */
  fileExists: (path: string): Promise<ApiResult<boolean>> => ipcRenderer.invoke('hqsf:file-exists', path),
  writeLocalFile: (path: string, content: string): Promise<ApiResult<null>> =>
    ipcRenderer.invoke('hqsf:write-local-file', path, content),
  createLocalDraft: (title: string, content: string, dirRel?: string): Promise<ApiResult<string>> =>
    ipcRenderer.invoke('hqsf:create-local-draft', title, content, dirRel),
  /** v0.0.6：新建本地文件夹（相对存档根） */
  createLocalDir: (rel: string): Promise<ApiResult<string>> => ipcRenderer.invoke('hqsf:create-local-dir', rel),
  /** v0.0.6：删除本地文章文件（含二次确认由渲染层负责） */
  deleteLocalDoc: (path: string): Promise<ApiResult<null>> => ipcRenderer.invoke('hqsf:delete-local-file', path),
  chooseDocsDir: (): Promise<ApiResult<string | null>> => ipcRenderer.invoke('hqsf:choose-docs-dir'),

  // ---- 四态索引 ----
  listArticles: (): Promise<ApiResult<ArticleRow[]>> => ipcRenderer.invoke('hqsf:list-articles'),

  // ---- 阅读（M2） ----
  listRemoteArticles: (opts?: ArticleListOptions): Promise<ApiResult<{ items: RemoteArticle[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:list-remote-articles', opts),
  getRemoteArticle: (cid: string): Promise<ApiResult<ArticleDetail>> =>
    ipcRenderer.invoke('hqsf:get-remote-article', cid),

  // ---- 评审（M2） ----
  listReviews: (opts?: { cid?: string; activeid?: number | string; limit?: number; page?: number; order?: string }): Promise<
    ApiResult<{ items: ReviewItem[]; total: number }>
  > => ipcRenderer.invoke('hqsf:list-reviews', opts),
  submitReview: (payload: ReviewPayload): Promise<ApiResult<ReviewSubmitResult>> =>
    ipcRenderer.invoke('hqsf:submit-review', payload),
  setReviewAttitude: (reviewId: number | string, type: number): Promise<ApiResult<ReviewSubmitResult>> =>
    ipcRenderer.invoke('hqsf:set-review-attitude', reviewId, type),
  listCategories: (): Promise<
    ApiResult<Array<{ mid: number | string; name: string; slug: string; description?: string; imgurl?: string; count?: number }>>
  > =>
    ipcRenderer.invoke('hqsf:list-categories'),

  // ---- 内容浏览（M3） ----
  /** metas 栏目条目（type=serial/collection/active/tag 等，连载/活动树） */
  listMetas: (type: string): Promise<ApiResult<MetaInfo[]>> => ipcRenderer.invoke('hqsf:list-metas', type),
  /** 违禁词检测（官方接口，付费 5 能量币/次）：返回服务端检测结果 { code, msg } */
  checkForbidden: (title: string, text: string): Promise<ApiResult<{ code: number; msg: string }>> =>
    ipcRenderer.invoke('hqsf:check-forbidden', title, text),
  /** AI 模型列表（推荐栏目「AI模型」） */
  listGptModels: (): Promise<ApiResult<GptModel[]>> => ipcRenderer.invoke('hqsf:list-gpt-models'),
  /** 当前账号的评审任务（待评审/已完成文章列表） */
  listReviewTasks: (): Promise<ApiResult<ReviewTaskItem[]>> => ipcRenderer.invoke('hqsf:list-review-tasks'),
  /** v0.0.7：当前账号写过的全部评审（「已评审」徽章数据源，按会话 uid） */
  listMyReviews: (): Promise<ApiResult<{ cids: string[] }>> => ipcRenderer.invoke('hqsf:list-my-reviews'),

  // ---- 用户系统（v0.0.8） ----
  /** 用户资料（公开；key=uid） */
  getUserProfile: (uid: string | number): Promise<ApiResult<UserProfile>> =>
    ipcRenderer.invoke('hqsf:user-profile', uid),
  /** 用户计数（需登录；未登录返回 data:null） */
  getUserStats: (uid: string | number): Promise<ApiResult<UserStats | null>> =>
    ipcRenderer.invoke('hqsf:user-stats', uid),
  /** 当前账号状态（能量币/经验/等级） */
  getSelfStatus: (): Promise<ApiResult<SelfStatus | null>> => ipcRenderer.invoke('hqsf:user-self-status'),
  /** 是否已关注目标用户 */
  getFollowState: (uid: string | number): Promise<ApiResult<boolean>> =>
    ipcRenderer.invoke('hqsf:user-follow-state', uid),
  /** 关注/取关（follow true=关注 false=取关） */
  followUser: (uid: string | number, follow: boolean): Promise<ApiResult<{ ok: boolean; error?: string }>> =>
    ipcRenderer.invoke('hqsf:user-follow', uid, follow),
  /** 关注列表（uid=目标用户） */
  listFollows: (uid: string | number, page?: number, limit?: number): Promise<ApiResult<{ items: UserFollowItem[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:user-follow-list', uid, page, limit),
  /** 粉丝列表（touid=目标用户） */
  listFans: (uid: string | number, page?: number, limit?: number): Promise<ApiResult<{ items: UserFollowItem[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:user-fan-list', uid, page, limit),
  /** 我的收藏 */
  listMarks: (page?: number, limit?: number): Promise<ApiResult<{ items: UserMarkItem[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:user-marks', page, limit),
  /** 用户发表的文章 */
  listUserArticles: (uid: string | number, page?: number, limit?: number): Promise<ApiResult<{ items: RemoteArticle[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:user-articles', uid, page, limit),
  /** 用户发表的评审 */
  listUserReviews: (uid: string | number, page?: number, limit?: number): Promise<ApiResult<{ items: ReviewItem[]; total: number }>> =>
    ipcRenderer.invoke('hqsf:user-reviews', uid, page, limit),
  /** 用户发表的评论 */
  listUserComments: (uid: string | number, page?: number, limit?: number): Promise<ApiResult<CommentListResult>> =>
    ipcRenderer.invoke('hqsf:user-comments', uid, page, limit),
  /** 关注动态聚合（仅本人） */
  listFollowFeed: (): Promise<ApiResult<FollowFeedItem[]>> => ipcRenderer.invoke('hqsf:user-feed'),
  /** 签到（addLog type=clock） */
  clockIn: (): Promise<ApiResult<ClockResult>> => ipcRenderer.invoke('hqsf:user-clock'),

  // ---- 评论（阅读视图评论区） ----
  /** 文章评论列表（hqComments/commentsList） */
  listComments: (cid: string, opts?: { limit?: number; page?: number; order?: string }): Promise<
    ApiResult<CommentListResult>
  > => ipcRenderer.invoke('hqsf:list-comments', cid, opts),
  /** v0.0.8：全局最新评论流（不带 cid，首页「最新讨论」用） */
  listRecentComments: (opts?: { limit?: number; page?: number; order?: string }): Promise<
    ApiResult<{ items: CommentItem[]; total: number }>
  > => ipcRenderer.invoke('hqsf:list-recent-comments', opts),
  /** 发表评论（parent 为回复的上级评论 coid；reviewid 为关联评审 id，可省略） */
  addComment: (payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }): Promise<
    ApiResult<CommentSubmitResult>
  > => ipcRenderer.invoke('hqsf:add-comment', payload),

  // ---- 用户互动（点赞 / 收藏 / 投币，hqUserlog/） ----
  /** 点赞（likes，每日一次）/ 收藏（mark）/ 投币（reward，需 num 积分） */
  addLog: (type: 'likes' | 'mark' | 'reward', params: Record<string, unknown>): Promise<ApiResult<LogOpResult>> =>
    ipcRenderer.invoke('hqsf:add-log', type, params),
  /** 查询文章收藏状态（返回 marked/logid） */
  isMark: (cid: string): Promise<ApiResult<MarkStatus>> => ipcRenderer.invoke('hqsf:is-mark', cid),
  /** 取消收藏（key=isMark 返回的 logid） */
  removeLog: (key: number | string): Promise<ApiResult<LogOpResult>> => ipcRenderer.invoke('hqsf:remove-log', key),

  // ---- v0.0.6：编辑器插入媒体 ----
  /** 弹系统文件框选图片并上传荒启（upload/full），返回图片 URL；取消返回 data: null */
  pickUploadImage: (): Promise<ApiResult<{ url: string } | null>> => ipcRenderer.invoke('media:pick-upload-image')
}

export type HqsfApi = typeof api

contextBridge.exposeInMainWorld('hqsf', api)
