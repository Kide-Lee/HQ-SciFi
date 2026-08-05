import { contextBridge, ipcRenderer } from 'electron'
import type { ApiRequestOptions } from '../main/net/api'

/**
 * 暴露给渲染进程的白名单 API（window.hqsf）。
 * 渲染层唯一入口：不暴露 ipcRenderer 本体，杜绝任意 IPC。
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('hqsf:ping'),
  getAppInfo: (): Promise<{ version: string; platform: string; arch: string; packaged: boolean }> =>
    ipcRenderer.invoke('hqsf:get-app-info'),
  apiRequest: <T = unknown>(
    path: string,
    options?: ApiRequestOptions
  ): Promise<{ ok: boolean; data?: T; total?: number; error?: string }> =>
    ipcRenderer.invoke('hqsf:api-request', path, options)
}

export type HqsfApi = typeof api

contextBridge.exposeInMainWorld('hqsf', api)
