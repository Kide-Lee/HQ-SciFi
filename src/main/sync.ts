import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import TurndownService from 'turndown'
import { apiRequest, type ApiResponse } from './net/api'
import { mdToHtml } from './md2html'
import {
  assertInside,
  createLocalDraft,
  ensureDocsRoot,
  getDocsRoot,
  sanitizeFileName,
  titleFromPath
} from './fs'
import {
  getArticleByCid,
  getArticleByFilePath,
  upsertArticle
} from './db'
import type { ArticleRow, ArticleType, PullResult, PushResult } from '../shared/types'

/**
 * 同步引擎（design.md 数据同步章节）。
 * - 拉取：contentsList（type=post_draft|waiting|post|reject + authorId）→ 元数据入 SQLite；
 *   全部类型都经 contentsInfo 拉全文 → HTML→md 写本地文件（同一存档根目录，文件名区分）。
 * - 推送：本地 md → mdToHtml → contentsAdd/contentsUpdate（isDraft 0/1）。
 * 冲突策略：本地已修改（内容哈希 != 上次同步哈希）时保留本地，不回写远端。
 */

const PAGE_SIZE = 50

/** 远端列表条目（contentsList data 项的子集，字段见 api-research.md） */
interface RemoteItem {
  cid?: number | string
  title?: string
  type?: string
  status?: string
  authorId?: number | string
  modified?: number | string
  text?: string
  markdown?: number
}

/** 时间戳规整：统一为秒（远端可能给秒或毫秒） */
function normTs(v: number | string | undefined): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : n
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 非草稿文件落盘时的文件名前缀（四态同目录混放时便于区分，避免同标题文件混淆） */
const TYPE_FILE_PREFIX: Partial<Record<ArticleType, string>> = {
  waiting: '待审核',
  post: '已发布',
  reject: '已拒绝'
}

/** 按类型生成落盘显示名：草稿/本地用纯标题，其余加 [状态] 前缀 */
function localFileName(type: ArticleType, title: string): string {
  const prefix = TYPE_FILE_PREFIX[type]
  return prefix ? `[${prefix}] ${title}` : title
}

/** 本地文件相对上次同步是否被修改 */
function isLocalDirty(row: ArticleRow): boolean {
  try {
    const current = readFileSync(row.filePath, 'utf8')
    return contentHash(current) !== row.contentHash
  } catch {
    return false
  }
}

/** 拉取远端某类型文章列表（分页直到 total） */
async function listRemote(token: string, authorId: string, type: string): Promise<RemoteItem[]> {
  const items: RemoteItem[] = []
  let page = 1
  for (;;) {
    const resp = await apiRequest<RemoteItem[] | null>('hqContents/contentsList', {
      method: 'POST',
      body: {
        searchParams: JSON.stringify({ type, authorId }),
        limit: PAGE_SIZE,
        page,
        token
      }
    })
    const list = resp.data ?? []
    items.push(...list)
    const total = resp.total ?? list.length
    if (page * PAGE_SIZE >= total || list.length === 0) break
    page++
  }
  return items
}

/**
 * 拉取全文（HTML；contentsInfo 需登录）。markdown==1 时 text 为 md 原文。
 * 已实测确认两种调用形态：
 * - 编辑页：POST { key, token } —— 作者拉自己的文章/草稿，**草稿只能走这个**
 * - 阅读页：GET { key, isMd:0, token } —— 公开文章
 * GET 对未公开草稿返回「文章暂未公开访问」，因此 POST 优先、GET 回退。
 * 响应不遵循 {code,msg,data} 约定：成功返回裸文章对象 {title,text,...}，失败 {msg:'…'}。
 */
async function fetchFullText(token: string, cid: string): Promise<{ html: string; markdown: boolean }> {
  const attempts: Array<() => Promise<Record<string, unknown>>> = [
    () =>
      apiRequest<Record<string, unknown>>('hqContents/contentsInfo', {
        method: 'POST',
        body: { key: cid, token },
        raw: true
      }),
    () =>
      apiRequest<Record<string, unknown>>('hqContents/contentsInfo', {
        method: 'GET',
        query: { key: cid, isMd: 0, token },
        raw: true
      })
  ]
  let lastError = '未知错误'
  for (const attempt of attempts) {
    try {
      const obj = await attempt()
      if (obj && typeof obj.title === 'string') {
        return {
          html: typeof obj.text === 'string' ? obj.text : '',
          markdown: obj.markdown === 1
        }
      }
      lastError = typeof obj?.msg === 'string' ? obj.msg : JSON.stringify(obj).slice(0, 200)
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  throw new Error(`contentsInfo 拉取失败（POST/GET 均试）: ${lastError}`)
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
})

/** Quill HTML → md（拉回本地存档用） */
function htmlToMd(html: string): string {
  return turndown.turndown(html)
}

/** 从本地内容提取标题：首行 # 标题优先，否则用文件名 */
function resolveTitle(filePath: string, content: string): string {
  const first = content.split(/\r?\n/).find((l) => /^#\s+\S/.test(l.trim()))
  if (first) return first.trim().replace(/^#\s+/, '').trim()
  return sanitizeFileName(titleFromPath(filePath))
}

/**
 * 全量拉取：草稿与待审核/已发布/已拒绝统一拉全文落盘（同一存档根目录），
 * 元数据入 SQLite 索引。M1 无远端增量游标，做全量对比（列表已按 modified 排序时成本可控）。
 */
export async function pullRemote(token: string, authorId: string): Promise<PullResult> {
  const root = ensureDocsRoot()
  const result: PullResult = { pulled: 0, conflicts: 0, total: 0, errors: [] }
  const types: Array<{ type: ArticleType; remote: string }> = [
    { type: 'post_draft', remote: 'post_draft' },
    { type: 'waiting', remote: 'waiting' },
    { type: 'post', remote: 'post' },
    { type: 'reject', remote: 'reject' }
  ]

  for (const { type, remote } of types) {
    let items: RemoteItem[]
    try {
      items = await listRemote(token, authorId, remote)
    } catch (err) {
      // reject 类型可能不存在（接口未确认），静默忽略；其余记错误
      if (remote !== 'reject') result.errors.push(`${remote}: ${(err as Error).message}`)
      continue
    }
    result.total += items.length

    for (const item of items) {
      const cid = String(item.cid ?? '')
      if (!cid) continue
      const title = item.title ?? '未命名'
      const remoteModified = normTs(item.modified)
      const status = item.status ?? ''
      const existing = getArticleByCid(cid)

      // ---- 全文落盘（所有类型统一处理；文件名同目录靠命名规则区分） ----
      // 文件真实存在才算「已有本地副本」；被删除/失联时即使远端未更新也要重建
      const fileExists = !!existing?.filePath && existsSync(existing.filePath)
      if (existing && fileExists) {
        // 远端未更新但状态可能已流转（如 草稿→已发布）：先同步 type/status，
        // 避免索引停留在旧状态导致侧栏分组错误与推送保护失效
        if (existing.type !== type || existing.status !== status) {
          upsertArticle({ ...existing, title, type, status, updatedAt: Date.now() })
        }
        if (remoteModified <= existing.remoteModified) continue // 远端未更新
        if (isLocalDirty(existing)) {
          result.conflicts++
          // type 跟随服务端当前状态（文章可能在四态间流转，如草稿→已发布）
          upsertArticle({ ...existing, title, type, status, remoteModified, updatedAt: Date.now() })
          continue
        }
        try {
          const { html, markdown } = await fetchFullText(token, cid)
          const md = markdown ? html : htmlToMd(html)
          // 沿用既有 filePath 不重命名：四态流转后旧文件名的 [状态] 前缀可能过时
          // （如 已发布→草稿 后文件名仍带 [已发布]）。索引 type 已正确跟随，
          // 重命名会与渲染层正在打开的 currentPath 脱钩，故此处不迁移。
          writeFileSync(existing.filePath, md, 'utf8')
          upsertArticle({
            ...existing,
            title,
            type,
            status,
            remoteModified,
            contentHash: contentHash(md),
            localModified: Date.now(),
            syncedAt: Date.now(),
            updatedAt: Date.now()
          })
          result.pulled++
        } catch (err) {
          // reject 类型全文接口支持未确认，失败不进错误横幅（其余类型照常提示）
          if (remote !== 'reject') result.errors.push(`${title}: ${(err as Error).message}`)
        }
      } else {
        // 新建，或索引有记录但本地文件失联/被删：以远端内容重建本地文件
        try {
          const { html, markdown } = await fetchFullText(token, cid)
          const md = markdown ? html : htmlToMd(html)
          // 一律按当前命名规则生成新路径（非草稿加 [状态] 前缀，重名追加后缀）；
          // 不写回历史带时间戳的旧路径，索引的 filePath 随之更新
          const filePath = createLocalDraft(root, localFileName(type, title), md)
          upsertArticle({
            ...(existing ?? {
              cid,
              title,
              type,
              status,
              authorId,
              remoteModified,
              createdAt: Date.now()
            }),
            title,
            type,
            status,
            remoteModified,
            localModified: Date.now(),
            contentHash: contentHash(md),
            filePath,
            syncedAt: Date.now(),
            updatedAt: Date.now()
          })
          result.pulled++
        } catch (err) {
          if (remote !== 'reject') result.errors.push(`${title}: ${(err as Error).message}`)
        }
      }
    }
  }
  return result
}

interface AddResultData {
  cid?: number | string
  id?: number | string
}

/** 从 data 里取 cid（不同版本返回结构可能为对象或裸值） */
function extractCid(resp: ApiResponse<unknown>): string | undefined {
  const d = resp.data as AddResultData | string | number | null | undefined
  if (d == null) return undefined
  if (typeof d === 'object') {
    const cid = d.cid ?? d.id
    return cid != null ? String(cid) : undefined
  }
  return String(d)
}

/**
 * 上传本地 md 到荒启：无 cid → contentsAdd（新建），有 cid → contentsUpdate（覆盖）。
 * 服务端流转语义（用户确认）：草稿/待审核/已发布文章均可编辑后再推送，
 * isDraft=1 → 存回草稿，isDraft=0 → 发布进入待审核（waiting），由服务器裁决为 已发布/已拒绝。
 * @param isDraft true=存草稿（post_draft） false=发布（waiting）
 */
async function upload(
  token: string,
  filePath: string,
  isDraft: boolean
): Promise<PushResult> {
  const root = getDocsRoot()
  const abs = assertInside(root, filePath)
  const content = readFileSync(abs, 'utf8')
  const title = resolveTitle(abs, content)
  const html = mdToHtml(content)
  const existing = getArticleByFilePath(abs)
  const type: ArticleType = isDraft ? 'post_draft' : 'waiting'

  try {
    let cid: string | undefined = existing?.cid || undefined
    const params = { title, ...(cid ? { cid } : {}) }
    const body: Record<string, unknown> = {
      params: JSON.stringify(params),
      token,
      text: html,
      isSpace: 0,
      isDraft: isDraft ? 1 : 0,
      isMd: 0
    }
    const resp = cid
      ? await apiRequest('hqContents/contentsUpdate', { method: 'POST', body })
      : await apiRequest('hqContents/contentsAdd', { method: 'POST', body })
    if (!cid) {
      cid = extractCid(resp)
      // 上传成功但拿不到 cid 时不能静默入库：否则下次推送会重复创建远端文章
      if (!cid) {
        return { ok: false, error: '上传成功但未返回文章 ID，请到荒启草稿箱确认后再操作' }
      }
    }

    // 更新本地索引
    const row = existing ?? {
      cid: cid ?? '',
      title,
      type,
      status: isDraft ? '' : 'waiting',
      authorId: '',
      remoteModified: 0,
      localModified: Date.now(),
      contentHash: '',
      filePath: abs,
      syncedAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    upsertArticle({
      ...row,
      cid: cid ?? row.cid,
      title,
      type,
      contentHash: contentHash(content),
      syncedAt: Date.now(),
      updatedAt: Date.now()
    })
    return { ok: true, cid, type }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 同步到草稿 */
export function pushToDraft(token: string, filePath: string): Promise<PushResult> {
  return upload(token, filePath, true)
}

/** 发布 */
export function publish(token: string, filePath: string): Promise<PushResult> {
  return upload(token, filePath, false)
}

/** 供同步失败提示使用：取文件目录展示名 */
export function displayName(filePath: string): string {
  return basename(filePath)
}
