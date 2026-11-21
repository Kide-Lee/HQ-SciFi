import { ipcMain } from 'electron'
import { getUnreadCount, listInbox, markNotificationsRead } from '../services/notify-service'
import { listReviewTasks } from '../services/review-service'
import { getStoredToken } from '../services/auth-service'
import type { AppNotification } from '../../shared/domain'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerNotifyHandlers(): void {
ipcMain.handle('hqsf:list-notifications', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return ok({ items: [], totalUnread: 0 })
    try {
      let items = await listInbox(token)
      // 网页端已把「待评审」从收件箱拆成独立的评审任务；消息中心仍需显示，
      // 否则用户只能看到文章角标、看不到提醒。任务按已读通知展示，不计入未读数。
      const uid = sessionUid()
      if (uid && uid !== '0') {
        const tasks = await listReviewTasks(token, uid).catch(() => [])
        const knownCids = new Set(items.map((n) => n.cid).filter((cid): cid is string => !!cid))
        const todo = tasks.filter((t) => t.status === 0 && t.cid && !knownCids.has(t.cid))
        if (todo.length > 0) {
          const now = Math.floor(Date.now() / 1000)
          const taskItems: AppNotification[] = todo.map((t) => ({
            id: `review-task:${t.cid}`,
            category: 'review',
            title: '待评审',
            text: [t.activeName, t.articleTitle].filter((s) => !!s).join(' · ') || t.cid,
            time: t.created && t.created > 0 ? t.created : now,
            read: true,
            cid: t.cid
          }))
          items = [...taskItems, ...items]
        }
      }
      const totalUnread = items.filter((n) => !n.read).length
      return ok({ items, totalUnread })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:get-unread-count', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return ok({ total: 0 })
    try {
      return ok({ total: await getUnreadCount(token) })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:mark-notifications-read', async (event, categories: string[]) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法标记已读'))
    try {
      await markNotificationsRead(token, (Array.isArray(categories) ? categories : []) as Parameters<typeof markNotificationsRead>[1])
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
}

