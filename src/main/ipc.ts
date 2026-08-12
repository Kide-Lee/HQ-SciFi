import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { loadAgreement, fetchHuangqiAgreement } from './agreement'
import {
  loginWithPassword,
  getSession,
  getStoredToken,
  verifySessionToken,
  logout as doLogout
} from './auth'
import { apiUrl, uploadMultipart } from './net/api'
import { endpoint } from './net/apiconfig'
import { getDocsRoot, ensureDocsRoot, listLocalDocs, readLocalFile, writeLocalFile, createLocalDraft, chooseDocsDir, deleteLocalFile, createLocalDir } from './fs'
import { pullRemote, pushToDraft, publish } from './sync'
import {
  addComment,
  addUserLog,
  fetchRemoteArticle,
  getMarkStatus,
  listCategories,
  listComments,
  listGptModels,
  listMetas,
  listRemoteArticles,
  listReviews,
  listReviewTasks,
  removeUserLog,
  setReviewAttitude,
  submitReview,
  checkTextBlockStatus
} from './read'
import { clearArticles, listArticles } from './db'
import type { ArticleListOptions, ReviewPayload } from '../shared/types'

/** IPC 返回约定：成功 { ok: true, data }，失败 { ok: false, error }（避免 Error 序列化丢 message） */
function ok<T>(data: T) {
  return { ok: true as const, data }
}

function fail(error: unknown) {
  return { ok: false as const, error: (error as Error).message }
}

export function registerIpcHandlers(): void {
  /** senderFrame 校验：只接受本应用渲染层页面（生产 file://、dev http://localhost），防其他页面借 IPC 通道 */
  function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame
    const url = frame?.url ?? ''
    return url.startsWith('file://') || /^https?:\/\/localhost(:\d+)?\//.test(url)
  }
  const trusted = (event: Electron.IpcMainInvokeEvent): Error | null =>
    isTrustedSender(event) ? null : new Error('非法调用来源')

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

  // 用户协议（登录前须阅读并同意）：返回 { version, html }，版本用于比对本地同意状态
  ipcMain.handle('hqsf:get-agreement', () => {
    try {
      return ok(loadAgreement())
    } catch (err) {
      return fail(err)
    }
  })

  // 荒启平台用户协议（网络抓取）：失败时渲染层禁用勾选、不可同意
  ipcMain.handle('hqsf:get-huangqi-agreement', async () => {
    try {
      return ok({ html: await fetchHuangqiAgreement() })
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 窗口控制（v0.0.3 无边框窗口自绘顶栏） ----
  const windowOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle('hqsf:window-minimize', (event) => {
    windowOf(event)?.minimize()
  })

  ipcMain.handle('hqsf:window-maximize-toggle', (event) => {
    const win = windowOf(event)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle('hqsf:window-close', (event) => {
    windowOf(event)?.close()
  })

  ipcMain.handle('hqsf:window-is-maximized', (event) => {
    return windowOf(event)?.isMaximized() ?? false
  })

  // ---- 认证与会话 ----
  ipcMain.handle('hqsf:login-password', async (_e, name: string, password: string) => {
    try {
      const res = await loginWithPassword(name, password)
      // 登录成功 = 可能切换账号：清空上一账号的本地索引，防止旧账号文章串到新账号侧栏四态
      if (res.ok) clearArticles()
      return ok(res)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:get-session', () => ok(getSession()))

  /**
   * v0.0.6：编辑器「插入图片」——弹系统文件选择框，选中图片上传荒启（upload/full）后返回 URL。
   * 取消选择返回 { ok: true, data: null }；未登录/上传失败返回 { ok: false, error }。
   */
  ipcMain.handle('media:pick-upload-image', async () => {
    const token = getStoredToken()
    if (!token) return fail('未登录，无法上传图片')
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择要插入的图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    })
    if (canceled || !filePaths[0]) return ok(null)
    try {
      const file = filePaths[0]
      const url = await uploadMultipart(apiUrl(endpoint('uploadFile').path), token, basename(file), readFileSync(file))
      return ok({ url })
    } catch (err) {
      return fail(err)
    }
  })

  /** 校验当前会话 token 有效性（失效返回 valid:false；网络异常 reachable:false 不强制登出） */
  ipcMain.handle('hqsf:verify-session', async () => {
    try {
      return ok(await verifySessionToken())
    } catch (err) {
      return fail(err)
    }
  })

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

  ipcMain.handle('hqsf:create-local-draft', (_e, title: string, content: string, dirRel?: string) => {
    try {
      return ok(createLocalDraft(getDocsRoot(), title, content, dirRel ?? ''))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:delete-local-file', async (_e, path: string) => {
    try {
      await deleteLocalFile(getDocsRoot(), path)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:create-local-dir', (_e, rel: string) => {
    try {
      return ok(createLocalDir(getDocsRoot(), rel))
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

  // ---- 阅读（M2 读审一体） ----
  ipcMain.handle('hqsf:list-remote-articles', async (_e, opts: ArticleListOptions = {}) => {
    const token = getStoredToken()
    try {
      return ok(await listRemoteArticles(token, opts))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:get-remote-article', async (_e, cid: string) => {
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录，无法阅读全文'))
    try {
      return ok(await fetchRemoteArticle(token, String(cid)))
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 评审（M2 读审一体） ----
  ipcMain.handle('hqsf:list-reviews', async (_e, opts: { cid?: string; activeid?: number | string; limit?: number; page?: number; order?: string } = {}) => {
    const token = getStoredToken()
    try {
      return ok(await listReviews(token, opts))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:submit-review', async (_e, payload: ReviewPayload) => {
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

  ipcMain.handle('hqsf:set-review-attitude', async (_e, reviewId: number | string, type: number) => {
    const token = getStoredToken()
    if (!token) return fail(new Error('未登录'))
    try {
      return ok(await setReviewAttitude(token, reviewId, type))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:list-categories', async () => {
    const token = getStoredToken()
    try {
      return ok(await listCategories(token))
    } catch (err) {
      return fail(err)
    }
  })

  // ---- 内容浏览（M3：栏目树与 AI 模型） ----
  ipcMain.handle('hqsf:list-metas', async (_e, type: string) => {
    const token = getStoredToken()
    try {
      return ok(await listMetas(token, String(type ?? '')))
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * 违禁词检测（官方接口 hqContents/userTextBlockStatus，付费 5 能量币/次，腾讯云内容安全）。
   * 官方编辑器实现：POST { text: 标题+正文HTML, token } → code=1 时 msg 为检测结果。
   */
  ipcMain.handle('hqsf:check-forbidden', async (_e, title: string, text: string) => {
    try {
      const token = getStoredToken()
      if (!token) return fail('未登录')
      const res = await checkTextBlockStatus(token, String(title ?? ''), String(text ?? ''))
      return ok({ code: res.code, msg: res.msg })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('hqsf:list-gpt-models', async () => {
    const token = getStoredToken()
    try {
      return ok(await listGptModels(token))
    } catch (err) {
      return fail(err)
    }
  })

  // 评审任务（当前账号被分配的评审文章；uid 从会话取，渲染层不可伪造）
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

  // ---- 评论（hqComments/） ----
  ipcMain.handle('hqsf:list-comments', async (_e, cid: string, opts: { limit?: number; page?: number; order?: string } = {}) => {
    const blocked = trusted(_e)
    if (blocked) return fail(blocked)
    const token = getStoredToken()
    const key = String(cid ?? '').trim()
    if (!key) return fail(new Error('缺少文章 ID'))
    try {
      return ok(await listComments(token, key, opts))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    'hqsf:add-comment',
    async (_e, payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }) => {
      const blocked = trusted(_e)
      if (blocked) return fail(blocked)
      const token = getStoredToken()
      if (!token) return fail(new Error('未登录，无法评论'))
      if (!payload || typeof payload !== 'object') return fail(new Error('无效的评论数据'))
      const cid = String(payload.cid ?? '').trim()
      if (!cid) return fail(new Error('缺少目标文章 ID'))
      const text = String(payload.text ?? '').trim()
      if (text.length < 4) return fail(new Error('评论内容至少 4 个字'))
      if (text.length > 2000) return fail(new Error('评论内容过长（最多 2000 字）'))
      if (payload.parent != null && typeof payload.parent !== 'string' && typeof payload.parent !== 'number') {
        return fail(new Error('无效的回复目标'))
      }
      // v0.0.3：评论-评审关联（reviewid 透传；0/空视为不关联）
      if (payload.reviewid != null && typeof payload.reviewid !== 'string' && typeof payload.reviewid !== 'number') {
        return fail(new Error('无效的评审关联'))
      }
      try {
        return ok(await addComment(token, { cid, text, parent: payload.parent, reviewid: payload.reviewid }))
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- 用户互动（hqUserlog/：点赞 / 收藏 / 投币） ----
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
