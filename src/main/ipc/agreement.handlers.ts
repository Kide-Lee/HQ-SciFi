import { ipcMain } from 'electron'
import { loadAgreement } from '../services/agreement-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerAgreementHandlers(): void {
ipcMain.handle('hqsf:get-agreement', () => {
    try {
      return ok(loadAgreement())
    } catch (err) {
      return fail(err)
    }
  })
}
