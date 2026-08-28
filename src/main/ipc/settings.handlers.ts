import { ipcMain, app } from 'electron'
import { applyWindowCustomCode } from '../window'
import { getAppSettings, updateAppSettings, getChangelogData, uninstallApplication } from '../services/settings-service'
import { clearReadCache } from '../services/docs-service'
import { clearImageCache } from '../services/media-service'
import type { AppSettings } from '../../shared/types'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerSettingsHandlers(): void {
ipcMain.handle('hqsf:get-settings', (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      return ok(getAppSettings())
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:update-settings', (event, patch: Partial<AppSettings>) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
        return fail(new Error('无效的设置数据'))
      }
      const next = updateAppSettings({
        ...(typeof patch.autoUpdate === 'boolean' ? { autoUpdate: patch.autoUpdate } : {}),
        ...(typeof patch.hardwareAccel === 'boolean' ? { hardwareAccel: patch.hardwareAccel } : {}),
        ...(typeof patch.zoomFactor === 'number' ? { zoomFactor: patch.zoomFactor } : {}),
        ...(typeof patch.customCss === 'string' ? { customCss: patch.customCss } : {}),
        ...(typeof patch.customJs === 'string' ? { customJs: patch.customJs } : {})
      })
      // 部分设置需要立即对当前窗口生效
      const win = windowOf(event)
      if (win && (typeof patch.zoomFactor === 'number' || typeof patch.customCss === 'string' || typeof patch.customJs === 'string')) {
        applyWindowCustomCode(win)
      }
      return ok(next)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:get-changelog', () => {
    try {
      return ok(getChangelogData())
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:clear-cache', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const imageFreed = await clearImageCache()
      clearReadCache()
      try {
        await event.sender.session.clearCache()
      } catch {
        /* 非关键：部分环境清理失败忽略 */
      }
      return ok({ freedBytes: imageFreed })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:uninstall', (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      if (process.platform !== 'win32') {
        return fail(new Error('当前平台不支持应用内卸载；请使用系统包管理器或删除应用目录'))
      }
      uninstallApplication()
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
}

