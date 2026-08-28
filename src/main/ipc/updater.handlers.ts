import { ipcMain, shell } from 'electron'
import { checkForGitHubUpdate, getUpdateState } from '../services/updater-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerUpdaterHandlers(): void {
ipcMain.handle('hqsf:update-state', () => ok(getUpdateState()))
ipcMain.handle('hqsf:update-check', async () => {
    try {
      return ok(await checkForGitHubUpdate())
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:update-download', async () => {
    try {
      const state = getUpdateState()
      if (state.status !== 'available' || !state.url) {
        return fail(new Error('当前没有可下载的更新'))
      }
      await shell.openExternal(state.url)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:update-install', async () => {
    try {
      const state = getUpdateState()
      if (state.status !== 'available' || !state.url) {
        return fail(new Error('当前没有可安装的更新'))
      }
      await shell.openExternal(state.url)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
}

