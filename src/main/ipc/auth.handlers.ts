import { ipcMain } from 'electron'
import { getSession, loginWithPassword, logout as doLogout, verifySessionToken } from '../services/auth-service'
import { clearArticles } from '../services/docs-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerAuthHandlers(): void {
ipcMain.handle('hqsf:login-password', async (event, name: string, password: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const res = await loginWithPassword(name, password)
      // 登录成功 = 可能切换账号：清空上一账号的本地索引，防止旧账号文章串到新账号侧栏四态
      if (res.ok) clearArticles()
      return ok(res)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:get-session', () => ok(getSession()))
ipcMain.handle('hqsf:verify-session', async () => {
    try {
      return ok(await verifySessionToken())
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:logout', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      await doLogout()
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
}

