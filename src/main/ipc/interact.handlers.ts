import { ipcMain } from 'electron'
import { addUserLog, getMarkStatus, removeUserLog } from '../services/interact-service'
import { getStoredToken } from '../services/auth-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerInteractHandlers(): void {
ipcMain.handle('hqsf:add-log', async (_e, type: 'likes' | 'mark' | 'reward', params: Record<string, unknown> = {}) => {
    const blocked = trusted(_e)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法操作'))
    if (type !== 'likes' && type !== 'mark' && type !== 'reward') return fail(new Error('未知的操作类型'))
    const cid = String(params?.cid ?? '').trim()
    if (!cid) return fail(new Error('缺少目标文章 ID'))
    if (type === 'reward') {
      const num = Number(params?.num)
      if (!Number.isInteger(num) || num <= 0 || num > 10000) {
        return fail(new Error('投币数量需为 1-10000 的整数'))
      }
      return ok(await addUserLog(token, type, { cid, num }))
    }
    // v0.0.7：点赞支持取消——num:1 点赞 / num:-1 取消点赞（官方 H5「推荐/不推荐」）
    if (type === 'likes') {
      const num = Number(params?.num)
      if (num !== 1 && num !== -1) return fail(new Error('点赞参数错误（num 需为 1 或 -1）'))
      return ok(await addUserLog(token, type, { cid, num }))
    }
    return ok(await addUserLog(token, type, { cid }))
  })
ipcMain.handle('hqsf:is-mark', async (_e, cid: string) => {
    const blocked = trusted(_e)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录'))
    const key = String(cid ?? '').trim()
    if (!key) return fail(new Error('缺少文章 ID'))
    try {
      return ok(await getMarkStatus(token, key))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:remove-log', async (_e, key: number | string) => {
    const blocked = trusted(_e)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录'))
    const logKey = String(key ?? '').trim()
    if (!logKey) return fail(new Error('缺少收藏记录 ID'))
    try {
      return ok(await removeUserLog(token, logKey))
    } catch (err) {
      return fail(err)
    }
  })
}

