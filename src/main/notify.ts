import { apiRequest, endpoint } from './net/api'
import { num, normTs, str } from './read'
import type { AppNotification, CommentItem, NotificationCategory, ReviewItem } from '../shared/types'

const INBOX_TYPES: NotificationCategory[] = ['comment', 'review', 'finance', 'system']

/** 从消息原始字段推断分类（服务端 type 已是 comment/review/finance/system/postComment） */
function categorize(item: Record<string, unknown>): NotificationCategory {
  const raw = str(item.type ?? item.typeid ?? item.cate ?? item.category ?? item.kind ?? item.msgtype).toLowerCase()
  if (raw.includes('review') || raw.includes('评审')) return 'review'
  if (raw.includes('comment') || raw.includes('reply') || raw.includes('评论') || raw === 'postcomment') return 'comment'
  if (raw.includes('finance') || raw.includes('pay') || raw.includes('coin') || raw.includes('asset') || raw.includes('财务')) return 'finance'
  if (raw.includes('system') || raw.includes('系统')) return 'system'
  const text = str(item.content ?? item.text ?? item.msg ?? item.message ?? '').toLowerCase()
  if (/评审|评价/.test(text)) return 'review'
  if (/评论|回复/.test(text)) return 'comment'
  if (/pay|finance|coin|asset|withdraw|recharge|能量币|收益|提现|充值/.test(text)) return 'finance'
  return 'system'
}

function toCommentItem(item: Record<string, unknown>, text: string, time: number, userJson: Record<string, unknown>): CommentItem {
  const contentsInfo = (item.contentsInfo as Record<string, unknown> | undefined) ?? {}
  const uid = str(item.uid ?? item.authorId ?? item.fromUid ?? userJson.uid ?? '')
  return {
    // 注意：收件箱顶层 id 是消息记录 id，顶层 cid 是评论 coid，
    // 文章 cid 在 contentsInfo.cid
    coid: str(item.coid ?? item.commentId ?? item.cid ?? item.id ?? ''),
    cid: str(contentsInfo.cid ?? item.articleId ?? item.key ?? item.cid ?? ''),
    parent: str(item.parent ?? '0'),
    text,
    articleTitle: str(item.contenTitle ?? item.articleTitle ?? item.article_title ?? contentsInfo.title ?? ''),
    articleAuthorId: item.articleAuthorId != null ? str(item.articleAuthorId) : undefined,
    articleIsAnonymous: item.articleIsAnonymous != null ? !!item.articleIsAnonymous : undefined,
    experience: item.experience != null ? num(item.experience) : userJson.experience != null ? num(userJson.experience) : undefined,
    reviewAuthor: item.reviewAuthor != null ? str(item.reviewAuthor) : undefined,
    author: str(item.author ?? item.userName ?? userJson.name ?? userJson.nickname ?? '匿名'),
    authorId: uid,
    avatar: str(item.avatar ?? userJson.avatar ?? userJson.headImg ?? '') || undefined,
    created: time,
    reviewid: item.reviewid != null ? str(item.reviewid) : undefined
  }
}

function toReviewItem(item: Record<string, unknown>, text: string, time: number, userJson: Record<string, unknown>): ReviewItem {
  const contentsInfo = (item.contentsInfo as Record<string, unknown> | undefined) ?? {}
  const articleInfo = (item.articleInfo as Record<string, unknown> | undefined) ?? {}
  const title = str(item.contenTitle ?? item.articleTitle ?? articleInfo.title ?? contentsInfo.title ?? '')
  return {
    id: str(item.rid ?? item.reviewId ?? item.id ?? ''),
    // 注意：收件箱顶层 cid 不是文章 cid，文章 cid 在 contentsInfo.cid
    cid: str(contentsInfo.cid ?? item.articleId ?? item.key ?? item.cid ?? ''),
    uid: str(item.uid ?? userJson.uid ?? ''),
    actualscore: item.actualscore != null ? str(item.actualscore) : undefined,
    zonghe: text,
    replyNum: item.replyNum != null ? num(item.replyNum) : undefined,
    userJson,
    articleInfo: { ...articleInfo, title: title || undefined },
    created: time,
    hideScore: item.hideScore === true
  }
}

function toAppNotification(item: Record<string, unknown>): AppNotification {
  const id = str(item.id ?? item.mid ?? item.msgId ?? '')
  const text = str(item.content ?? item.text ?? item.msg ?? item.message ?? '')
  const title = str(item.title ?? '新消息')
  const time = normTs(item.addtime ?? item.created ?? item.time ?? item.addTime ?? 0)
  const userJson = (item.userJson as Record<string, unknown> | undefined) ?? {}
  const category = categorize(item)
  const contentsInfo = (item.contentsInfo as Record<string, unknown> | undefined) ?? {}

  const base: AppNotification = {
    id,
    category,
    title,
    text,
    time,
    // 真实收件箱没有逐条 read 标记，由 unreadNum 的分组未读数在 listInbox 里回填
    read: true,
    // 注意：收件箱顶层 cid 不是文章 cid，文章 cid 在 contentsInfo.cid
    cid: str(contentsInfo.cid ?? item.articleId ?? item.key ?? item.cid ?? '') || undefined
  }

  if (category === 'comment') {
    base.comment = toCommentItem(item, text, time, userJson)
  } else if (category === 'review') {
    base.review = toReviewItem(item, text, time, userJson)
  }

  return base
}

/** 解析 unreadNum 返回的分组未读数（data 可能是数字、{ total } 或 { total, comment, review, finance, system }） */
export async function getUnreadCounts(token: string): Promise<{ total: number; comment: number; review: number; finance: number; system: number }> {
  const ep = endpoint('unreadNum')
  const resp = await apiRequest<unknown>(ep.path, {
    method: ep.method,
    ...(ep.method === 'POST' ? { body: { token } } : { query: { token } })
  })
  const data = resp.data
  if (typeof data === 'number') {
    return { total: data, comment: 0, review: 0, finance: 0, system: 0 }
  }
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    return {
      total: num(d.total ?? d.unread ?? d.count),
      comment: num(d.comment ?? d.comments ?? 0),
      review: num(d.review ?? d.reviews ?? 0),
      finance: num(d.finance ?? 0),
      system: num(d.system ?? 0)
    }
  }
  return { total: 0, comment: 0, review: 0, finance: 0, system: 0 }
}

/** 拉取某个分类的收件箱（hqUsers/inbox POST：type/token/limit/page） */
async function fetchInboxType(token: string, type: NotificationCategory, limit = 50): Promise<AppNotification[]> {
  const ep = endpoint('inbox')
  const resp = await apiRequest<unknown>(ep.path, {
    method: ep.method,
    ...(ep.method === 'POST'
      ? { body: { type, token, limit, page: 1 } }
      : { query: { type, token, limit, page: 1 } })
  })
  const data = resp.data
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { list?: unknown } | null)?.list)
      ? ((data as { list: unknown[] }).list)
      : Array.isArray((data as { items?: unknown } | null)?.items)
        ? ((data as { items: unknown[] }).items)
        : []
  return raw.map((it) => toAppNotification((it ?? {}) as Record<string, unknown>))
}

/** 拉取全部四类收件箱并按未读分组数回填 read 标记 */
export async function listInbox(token: string): Promise<AppNotification[]> {
  const [grouped, unread] = await Promise.all([
    Promise.all(INBOX_TYPES.map((type) => fetchInboxType(token, type))),
    getUnreadCounts(token)
  ])

  const all: AppNotification[] = []
  for (let i = 0; i < INBOX_TYPES.length; i++) {
    const type = INBOX_TYPES[i]
    const items = grouped[i]
    // 按时间倒序，取前 N 条作为未读（服务端不返回逐条 read 时的最佳近似）
    const sorted = [...items].sort((a, b) => b.time - a.time)
    const unreadCount = unread[type] ?? 0
    sorted.forEach((n, idx) => {
      n.read = idx >= unreadCount
    })
    all.push(...sorted)
  }

  // 按时间倒序合并，id 去重
  const seen = new Set<string>()
  return all
    .sort((a, b) => b.time - a.time)
    .filter((n) => {
      if (!n.id || seen.has(n.id)) return false
      seen.add(n.id)
      return true
    })
}

/** 拉取未读消息总数（hqUsers/unreadNum） */
export async function getUnreadCount(token: string): Promise<number> {
  return (await getUnreadCounts(token)).total
}

/** 标记某几个分类已读（hqUsers/setRead GET：type 为评论/评审/财务/系统；不传 type 表示全部已读） */
export async function markNotificationsRead(token: string, categories: NotificationCategory[]): Promise<void> {
  const ep = endpoint('setRead')
  const list = [...new Set(categories.filter((c) => INBOX_TYPES.includes(c)))]
  await Promise.all(
    list.map((type) =>
      apiRequest(ep.path, {
        method: ep.method,
        ...(ep.method === 'POST' ? { body: { token, type } } : { query: { token, type } })
      })
    )
  )
}
