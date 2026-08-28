import { ipcMain } from 'electron'
import { searchComments } from '../services/comment-service'
import { getStoredToken } from '../services/auth-service'
import { listReviews } from '../services/review-service'
import { searchUsers } from '../services/user-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerSearchHandlers(): void {
ipcMain.handle('hqsf:search-comments', async (event, keyword: string, limit?: number) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      const res = await searchComments(token, String(keyword ?? ''), limit ?? 10, 1)
      return ok(res)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:search-reviews', async (event, keyword: string, limit?: number) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      const res = await listReviews(token, { searchKey: String(keyword ?? ''), limit: limit ?? 10, page: 1, order: 'created' })
      return ok(res)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:search-users', async (event, keyword: string, limit?: number) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      const res = await searchUsers(token, String(keyword ?? ''), 1, limit ?? 10)
      return ok(res)
    } catch (err) {
      return fail(err)
    }
  })
}

