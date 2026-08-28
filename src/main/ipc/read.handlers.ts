import { ipcMain } from 'electron'
import { getSession, getStoredToken } from '../services/auth-service'
import { ArticleUnavailableError, fetchRemoteArticle, listRemoteArticles } from '../services/read-service'
import type { ArticleListOptions } from '../../shared/types'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerReadHandlers(): void {
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
    const rawUid = getSession()?.userinfo?.uid ?? getSession()?.userinfo?.id
    const uid = rawUid == null ? undefined : typeof rawUid === 'number' ? rawUid : String(rawUid)
    try {
      // v0.0.6：token 可空——未登录也允许尝试匿名读公开文章
      return ok(await fetchRemoteArticle(token, String(cid), uid))
    } catch (err) {
      // v0.0.6：仅当服务端确认文章不可读（未公开/不存在）时才提示登录；
      // 网络故障等传输错误按原样报错，避免误标「需要登录」；
      // 剥离 ArticleUnavailableError 自带的「拉取文章失败: 」前缀，避免与「阅读全文需要登录（…）」重复
      if (!token && err instanceof ArticleUnavailableError) {
        const inner = (err as Error).message.replace(/^拉取文章失败:\s*/, '')
        return fail(new Error(`阅读全文需要登录（${inner}）`))
      }
      return fail(err)
    }
  })
}

