import { ipcMain } from 'electron'
import { pickUploadImage } from '../services/media-service'
import { getStoredToken } from '../services/auth-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerMediaHandlers(): void {
ipcMain.handle('media:pick-upload-image', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail('未登录，无法上传图片')
    try {
      const url = await pickUploadImage(token)
      return ok(url)
    } catch (err) {
      return fail(err)
    }
  })
}

