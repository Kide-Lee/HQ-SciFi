import { ipcMain } from 'electron'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerWindowHandlers(): void {
ipcMain.handle('hqsf:window-minimize', (event) => {
    windowOf(event)?.minimize()
  })
ipcMain.handle('hqsf:window-maximize-toggle', (event) => {
    const win = windowOf(event)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
ipcMain.handle('hqsf:window-close', (event) => {
    windowOf(event)?.close()
  })
ipcMain.handle('hqsf:window-is-maximized', (event) => {
    return windowOf(event)?.isMaximized() ?? false
  })
// v1.1.12：右键菜单「开发者工具」（与 Ctrl+F12 行为一致）
ipcMain.handle('hqsf:toggle-devtools', (event) => {
    const win = windowOf(event)
    if (!win) return fail(new Error('窗口不存在'))
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
    else win.webContents.openDevTools()
    return ok(null)
  })
}

