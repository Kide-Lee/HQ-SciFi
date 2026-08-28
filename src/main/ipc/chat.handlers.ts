import { ipcMain } from 'electron'
import { getPrivateChat, listChatMessages, listChatSessions, sendChatMessage } from '../services/chat-service'
import { getStoredToken } from '../services/auth-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerChatHandlers(): void {
ipcMain.handle('hqsf:get-private-chat', async (event, touid: number | string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法私聊'))
    try {
      return ok({ chatid: await getPrivateChat(token, touid) })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-chat-sessions', async (event) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return ok({ items: [] })
    try {
      return ok({ items: await listChatSessions(token) })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-chat-messages', async (event, chatid: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法私聊'))
    try {
      return ok({ items: await listChatMessages(token, String(chatid ?? '')) })
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:send-chat-message', async (event, chatid: string, msg: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法私聊'))
    try {
      await sendChatMessage(token, String(chatid ?? ''), String(msg ?? ''))
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
}

