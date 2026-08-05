import { app, ipcMain } from 'electron'
import { apiRequest } from './net/api'

/** IPC 返回约定：成功 { ok: true, data }，失败 { ok: false, error }（避免 Error 序列化丢 message） */
export function registerIpcHandlers(): void {
  ipcMain.handle('hqsf:ping', () => 'pong')

  ipcMain.handle('hqsf:get-app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged
  }))

  // 通用荒启 API 代理：渲染层不直接接触网络，全部经主进程
  // 成功时返回业务载荷（data.data）与分页总数（total），类型即渲染层声明，避免双层 data 混淆
  ipcMain.handle('hqsf:api-request', async (_event, path: string, options?: unknown) => {
    try {
      const resp = await apiRequest(path, options as Parameters<typeof apiRequest>[1])
      return { ok: true, data: resp.data, total: resp.total }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
