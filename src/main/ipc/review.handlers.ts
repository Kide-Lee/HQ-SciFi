import { ipcMain } from 'electron'
import { getSession, getStoredToken } from '../services/auth-service'
import { listMyReviews, listReviewTasks, listReviews, setReviewAttitude, submitReview } from '../services/review-service'
import type { ReviewPayload } from '../../shared/types'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerReviewHandlers(): void {
ipcMain.handle('hqsf:list-reviews', async (_e, opts: { cid?: string; activeid?: number | string; limit?: number; page?: number; order?: string } = {}) => {
    const token = getStoredToken()
    try {
      return ok(await listReviews(token, opts))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:submit-review', async (event, payload: ReviewPayload) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法评审'))
    // 主进程校验载荷，防止渲染层越权/非法输入（评审提交体校验规则与官方一致）
    if (!payload || typeof payload !== 'object') return fail(new Error('无效的评审数据'))
    if (typeof payload.cid !== 'string' || !payload.cid.trim()) return fail(new Error('缺少目标文章 ID'))
    if (payload.id != null && typeof payload.id !== 'string' && typeof payload.id !== 'number') {
      return fail(new Error('无效的评审 ID'))
    }
    const dims = ['dianzi', 'wenbi', 'renwu', 'jiezou', 'liyi'] as const
    for (const d of dims) {
      const text = typeof payload[d] === 'string' ? payload[d].trim() : ''
      if (text.length < 10) return fail(new Error(`「${d}」评语需至少 10 字`))
      const score = Number(payload[`${d}Score`])
      if (!Number.isFinite(score) || score < 0 || score > 10) {
        return fail(new Error(`「${d}」评分需在 0-10 之间`))
      }
    }
    try {
      return ok(await submitReview(token, payload))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:set-review-attitude', async (event, reviewId: number | string, type: number) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录'))
    try {
      return ok(await setReviewAttitude(token, reviewId, type))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-review-tasks', async () => {
    const token = getStoredToken()
    const rawUid = getSession()?.userinfo?.uid ?? getSession()?.userinfo?.id
    const uidNum = Number(rawUid)
    const uid = Number.isFinite(uidNum) && uidNum > 0 ? uidNum : String(rawUid ?? '')
    if (!uid) return ok([])
    try {
      return ok(await listReviewTasks(token, uid))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-my-reviews', async () => {
    const token = getStoredToken()
    const rawUid = getSession()?.userinfo?.uid ?? getSession()?.userinfo?.id
    const uidNum = Number(rawUid)
    const uid = Number.isFinite(uidNum) && uidNum > 0 ? uidNum : String(rawUid ?? '')
    if (!uid) return ok({ cids: [] })
    try {
      return ok(await listMyReviews(token, uid))
    } catch (err) {
      return fail(err)
    }
  })
}

