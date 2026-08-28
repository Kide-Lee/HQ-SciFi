import { ipcMain } from 'electron'
import { convertToDraft, editRemoteArticle, publish, pullRemote, pushToDraft } from '../services/sync-service'
import { getSession, getStoredToken } from '../services/auth-service'
import type { ArticleMeta } from '../../shared/frontmatter'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerSyncHandlers(): void {
ipcMain.handle('hqsf:sync-pull', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    const uid = String(getSession()?.userinfo?.uid ?? '')
    if (!token || !uid) return fail(new Error('未登录，无法同步'))
    try {
      return ok(await pullRemote(token, uid))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:sync-push', async (event, filePath: string, isDraft: boolean, meta?: ArticleMeta) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法同步'))
    try {
      return ok(isDraft ? await pushToDraft(token, filePath) : await publish(token, filePath, meta))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:convert-to-draft', async (event, cid: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法转存草稿'))
    const key = String(cid ?? '').trim()
    if (!key) return fail(new Error('缺少文章 ID'))
    const uid = String(getSession()?.userinfo?.uid ?? getSession()?.userinfo?.id ?? '')
    try {
      return ok(await convertToDraft(token, uid, key))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:edit-remote-article', async (event, cid: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法编辑'))
    const key = String(cid ?? '').trim()
    if (!key) return fail(new Error('缺少文章 ID'))
    const uid = String(getSession()?.userinfo?.uid ?? getSession()?.userinfo?.id ?? '')
    try {
      return ok(await editRemoteArticle(token, uid, key))
    } catch (err) {
      return fail(err)
    }
  })
}

