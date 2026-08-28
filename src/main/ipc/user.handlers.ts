import { ipcMain } from 'electron'
import { clockIn, getFollowState, getSelfStatus, getUserProfile, getUserStats, listFans, listFollowFeed, listFollows, listMarks, listUserArticles, listUserComments, listUserReviews, setFollow, updateUserProfile } from '../services/user-service'
import { getStoredToken, updateSessionUserinfo } from '../services/auth-service'
import { pickUploadUserImage } from '../services/media-service'
import type { UserProfileUpdatePayload } from '../../shared/types'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerUserHandlers(): void {
ipcMain.handle('hqsf:user-profile', async (_e, uid: unknown) => {
    try {
      return ok(await getUserProfile(getStoredToken(), checkedUid(uid)))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-stats', async (_e, uid: unknown) => {
    try {
      return ok(await getUserStats(getStoredToken(), checkedUid(uid)))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-self-status', async () => {
    try {
      const token = getStoredToken()
      if (!token) return ok(null)
      return ok(await getSelfStatus(token))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-follow-state', async (_e, uid: unknown) => {
    try {
      return ok(await getFollowState(getStoredToken(), checkedUid(uid)))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-follow', async (event, uid: unknown, follow: boolean) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      return ok(await setFollow(getStoredToken(), checkedUid(uid), follow === true))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-follow-list', async (_e, uid: unknown, page = 1, limit = 20) => {
    try {
      return ok(await listFollows(getStoredToken(), checkedUid(uid), Number(page) || 1, Number(limit) || 20))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-fan-list', async (_e, uid: unknown, page = 1, limit = 20) => {
    try {
      return ok(await listFans(getStoredToken(), checkedUid(uid), Number(page) || 1, Number(limit) || 20))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-marks', async (event, page = 1, limit = 20) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      if (!token) return fail(new Error('未登录，无法查看收藏'))
      return ok(await listMarks(token, Number(page) || 1, Number(limit) || 20))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-articles', async (_e, uid: unknown, page = 1, limit = 20) => {
    try {
      return ok(await listUserArticles(getStoredToken(), checkedUid(uid), Number(page) || 1, Number(limit) || 20))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-reviews', async (_e, uid: unknown, page = 1, limit = 20) => {
    try {
      return ok(await listUserReviews(getStoredToken(), checkedUid(uid), Number(page) || 1, Number(limit) || 20))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-comments', async (_e, uid: unknown, page = 1, limit = 20) => {
    try {
      return ok(await listUserComments(getStoredToken(), checkedUid(uid), Number(page) || 1, Number(limit) || 20))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-feed', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      const uid = sessionUid()
      if (!token || !uid) return ok([])
      return ok(await listFollowFeed(token, uid))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-clock', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const token = getStoredToken()
      if (!token) return fail(new Error('未登录，无法签到'))
      return ok(await clockIn(token))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:user-update-profile', async (event, payload: UserProfileUpdatePayload) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法修改资料'))
    try {
      if (!payload || typeof payload !== 'object') return fail(new Error('无效的资料数据'))
      const clean: UserProfileUpdatePayload = {}
      if (payload.screenName != null) clean.screenName = String(payload.screenName).trim()
      if (payload.avatar != null) clean.avatar = String(payload.avatar).trim()
      if (payload.userBg != null) clean.userBg = String(payload.userBg).trim()
      if (payload.introduce != null) clean.introduce = String(payload.introduce).trim()
      if (payload.mail != null) clean.mail = String(payload.mail).trim()
      if (payload.phone != null) clean.phone = String(payload.phone).trim()
      await updateUserProfile(token, clean)
      updateSessionUserinfo(clean as unknown as Record<string, unknown>)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:pick-upload-user-image', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法上传图片'))
    try {
      const url = await pickUploadUserImage(token)
      return ok(url)
    } catch (err) {
      return fail(err)
    }
  })
}

