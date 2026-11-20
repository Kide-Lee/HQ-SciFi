/**
 * v1.1.12：阅读历史的纯逻辑与本地持久化（localStorage `hqsf-read-history`）。
 *
 * 每条记录 = 打开时的**文章列表字段快照**（`RemoteArticle`，直接交给列表/首页用的
 * `ArticleCard` 渲染，离线也能出卡片）+ 阅读时间与次数；同一篇去重后置顶并累计次数，
 * 条数上限 200（超出淘汰最久未读的）。
 *
 * 设备本地历史：不上传、不参与「设置→清除缓存」（图片 / 阅读 / 网络缓存）管理。
 * 本模块无本地 import（纯函数 + localStorage），便于 Node 侧直接回归。
 */

import type { RemoteArticle } from '../../../shared/types'

export const HISTORY_KEY = 'hqsf-read-history'
/** 历史条数上限（去重后；超出淘汰最久未读的） */
export const HISTORY_MAX = 200

export interface HistoryEntry {
  /** 文章 cid（列表 key / 去重 / 移除定位；与 article.cid 一致） */
  cid: string
  /** 最近一次打开时间（ms） */
  readAt: number
  /** 累计打开次数 */
  count: number
  /** 打开时的列表字段快照（`ArticleCard` 渲染用） */
  article: RemoteArticle
}

/** 包装成历史条目（cid 统一取自快照，避免两处不一致） */
export function makeHistoryEntry(article: RemoteArticle, readAt: number = Date.now(), count = 1): HistoryEntry {
  return { cid: String(article.cid), readAt, count, article }
}

/** 快照补齐：旧条目缺字段不让卡片渲染崩 */
function normalizeArticle(a: RemoteArticle): RemoteArticle {
  return {
    ...a,
    cid: String(a.cid),
    title: String(a.title),
    type: typeof a.type === 'string' ? a.type : 'post',
    status: typeof a.status === 'string' ? a.status : '',
    score: typeof a.score === 'string' ? a.score : '',
    text: typeof a.text === 'string' ? a.text : '',
    authorId: a.authorId == null ? '' : String(a.authorId),
    views: Number(a.views) || 0,
    likes: Number(a.likes) || 0,
    commentsNum: Number(a.commentsNum) || 0,
    created: Number(a.created) || 0,
    modified: Number(a.modified) || 0
  }
}

function isArticle(v: unknown): v is RemoteArticle {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  return typeof a.cid === 'string' && a.cid !== '' && typeof a.title === 'string'
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.cid === 'string' &&
    e.cid !== '' &&
    typeof e.readAt === 'number' &&
    Number.isFinite(e.readAt) &&
    isArticle(e.article)
  )
}

/** 写入一条记录：同篇去重后置顶，超出上限截断（返回新数组，不修改入参） */
export function upsertHistory(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...entries.filter((e) => e.cid !== entry.cid)].slice(0, HISTORY_MAX)
}

/** 读取历史表（缺失 / 损坏 / 旧格式按空表或跳过；缺字段的就地补齐） */
export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries
    if (!Array.isArray(list)) return []
    return list
      .filter(isEntry)
      .slice(0, HISTORY_MAX)
      .map((e) => ({
        cid: String(e.article.cid),
        readAt: e.readAt,
        count: typeof e.count === 'number' && e.count > 0 ? Math.floor(e.count) : 1,
        article: normalizeArticle(e.article)
      }))
  } catch {
    return []
  }
}

/** 持久化历史表（容量超限等失败静默，不影响正常阅读） */
export function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries))
  } catch {
    /* 忽略：历史写入失败不影响阅读 */
  }
}
