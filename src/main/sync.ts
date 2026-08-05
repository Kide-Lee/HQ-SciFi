import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
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
 * - 拉取：contentsList（type=post_draft|waiting|post + authorId）→ 元数据入 SQLite；
 *   草稿（post_draft）另经 contentsInfo 拉全文 → HTML→md 写本地文件。
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
 * 已从 h5 前端包实测确认（pages-contents-info chunk）：
 *   GET hqContents/contentsInfo?key=<cid>&isMd=0&token=<token>
 * 响应**不遵循 {code,msg,data} 约定**：成功返回裸文章对象 {title,text,...}（h5 以 data.title
 * 判断成功），失败返回 {msg:'该文章不存在'} 之类 —— 用 raw 模式解析，自行判断成功与否。
 */
async function fetchFullText(token: string, cid: string): Promise<{ html: string; markdown: boolean }> {
  const obj = await apiRequest<Record<string, unknown>>('hqContents/contentsInfo', {
    method: 'GET',
    query: { key: cid, isMd: 0, token },
    raw: true
  })
  if (obj && typeof obj.title === 'string') {
    return {
      html: typeof obj.text === 'string' ? obj.text : '',
      markdown: obj.markdown === 1
    }
  }
  const msg = typeof obj?.msg === 'string' ? obj.msg : ''
  throw new Error(msg || `contentsInfo 返回异常: ${JSON.stringify(obj).slice(0, 200)}`)
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
 * 全量拉取：草稿正文落本地，waiting/post/reject 建索引（侧栏四态展示）。
 * M1 无远端增量游标，做全量对比（列表已按 modified 排序时成本可控）。
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

      // 仅草稿需要正文落盘；其余只维护索引
      if (type !== 'post_draft') {
        if (existing) {
          upsertArticle({ ...existing, title, type, status, remoteModified, updatedAt: Date.now() })
        } else {
          upsertArticle({
            cid,
            title,
            type,
            status,
            authorId,
            remoteModified,
            localModified: 0,
            contentHash: '',
            filePath: '',
            syncedAt: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }
        continue
      }

      // ---- 草稿正文同步 ----
      if (existing && existing.filePath) {
        if (remoteModified <= existing.remoteModified) continue // 远端未更新
        if (isLocalDirty(existing)) {
          result.conflicts++
          upsertArticle({ ...existing, title, status, remoteModified, updatedAt: Date.now() })
          continue
        }
        try {
          const { html, markdown } = await fetchFullText(token, cid)
          const md = markdown ? html : htmlToMd(html)
          writeFileSync(existing.filePath, md, 'utf8')
          upsertArticle({
            ...existing,
            title,
            status,
            remoteModified,
            contentHash: contentHash(md),
            localModified: Date.now(),
            syncedAt: Date.now(),
            updatedAt: Date.now()
          })
          result.pulled++
        } catch (err) {
          result.errors.push(`${title}: ${(err as Error).message}`)
        }
      } else {
        // 新建（或索引有记录但本地文件失联）：以远端内容重建本地文件
        try {
          const { html, markdown } = await fetchFullText(token, cid)
          const md = markdown ? html : htmlToMd(html)
          const filePath = createLocalDraft(root, title, md)
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
          result.errors.push(`${title}: ${(err as Error).message}`)
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
 * @param isDraft true=存草稿（post_draft） false=直接发布（waiting）
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
