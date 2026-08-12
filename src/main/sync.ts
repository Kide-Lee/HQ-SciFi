import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import TurndownService from 'turndown'
import { apiRequest, apiUrl, downloadBinary, endpoint, uploadMultipart, type ApiResponse } from './net/api'
import { mdToHtml } from './md2html'
import {
  assertInside,
  createLocalDraft,
  ensureDocsRoot,
  getDocsRoot,
  imageDirFor,
  sanitizeFileName,
  titleFromPath
} from './fs'
import {
  getArticleByCid,
  getArticleByFilePath,
  upsertArticle
} from './db'
import type { ArticleRow, ArticleType, PullResult, PushResult } from '../shared/types'
import { parseFrontmatter, type ArticleMeta } from '../shared/frontmatter'

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

/**
 * 拉取远端某类型文章列表（分页直到 total）。
 * 四态参数与官网 userpost 一致（对照 h5 pages-user-userpost）：
 * - 草稿：{ type: post_draft, authorId }（无 status）
 * - 已发布/待审核/已拒绝：{ type: post, status: publish|waiting|reject, authorId }
 * 注意：type=waiting/type=reject 不是合法 type（服务端只认 post/post_draft），
 * 待审核/已拒绝必须用 type=post + status 过滤，否则永远拉不到。
 */
async function listRemote(
  token: string,
  authorId: string,
  type: string,
  status?: string
): Promise<RemoteItem[]> {
  const items: RemoteItem[] = []
  let page = 1
  for (;;) {
    const resp = await apiRequest<RemoteItem[] | null>(endpoint('contentsList').path, {
      method: 'GET',
      query: {
        searchParams: JSON.stringify(status ? { type, status, authorId } : { type, authorId }),
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
      apiRequest<Record<string, unknown>>(endpoint('contentsInfo').path, {
        method: 'POST',
        body: { key: cid, token },
        raw: true
      }),
    () =>
      apiRequest<Record<string, unknown>>(endpoint('contentsInfo').path, {
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

/* ===== v0.0.6：文章配图双向同步（.image 隐藏目录） ===== */

/** md 中图片引用：![](...) 与 <img src="..."> */
const IMG_MD_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g
const IMG_HTML_RE = /<img[^>]+src="([^"]+)"/g

/** 是否 http(s) 图片地址（cdn.huangqisf.com 或任意 http 图） */
function isHttpImage(ref: string): boolean {
  return /^https?:\/\//i.test(ref)
}

/** 是否本地 .image 引用（相对或绝对 .image 路径） */
function isLocalImageRef(ref: string): boolean {
  return ref.includes('/.image/') || ref.startsWith('.image/') || ref.startsWith('./.image/')
}

/** 收集 md 中所有图片引用（md 语法 + HTML 标签去重） */
function collectImageRefs(md: string): Set<string> {
  const refs = new Set<string>()
  for (const m of md.matchAll(IMG_MD_RE)) refs.add(m[1])
  for (const m of md.matchAll(IMG_HTML_RE)) refs.add(m[1])
  return refs
}

/**
 * 拉取配图：把正文里的远端图片下载到 .image/<cid>/ 并改写 md 引用为相对路径。
 * 单张下载失败不阻塞（保持原 URL）；已存在的图片跳过（幂等）。
 */
async function pullArticleImages(md: string, root: string, cid: string): Promise<string> {
  const refs = [...collectImageRefs(md)].filter(isHttpImage)
  if (refs.length === 0) return md
  const imgDir = imageDirFor(root, cid)
  mkdirSync(imgDir, { recursive: true })
  let out = md
  for (const url of refs) {
    try {
      const filename = basename(decodeURIComponent(new URL(url).pathname)).replace(/[\\/:*?"<>|]/g, '_') || `img-${createHash('md5').update(url).digest('hex').slice(0, 8)}`
      const dest = join(imgDir, filename)
      if (!existsSync(dest)) writeFileSync(dest, await downloadBinary(url))
      // 引用改为相对草稿根的 .image/<cid>/<file>（统一用 / 分隔，跨平台）
      const relRef = './' + relative(root, dest).replace(/\\/g, '/')
      out = out.split(url).join(relRef)
    } catch {
      // 单张失败保持原 URL
    }
  }
  return out
}

/**
 * 推送配图：把 md 中本地 .image 引用逐张上传（upload/full），
 * 替换为远端 URL；任一张失败抛错（调用方整体失败，不落半成品）。
 */
async function uploadLocalImages(md: string, root: string, token: string): Promise<string> {
  const refs = [...collectImageRefs(md)].filter(isLocalImageRef)
  if (refs.length === 0) return md
  let out = md
  for (const ref of refs) {
    const abs = resolve(root, ref)
    if (!existsSync(abs)) continue // 本地文件缺失：保持原引用（编辑器里的无效路径，不阻塞推送）
    const buffer = readFileSync(abs)
    const url = await uploadMultipart(apiUrl(endpoint('uploadFile').path), token, basename(abs), buffer)
    out = out.split(ref).join(url)
  }
  return out
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
  const types: Array<{ type: ArticleType; remote: string; status?: string }> = [
    { type: 'post_draft', remote: 'post_draft' },
    { type: 'waiting', remote: 'post', status: 'waiting' },
    { type: 'post', remote: 'post', status: 'publish' },
    { type: 'reject', remote: 'post', status: 'reject' }
  ]

  for (const { type, remote, status } of types) {
    let items: RemoteItem[]
    try {
      items = await listRemote(token, authorId, remote, status)
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
          let md = markdown ? html : htmlToMd(html)
          // v0.0.6：下载配图到 .image/<cid> 并改写引用为本地相对路径
          md = await pullArticleImages(md, root, cid)
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
          let md = markdown ? html : htmlToMd(html)
          // v0.0.6：下载配图到 .image/<cid> 并改写引用为本地相对路径
          md = await pullArticleImages(md, root, cid)
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

/**
 * 从 contentsAdd/Update 响应提取真实 cid。
 * 仅当 data 为对象且含 cid/id 字段时可信；contentsAdd 实测成功返回 `data:1`（非 cid，
 * 见 api-research.md §10），裸数字/字符串一律视为未返回 cid——防止把 1 当 cid 入库
 * （假 cid 会在下次推送时误更新线上 id=1 的文章）。未取到时由调用方回查列表（findCidByTitle）。
 */
function extractCid(resp: ApiResponse<unknown>): string | undefined {
  const d = resp.data
  if (d == null || typeof d !== 'object') return undefined
  const cid = (d as { cid?: unknown; id?: unknown }).cid ?? (d as { cid?: unknown; id?: unknown }).id
  return cid != null ? String(cid) : undefined
}

/**
 * contentsAdd 成功但响应未携带 cid 时回查：在当前账号对应状态（草稿 post_draft / 发布 post）
 * 列表中按标题精确匹配，取 modified 最新一篇的真实 cid（同名文章可能有多篇）。
 */
async function findCidByTitle(token: string, title: string, isDraft: boolean): Promise<string | undefined> {
  const type = isDraft ? 'post_draft' : 'post'
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({ type }),
    limit: PAGE_SIZE,
    page: 1,
    order: 'modified',
    token
  }
  if (title) query.searchKey = title
  try {
    const resp = await apiRequest<RemoteItem[] | null>(endpoint('contentsList').path, {
      method: 'GET',
      query
    })
    const items = (resp.data ?? []).filter((it) => it.title === title)
    if (items.length === 0) return undefined
    items.sort((a, b) => normTs(b.modified) - normTs(a.modified))
    const cid = items[0]?.cid
    return cid != null ? String(cid) : undefined
  } catch {
    return undefined
  }
}

/**
 * 把元数据名称解析为服务端 mid（类型/标签/活动），组装提交 params。
 * v0.0.6：元信息改由发布表单提供，不再强制必选——缺失的字段不传（由服务端决定）。
 */
async function resolveMetaParams(
  token: string | null,
  meta: ArticleMeta
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {}
  if (meta.category) {
    const categoryMid = await metaNameToId(token, 'category', meta.category)
    if (categoryMid) params.category = categoryMid
  }

  if (meta.tags && meta.tags.length > 0) {
    const ids: string[] = []
    for (const t of meta.tags) {
      const id = await metaNameToId(token, 'tag', t)
      if (id) ids.push(id)
    }
    if (ids.length > 0) params.tag = ids.join(',') // 逗号分隔 mid 串（服务端约定）
  }
  if (meta.active) {
    const id = await metaNameToId(token, 'active', meta.active)
    if (id) params.active = id
  }
  if (meta.isopen !== undefined) params.isopen = meta.isopen ? 1 : 0
  return params
}

/** 名称 → mid（metasList 按 type+name 精确匹配） */
async function metaNameToId(token: string | null, type: string, name: string): Promise<string | undefined> {
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({ type }),
    limit: 200,
    page: 1,
    order: 'order'
  }
  if (token) query.token = token
  try {
    const resp = await apiRequest<Array<Record<string, unknown>>>(endpoint('metasList').path, {
      method: 'GET',
      query
    })
    const hit = (resp.data ?? []).find((m) => String(m.name ?? '') === name)
    const mid = hit?.mid ?? hit?.id
    return mid != null ? String(mid) : undefined
  } catch {
    return undefined
  }
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
  isDraft: boolean,
  metaOverride?: ArticleMeta
): Promise<PushResult> {
  const root = getDocsRoot()
  const abs = assertInside(root, filePath)
  const content = readFileSync(abs, 'utf8')
  const title = resolveTitle(abs, content)
  const existing = getArticleByFilePath(abs)
  const type: ArticleType = isDraft ? 'post_draft' : 'waiting'

  try {
    // v0.0.6：元数据改由发布表单提供（metaOverride）；frontmatter 不再记录元数据，
    // 同步到草稿（isDraft）不携带元数据。名称 → mid 映射缺失的字段不传。
    const meta = isDraft ? {} : (metaOverride ?? {})
    const metaParams = await resolveMetaParams(token, meta)
    // v0.0.6：本地配图（.image 引用）先上传，替换为远端 URL 后再转 HTML 提交；
    // 图片上传失败（抛错）→ 整体推送失败，不提交半成品正文
    const contentRemote = await uploadLocalImages(content, root, token)
    const html = mdToHtml(contentRemote)
    let cid: string | undefined = existing?.cid || undefined
    const params = { title, ...(cid ? { cid } : {}), ...metaParams }
    const body: Record<string, unknown> = {
      params: JSON.stringify(params),
      token,
      text: html,
      isSpace: 0,
      isDraft: isDraft ? 1 : 0,
      isMd: 0
    }
    const resp = cid
      ? await apiRequest(endpoint('contentsUpdate').path, { method: 'POST', body })
      : await apiRequest(endpoint('contentsAdd').path, { method: 'POST', body })
    if (!cid) {
      cid = extractCid(resp)
      if (!cid) {
        // 服务端未在响应中携带 cid（contentsAdd 实测返回 data:1）：回查列表匹配真实 cid
        cid = await findCidByTitle(token, title, isDraft)
      }
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
      // status 跟随推送结果：草稿清空、发布置 waiting（existing 分支也覆盖，防残留旧状态）
      status: isDraft ? '' : 'waiting',
      contentHash: contentHash(content),
      syncedAt: Date.now(),
      updatedAt: Date.now()
    })
    return { ok: true, cid, type }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 同步到草稿（无元数据；frontmatter 不再记录） */
export function pushToDraft(token: string, filePath: string): Promise<PushResult> {
  return upload(token, filePath, true)
}

/** 发布（元数据来自发布表单 metaOverride） */
export function publish(token: string, filePath: string, meta?: ArticleMeta): Promise<PushResult> {
  return upload(token, filePath, false, meta)
}

/** 供同步失败提示使用：取文件目录展示名 */
export function displayName(filePath: string): string {
  return basename(filePath)
}
