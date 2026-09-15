import { ipcMain, app, clipboard, dialog } from 'electron'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerSystemHandlers(): void {
ipcMain.handle('hqsf:ping', () => 'pong')
ipcMain.handle('hqsf:copy-text', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return ok(null)
  })
ipcMain.handle('hqsf:read-clipboard-text', () => ok(clipboard.readText()))
ipcMain.handle('hqsf:read-clipboard-html', () => ok(clipboard.readHTML()))
ipcMain.handle('hqsf:get-app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    isAppImage: !!process.env.APPIMAGE
  }))
ipcMain.handle(
    'hqsf:show-message-box',
    async (
      event,
      options?: {
        type?: 'none' | 'info' | 'error' | 'question' | 'warning'
        title?: string
        message?: string
        detail?: string
        buttons?: string[]
        cancelId?: number
        defaultId?: number
      }
    ) => {
      const blocked = trusted(event)
      if (blocked) return fail(blocked)
      const win = windowOf(event)
      const boxOptions: Electron.MessageBoxOptions = {
        type: options?.type ?? 'info',
        title: options?.title ?? '黄芪饮片',
        message: options?.message ?? '',
        ...(options?.detail ? { detail: options.detail } : {}),
        buttons: options?.buttons?.length ? options.buttons.slice(0, 4) : ['确定'],
        ...(options?.cancelId != null ? { cancelId: options.cancelId } : {}),
        ...(options?.defaultId != null ? { defaultId: options.defaultId } : {})
      }
      try {
        const result =
          win && !win.isDestroyed()
            ? await dialog.showMessageBox(win, boxOptions)
            : await dialog.showMessageBox(boxOptions)
        // 原生对话框关闭后确保窗口重新获得焦点，避免任何焦点残留问题
        if (win && !win.isDestroyed()) win.focus()
        return ok({ response: result.response })
      } catch (err) {
        return fail(err)
      }
    }
  )
}

