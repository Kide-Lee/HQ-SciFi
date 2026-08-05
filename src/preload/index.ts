import { contextBridge, ipcRenderer } from 'electron'
import type { ApiResult, ArticleRow, LocalNode, LoginResult, PullResult, PushResult, UserSession } from '../shared/types'

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
  listLocalDocs: (): Promise<ApiResult<LocalNode[]>> => ipcRenderer.invoke('hqsf:list-local-docs'),
  readLocalFile: (path: string): Promise<ApiResult<string>> => ipcRenderer.invoke('hqsf:read-local-file', path),
  writeLocalFile: (path: string, content: string): Promise<ApiResult<null>> =>
    ipcRenderer.invoke('hqsf:write-local-file', path, content),
  createLocalDraft: (title: string, content: string): Promise<ApiResult<string>> =>
    ipcRenderer.invoke('hqsf:create-local-draft', title, content),
  chooseDocsDir: (): Promise<ApiResult<string | null>> => ipcRenderer.invoke('hqsf:choose-docs-dir'),

  // ---- 四态索引 ----
  listArticles: (): Promise<ApiResult<ArticleRow[]>> => ipcRenderer.invoke('hqsf:list-articles')
}

export type HqsfApi = typeof api

contextBridge.exposeInMainWorld('hqsf', api)
