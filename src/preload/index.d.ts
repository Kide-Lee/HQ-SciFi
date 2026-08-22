import type {
  AgreementData,
  ApiResult,
  AppSettings,
  AppNotification,
  ChatMessage,
  ChatSession,
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
  ChangelogData,
  ClearCacheResult,
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
  UserProfileUpdatePayload,
  UserSearchResult,
  UserSession,
  UserStats,
  UpdateState
} from '../shared/types'
import type { ArticleMeta } from '../shared/frontmatter'

export type {
  ApiResult,
  AppNotification,
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
  ChangelogData,
  ClearCacheResult,
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
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  packaged: boolean
  isAppImage?: boolean
}

/** 无边框窗口控制（v0.0.3 自绘顶栏） */
export interface WindowControls {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximizedChanged: (cb: (max: boolean) => void) => () => void
}

export interface HqsfApi {
  ping: () => Promise<string>
  getAppInfo: () => Promise<AppInfo>
  copyText: (text: string) => Promise<ApiResult<null>>
  /** 原生消息弹窗（替代渲染层 alert/confirm，避免 Electron 弹窗后输入框失焦的已知问题） */
  showMessageBox: (options: {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning'
    title?: string
    message: string
    detail?: string
    buttons?: string[]
    cancelId?: number
    defaultId?: number
  }) => Promise<ApiResult<{ response: number }>>
  /** 消息中心（v0.0.9：真实收件箱 API） */
  listNotifications: () => Promise<ApiResult<{ items: AppNotification[]; totalUnread: number }>>
  getUnreadCount: () => Promise<ApiResult<{ total: number }>>
  markNotificationsRead: (categories: string[]) => Promise<ApiResult<null>>
  /** 全局搜索（作品库首页） */
  searchComments: (keyword: string, limit?: number) => Promise<ApiResult<{ items: CommentItem[]; total: number }>>
  searchReviews: (keyword: string, limit?: number) => Promise<ApiResult<{ items: ReviewItem[]; total: number }>>
  searchUsers: (keyword: string, limit?: number) => Promise<ApiResult<{ items: UserSearchResult[]; total: number }>>
  /** 私聊（hqChat/） */
  getPrivateChat: (touid: number | string) => Promise<ApiResult<{ chatid: string }>>
  listChatSessions: () => Promise<ApiResult<{ items: ChatSession[] }>>
  listChatMessages: (chatid: string) => Promise<ApiResult<{ items: ChatMessage[] }>>
  sendChatMessage: (chatid: string, msg: string) => Promise<ApiResult<null>>

  /** 用户协议（{ version, html }；版本用于比对本地同意状态） */
  getAgreement: () => Promise<ApiResult<AgreementData>>
  /** 荒启平台用户协议（网络抓取；失败时渲染层禁用勾选） */
  getHuangqiAgreement: () => Promise<ApiResult<{ html: string }>>
  windowControls: WindowControls
  loginPassword: (name: string, password: string) => Promise<ApiResult<LoginResult>>
  getSession: () => Promise<ApiResult<UserSession | null>>
  /** 校验当前会话 token 有效性（失效 valid:false；网络异常 reachable:false 不强制登出） */
  verifySession: () => Promise<ApiResult<{ valid: boolean; reachable: boolean }>>
  logout: () => Promise<ApiResult<null>>
  syncPull: () => Promise<ApiResult<PullResult>>
  syncPush: (filePath: string, isDraft: boolean, meta?: ArticleMeta) => Promise<ApiResult<PushResult>>
  /** 远端文章转存为草稿（服务端处理；converted=false=原本就是草稿） */
  convertToDraft: (cid: string) => Promise<ApiResult<ConvertDraftResult>>
  /** 编辑远端文章：非草稿先转存草稿（服务端），再同步到本地存档并返回本地文件路径 */
  editRemoteArticle: (cid: string) => Promise<ApiResult<EditRemoteResult>>
  getDocsRoot: () => Promise<ApiResult<string>>
  openDocsDir: () => Promise<ApiResult<null>>
  listLocalDocs: () => Promise<ApiResult<LocalNode[]>>
  readLocalFile: (path: string) => Promise<ApiResult<string>>
  /** 本地文件是否存在（侧栏打开远端索引项时校验；路径越界按不存在处理） */
  fileExists: (path: string) => Promise<ApiResult<boolean>>
  writeLocalFile: (path: string, content: string) => Promise<ApiResult<null>>
  createLocalDraft: (title: string, content: string, dirRel?: string) => Promise<ApiResult<string>>
  /** v0.0.6：新建本地文件夹（相对存档根） */
  createLocalDir: (rel: string) => Promise<ApiResult<string>>
  /** v0.0.6：删除本地文章文件 */
  deleteLocalDoc: (path: string) => Promise<ApiResult<null>>
  chooseDocsDir: () => Promise<ApiResult<string | null>>
  listArticles: () => Promise<ApiResult<ArticleRow[]>>
  listRemoteArticles: (opts?: ArticleListOptions) => Promise<ApiResult<{ items: RemoteArticle[]; total: number }>>
  getRemoteArticle: (cid: string) => Promise<ApiResult<ArticleDetail>>
  listReviews: (opts?: { cid?: string; activeid?: number | string; limit?: number; page?: number; order?: string }) => Promise<
    ApiResult<{ items: ReviewItem[]; total: number }>
  >
  submitReview: (payload: ReviewPayload) => Promise<ApiResult<ReviewSubmitResult>>
  setReviewAttitude: (reviewId: number | string, type: number) => Promise<ApiResult<ReviewSubmitResult>>
  listCategories: () => Promise<
    ApiResult<Array<{ mid: number | string; name: string; slug: string; description?: string; imgurl?: string; count?: number }>>
  >
  listMetas: (type: string) => Promise<ApiResult<MetaInfo[]>>
  /** 违禁词检测（官方接口，付费 5 能量币/次）：返回服务端检测结果 { code, msg } */
  checkForbidden: (title: string, text: string) => Promise<ApiResult<{ code: number; msg: string }>>
  listGptModels: () => Promise<ApiResult<GptModel[]>>
  listReviewTasks: () => Promise<ApiResult<ReviewTaskItem[]>>
  /** v0.0.7：当前账号写过的全部评审（「已评审」徽章数据源，按会话 uid） */
  listMyReviews: () => Promise<ApiResult<{ cids: string[] }>>
  /** 用户资料（公开；key=uid） */
  getUserProfile: (uid: string | number) => Promise<ApiResult<UserProfile>>
  /** 用户计数（需登录；未登录返回 data:null） */
  getUserStats: (uid: string | number) => Promise<ApiResult<UserStats | null>>
  /** 当前账号状态（能量币/经验/等级） */
  getSelfStatus: () => Promise<ApiResult<SelfStatus | null>>
  /** 是否已关注目标用户 */
  getFollowState: (uid: string | number) => Promise<ApiResult<boolean>>
  /** 关注/取关（follow true=关注 false=取关） */
  followUser: (uid: string | number, follow: boolean) => Promise<ApiResult<{ ok: boolean; error?: string }>>
  /** 关注列表（uid=目标用户） */
  listFollows: (uid: string | number, page?: number, limit?: number) => Promise<ApiResult<{ items: UserFollowItem[]; total: number }>>
  /** 粉丝列表（touid=目标用户） */
  listFans: (uid: string | number, page?: number, limit?: number) => Promise<ApiResult<{ items: UserFollowItem[]; total: number }>>
  /** 我的收藏 */
  listMarks: (page?: number, limit?: number) => Promise<ApiResult<{ items: UserMarkItem[]; total: number }>>
  /** 用户发表的文章 */
  listUserArticles: (uid: string | number, page?: number, limit?: number) => Promise<ApiResult<{ items: RemoteArticle[]; total: number }>>
  /** 用户发表的评审 */
  listUserReviews: (uid: string | number, page?: number, limit?: number) => Promise<ApiResult<{ items: ReviewItem[]; total: number }>>
  /** 用户发表的评论 */
  listUserComments: (uid: string | number, page?: number, limit?: number) => Promise<ApiResult<CommentListResult>>
  /** 关注动态聚合（仅本人） */
  listFollowFeed: () => Promise<ApiResult<FollowFeedItem[]>>
  /** 签到（addLog type=clock） */
  clockIn: () => Promise<ApiResult<ClockResult>>
  listComments: (cid: string, opts?: { limit?: number; page?: number; order?: string }) => Promise<
    ApiResult<CommentListResult>
  >
  /** v0.0.8：全局最新评论流（不带 cid，首页「最新讨论」用） */
  listRecentComments: (opts?: { limit?: number; page?: number; order?: string }) => Promise<
    ApiResult<{ items: CommentItem[]; total: number }>
  >
  addComment: (payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }) => Promise<
    ApiResult<CommentSubmitResult>
  >
  addLog: (type: 'likes' | 'mark' | 'reward', params: Record<string, unknown>) => Promise<ApiResult<LogOpResult>>
  isMark: (cid: string) => Promise<ApiResult<MarkStatus>>
  removeLog: (key: number | string) => Promise<ApiResult<LogOpResult>>
  /** v0.1.10：应用设置 */
  getSettings: () => Promise<ApiResult<AppSettings>>
  updateSettings: (patch: Partial<AppSettings>) => Promise<ApiResult<AppSettings>>
  getChangelog: () => Promise<ApiResult<ChangelogData>>
  clearCache: () => Promise<ApiResult<ClearCacheResult>>
  uninstall: () => Promise<ApiResult<null>>
  getUpdateState: () => Promise<ApiResult<UpdateState>>
  checkForUpdates: () => Promise<ApiResult<UpdateState>>
  downloadUpdate: () => Promise<ApiResult<null>>
  installUpdate: () => Promise<ApiResult<null>>
  onUpdateState: (cb: (state: UpdateState) => void) => () => void
  userUpdateProfile: (payload: UserProfileUpdatePayload) => Promise<ApiResult<null>>
  pickUploadUserImage: () => Promise<ApiResult<{ url: string } | null>>
  /** v0.0.6：弹系统文件框选图片并上传荒启（upload/full），返回图片 URL；取消返回 data: null */
  pickUploadImage: () => Promise<ApiResult<{ url: string } | null>>
}

declare global {
  interface Window {
    hqsf: HqsfApi
  }
}

export {}
