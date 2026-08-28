import { ipcMain } from 'electron'
import { getUnreadCount, listInbox, markNotificationsRead } from '../services/notify-service'
import { getStoredToken } from '../services/auth-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerNotifyHandlers(): void {
ipcMain.handle('hqsf:list-notifications', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return ok({ items: [], totalUnread: 0 })
    try {
      const items = await listInbox(token)
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

