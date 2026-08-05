export interface AppInfo {
  version: string
  platform: string
  arch: string
  packaged: boolean
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST'
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

export interface HqsfApi {
  ping: () => Promise<string>
  getAppInfo: () => Promise<AppInfo>
  apiRequest: <T = unknown>(
    path: string,
    options?: ApiRequestOptions
  ) => Promise<{ ok: boolean; data?: T; total?: number; error?: string }>
}

declare global {
  interface Window {
    hqsf: HqsfApi
  }
}

export {}
