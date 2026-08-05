import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import {
  loginWithPassword,
  loginWithPhone,
  sendSmsCode,
  getSession,
  getStoredToken,
  logout as doLogout
} from './auth'
import { getDocsRoot, ensureDocsRoot, listLocalDocs, readLocalFile, writeLocalFile, createLocalDraft, chooseDocsDir } from './fs'
import { pullRemote, pushToDraft, publish } from './sync'
import { listArticles } from './db'

/** IPC 返回约定：成功 { ok: true, data }，失败 { ok: false, error }（避免 Error 序列化丢 message） */
function ok<T>(data: T) {
  return { ok: true as const, data }
}

function fail(error: unknown) {
  return { ok: false as const, error: (error as Error).message }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('hqsf:ping', () => 'pong')

  // 复制文本到系统剪贴板（渲染层 sandbox 下 navigator.clipboard 不可靠，走主进程）
  ipcMain.handle('hqsf:copy-text', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return ok(null)
  })

  ipcMain.handle('hqsf:get-app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged
  }))

  // ---- 认证与会话 ----
  ipcMain.handle('hqsf:login-password', async (_e, name: string, password: string) => {
    try {
      return ok(await loginWithPassword(name, password))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:send-sms-code', async (_e, phone: string) => {
    try {
      return ok(await sendSmsCode(phone))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:login-phone', async (_e, phone: string, code: string) => {
    try {
      return ok(await loginWithPhone(phone, code))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:get-session', () => ok(getSession()))

  ipcMain.handle('hqsf:logout', async () => {
    try {
      await doLogout()
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 同步（草稿箱 ↔ 本地） ----
  ipcMain.handle('hqsf:sync-pull', async () => {
    const token = getStoredToken()
    const uid = String(getSession()?.userinfo?.uid ?? '')
    if (!token || !uid) return fail(new Error('未登录，无法同步'))
    try {
      return ok(await pullRemote(token, uid))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:sync-push', async (_e, filePath: string, isDraft: boolean) => {
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法同步'))
    try {
      return ok(isDraft ? await pushToDraft(token, filePath) : await publish(token, filePath))
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 本地存档 ----
  ipcMain.handle('hqsf:get-docs-root', () => ok(getDocsRoot()))

  // 在系统文件管理器中打开本地存档目录
  ipcMain.handle('hqsf:open-docs-dir', async () => {
    try {
      const root = ensureDocsRoot()
      const err = await shell.openPath(root)
      return err ? fail(new Error(err)) : ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:list-local-docs', () => {
    try {
      return ok(listLocalDocs())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:read-local-file', (_e, path: string) => {
    try {
      return ok(readLocalFile(getDocsRoot(), path))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:write-local-file', (_e, path: string, content: string) => {
    try {
      writeLocalFile(getDocsRoot(), path, content)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:create-local-draft', (_e, title: string, content: string) => {
    try {
      return ok(createLocalDraft(getDocsRoot(), title, content))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:choose-docs-dir', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return ok(await chooseDocsDir(win))
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 四态索引 ----
  ipcMain.handle('hqsf:list-articles', () => {
    try {
      return ok(listArticles())
    } catch (err) {
      return fail(err)
    }
  })
}
