import type {
  ApiResult,
  ArticleDetail,
  ArticleListOptions,
  ArticleRow,
  LocalNode,
  LoginResult,
  PullResult,
  PushResult,
  RemoteArticle,
  ReviewItem,
  ReviewPayload,
  ReviewSubmitResult,
  UserSession
} from '../shared/types'

export type {
  ApiResult,
  ArticleDetail,
  ArticleListOptions,
  ArticleRow,
  LocalNode,
  LoginResult,
  PullResult,
  PushResult,
  RemoteArticle,
  ReviewItem,
  ReviewPayload,
  ReviewSubmitResult,
  UserSession
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  packaged: boolean
}

export interface HqsfApi {
  ping: () => Promise<string>
  getAppInfo: () => Promise<AppInfo>
  copyText: (text: string) => Promise<ApiResult<null>>
  loginPassword: (name: string, password: string) => Promise<ApiResult<LoginResult>>
  sendSmsCode: (phone: string) => Promise<ApiResult<{ ok: boolean; error?: string }>>
  loginPhone: (phone: string, code: string) => Promise<ApiResult<LoginResult>>
  getSession: () => Promise<ApiResult<UserSession | null>>
  logout: () => Promise<ApiResult<null>>
  syncPull: () => Promise<ApiResult<PullResult>>
  syncPush: (filePath: string, isDraft: boolean) => Promise<ApiResult<PushResult>>
  getDocsRoot: () => Promise<ApiResult<string>>
  openDocsDir: () => Promise<ApiResult<null>>
  listLocalDocs: () => Promise<ApiResult<LocalNode[]>>
  readLocalFile: (path: string) => Promise<ApiResult<string>>
  writeLocalFile: (path: string, content: string) => Promise<ApiResult<null>>
  createLocalDraft: (title: string, content: string) => Promise<ApiResult<string>>
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
    ApiResult<Array<{ mid: number | string; name: string; slug: string; description?: string; count?: number }>>
  >
}

declare global {
  interface Window {
    hqsf: HqsfApi
  }
}

export {}
