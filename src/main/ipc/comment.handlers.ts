import { ipcMain } from 'electron'
import { addComment, listComments, listRecentComments } from '../services/comment-service'
import { getStoredToken } from '../services/auth-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerCommentHandlers(): void {
ipcMain.handle('hqsf:list-comments', async (_e, cid: string, opts: { limit?: number; page?: number; order?: string } = {}) => {
    const blocked = trusted(_e)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    const key = String(cid ?? '').trim()
    if (!key) return fail(new Error('缺少文章 ID'))
    try {
      return ok(await listComments(token, key, opts))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-recent-comments', async (_e, opts: { limit?: number; page?: number; order?: string } = {}) => {
    const blocked = trusted(_e)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    try {
      return ok(await listRecentComments(token, opts))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle(
    'hqsf:add-comment',
    async (_e, payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }) => {
      const blocked = trusted(_e)
      if (blocked) return fail(blocked)
      const token = getStoredToken()
      if (!token) return fail(new Error('未登录，无法评论'))
      if (!payload || typeof payload !== 'object') return fail(new Error('无效的评论数据'))
      const cid = String(payload.cid ?? '').trim()
      if (!cid) return fail(new Error('缺少目标文章 ID'))
      const text = String(payload.text ?? '').trim()
      if (text.length < 4) return fail(new Error('评论内容至少 4 个字'))
      if (text.length > 2000) return fail(new Error('评论内容过长（最多 2000 字）'))
      if (payload.parent != null && typeof payload.parent !== 'string' && typeof payload.parent !== 'number') {
        return fail(new Error('无效的回复目标'))
      }
      // v0.0.3：评论-评审关联（reviewid 透传；0/空视为不关联）
      if (payload.reviewid != null && typeof payload.reviewid !== 'string' && typeof payload.reviewid !== 'number') {
        return fail(new Error('无效的评审关联'))
      }
      try {
        return ok(await addComment(token, { cid, text, parent: payload.parent, reviewid: payload.reviewid }))
      } catch (err) {
        return fail(err)
      }
    }
  )
}

