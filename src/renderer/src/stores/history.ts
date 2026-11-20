import { create } from 'zustand'
import { anonymousAuthorDisplayName, htmlToText, userDisplayName } from '../lib/sanitize'
import { isReviewDisabledArticle } from '../lib/category'
import {
  loadHistory,
  makeHistoryEntry,
  saveHistory,
  upsertHistory,
  type HistoryEntry
} from '../lib/readHistory'
import type { ArticleDetail, RemoteArticle } from '../../../shared/types'

/**
 * v1.1.12：阅读历史 store（右栏全局「历史」tab，所有视图可用）。
 *
 * 只记录「读过的远端文章」：`openArticle` 成功取到详情后，把详情规整成**列表字段
 * 快照**（`RemoteArticle`，交给列表/首页同款 `ArticleCard` 渲染）写一条记录；
 * 同篇去重后置顶并累计次数，条数上限 200。纯逻辑与持久化见 `lib/readHistory.ts`。
 */

/** 摘要截断长度（详情是 HTML 全文，取纯文本摘要，与列表接口 text 同量级） */
const EXCERPT_MAX = 120

/**
 * 详情 → 列表字段快照。
 * 作者展示名按匿名规则解析后写进 authorInfo（列表卡片直接读 authorInfo），
 * 匿名文章的展示名与头像一并脱敏，避免历史里漏出匿名作者。
 */
function snapshotOf(detail: ArticleDetail): RemoteArticle {
  const userJson = (detail.userJson ?? {}) as Record<string, unknown>
  const authorName = anonymousAuthorDisplayName(
    detail,
    detail.authorId,
    userDisplayName(userJson, '佚名')
  )
  const anonymous = authorName === '匿名用户' || authorName === '匿名'
  const excerpt = (detail.introduction?.trim() || htmlToText(detail.text ?? '')).slice(0, EXCERPT_MAX)
  return {
    cid: String(detail.cid),
    title: detail.title,
    type: detail.type ?? 'post',
    status: detail.status ?? '',
    score: String(detail.score ?? ''),
    text: excerpt,
    authorId: detail.authorId == null ? '' : String(detail.authorId),
    authorInfo: { ...userJson, nickname: authorName, name: authorName, avatar: anonymous ? '' : userJson.avatar },
    category: detail.category,
    collection: detail.collection,
    active: detail.active ?? null,
    introduction: detail.introduction,
    views: detail.views ?? 0,
    likes: detail.likes ?? 0,
    commentsNum: detail.commentsNum ?? 0,
    created: detail.created ?? 0,
    modified: detail.modified ?? detail.created ?? 0,
    size: detail.size,
    isAnonymous: detail.isAnonymous,
    // 不开启评审/不显示评分的分类（科幻杂谈/官方公告/外文翻译）：卡片隐藏评分
    hideScore: isReviewDisabledArticle(detail)
  }
}

interface HistoryState {
  entries: HistoryEntry[]
  /** 记录一次阅读：同篇去重后置顶，刷新时间与次数；无效详情不记 */
  record: (detail: ArticleDetail) => void
  /** 移除单条 */
  remove: (cid: string) => void
  /** 清空全部 */
  clear: () => void
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: loadHistory(),

  record: (detail) => {
    const cid = detail?.cid == null ? '' : String(detail.cid)
    // 详情不完整（无 cid / 无标题）不入历史，避免列表出现空卡片
    if (!cid || !detail?.title) return
    const prev = get().entries.find((e) => e.cid === cid)
    const entry = makeHistoryEntry(snapshotOf(detail), Date.now(), (prev?.count ?? 0) + 1)
    const entries = upsertHistory(get().entries, entry)
    saveHistory(entries)
    set({ entries })
  },

  remove: (cid) => {
    const entries = get().entries.filter((e) => e.cid !== cid)
    saveHistory(entries)
    set({ entries })
  },

  clear: () => {
    saveHistory([])
    set({ entries: [] })
  }
}))
