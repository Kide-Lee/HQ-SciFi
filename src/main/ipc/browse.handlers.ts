import { ipcMain } from 'electron'
import { checkTextBlockStatus, listCategories, listGptModels, listMetas } from '../services/browse-service'
import { getStoredToken } from '../services/auth-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerBrowseHandlers(): void {
ipcMain.handle('hqsf:list-categories', async () => {
    const token = getStoredToken()
    try {
      return ok(await listCategories(token))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-metas', async (_e, type: string) => {
    const token = getStoredToken()
    try {
      return ok(await listMetas(token, String(type ?? '')))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:check-forbidden', async (event, title: string, text: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      if (!token) return fail('未登录')
      const res = await checkTextBlockStatus(token, String(title ?? ''), String(text ?? ''))
      return ok({ code: res.code, msg: res.msg })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-gpt-models', async () => {
    const token = getStoredToken()
    try {
      return ok(await listGptModels(token))
    } catch (err) {
      return fail(err)
    }
  })
}

