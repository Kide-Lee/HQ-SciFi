import type {
  ApiResult,
  ArticleRow,
  LocalNode,
  LoginResult,
  PullResult,
  PushResult,
  UserSession
} from '../shared/types'

export type {
  ApiResult,
  ArticleRow,
  LocalNode,
  LoginResult,
  PullResult,
  PushResult,
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
}

declare global {
  interface Window {
    hqsf: HqsfApi
  }
}

export {}
