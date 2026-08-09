import { contextBridge, ipcRenderer } from 'electron'
import type {
  ApiResult,
  ArticleDetail,
  ArticleListOptions,
  ArticleRow,
  CommentItem,
  CommentSubmitResult,
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
  UserSession
} from '../shared/types'

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

  // ---- 认证 ----
  loginPassword: (name: string, password: string): Promise<ApiResult<LoginResult>> =>
    ipcRenderer.invoke('hqsf:login-password', name, password),
  sendSmsCode: (phone: string): Promise<ApiResult<{ ok: boolean; error?: string }>> =>
    ipcRenderer.invoke('hqsf:send-sms-code', phone),
  loginPhone: (phone: string, code: string): Promise<ApiResult<LoginResult>> =>
    ipcRenderer.invoke('hqsf:login-phone', phone, code),
  getSession: (): Promise<ApiResult<UserSession | null>> => ipcRenderer.invoke('hqsf:get-session'),
  logout: (): Promise<ApiResult<null>> => ipcRenderer.invoke('hqsf:logout'),

  // ---- 同步 ----
  syncPull: (): Promise<ApiResult<PullResult>> => ipcRenderer.invoke('hqsf:sync-pull'),
  syncPush: (filePath: string, isDraft: boolean): Promise<ApiResult<PushResult>> =>
    ipcRenderer.invoke('hqsf:sync-push', filePath, isDraft),

  // ---- 本地存档 ----
  getDocsRoot: (): Promise<ApiResult<string>> => ipcRenderer.invoke('hqsf:get-docs-root'),
  openDocsDir: (): Promise<ApiResult<null>> => ipcRenderer.invoke('hqsf:open-docs-dir'),
  listLocalDocs: (): Promise<ApiResult<LocalNode[]>> => ipcRenderer.invoke('hqsf:list-local-docs'),
  readLocalFile: (path: string): Promise<ApiResult<string>> => ipcRenderer.invoke('hqsf:read-local-file', path),
  writeLocalFile: (path: string, content: string): Promise<ApiResult<null>> =>
    ipcRenderer.invoke('hqsf:write-local-file', path, content),
  createLocalDraft: (title: string, content: string): Promise<ApiResult<string>> =>
    ipcRenderer.invoke('hqsf:create-local-draft', title, content),
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
  /** AI 模型列表（推荐栏目「AI模型」） */
  listGptModels: (): Promise<ApiResult<GptModel[]>> => ipcRenderer.invoke('hqsf:list-gpt-models'),
  /** 当前账号的评审任务（待评审/已完成文章列表） */
  listReviewTasks: (): Promise<ApiResult<ReviewTaskItem[]>> => ipcRenderer.invoke('hqsf:list-review-tasks'),

  // ---- 评论（阅读视图评论区） ----
  /** 文章评论列表（hqComments/commentsList） */
  listComments: (cid: string, opts?: { limit?: number; page?: number; order?: string }): Promise<
    ApiResult<{ items: CommentItem[]; total: number }>
  > => ipcRenderer.invoke('hqsf:list-comments', cid, opts),
  /** 发表评论（parent 为回复的上级评论 coid，可省略） */
  addComment: (payload: { cid: string; text: string; parent?: number | string }): Promise<ApiResult<CommentSubmitResult>> =>
    ipcRenderer.invoke('hqsf:add-comment', payload),

  // ---- 用户互动（点赞 / 收藏 / 投币，hqUserlog/） ----
  /** 点赞（likes，每日一次）/ 收藏（mark）/ 投币（reward，需 num 积分） */
  addLog: (type: 'likes' | 'mark' | 'reward', params: Record<string, unknown>): Promise<ApiResult<LogOpResult>> =>
    ipcRenderer.invoke('hqsf:add-log', type, params),
  /** 查询文章收藏状态（返回 marked/logid） */
  isMark: (cid: string): Promise<ApiResult<MarkStatus>> => ipcRenderer.invoke('hqsf:is-mark', cid),
  /** 取消收藏（key=isMark 返回的 logid） */
  removeLog: (key: number | string): Promise<ApiResult<LogOpResult>> => ipcRenderer.invoke('hqsf:remove-log', key)
}

export type HqsfApi = typeof api

contextBridge.exposeInMainWorld('hqsf', api)
