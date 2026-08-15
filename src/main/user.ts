import { apiRequest, endpoint } from './net/api'
import { fetchCommentsBySearchParams, getOngoingReviewMids, listRemoteArticles, num, str, toReviewItem } from './read'
import { sanitizeReviewList } from './activity-rules'
import type {
  ClockResult,
  CommentItem,
  FollowFeedItem,
  RemoteArticle,
  ReviewItem,
  SelfStatus,
  UserFollowItem,
  UserMarkItem,
  UserProfile,
  UserStats
} from '../shared/types'

/**
 * 用户系统适配层（design.md v0.0.8，hqUsers/ + hqUserlog/markList + 签到）。
 * 动态条目补充文章摘要/评分与评审文章评分回退，供用户页动态卡复用。
 * 接口实测结论（2026-08-15，官方 H5 源码 + 线上匿名探测）：
 * - userInfo?key=uid 公开；userData 需登录且用 uid（不是 key）；
 * - fanList 用 touid（用 uid 会拿到全站错数据）；followList 用 uid；
 * - contentsList/commentsList 的 authorId 必须保持数字，字符串会返回空 data；
 * - isFollow 的 code 0/1 即关注状态（不能走统一 envelope 抛错）；
 * - 签到 = addLog {type:"clock"}，成功响应顶层 clockData.award/addExp。
 */

type ListData = Record<string, unknown>[] | null

/** 可选数字字段（0 是有效值，不能 ?? 吞掉） */
function optNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** uid 规整：服务端过滤参数要求数字（官方 H5 传数字，字符串会导致列表为空） */
function uidNum(v: number | string): number | string {
  if (typeof v === 'number') return v
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : v
}

/** 用户资料（hqUsers/userInfo?key=uid；公开可读） */
export async function getUserProfile(_token: string | null, uid: number | string): Promise<UserProfile> {
  const resp = await apiRequest<Record<string, unknown>>(endpoint('userInfo').path, {
    method: 'GET',
    query: { key: String(uid) }
  })
  const d = (resp.data ?? {}) as Record<string, unknown>
  return {
    uid: str(d.uid ?? uid),
    name: str(d.screenName ?? d.name ?? ''),
    screenName: str(d.screenName) || undefined,
    avatar: str(d.avatar) || undefined,
    introduce: str(d.introduce) || undefined,
    userBg: str(d.userBg) || undefined,
    experience: optNum(d.experience),
    lv: d.lv != null && d.lv !== '' ? (d.lv as number | string) : undefined,
    assets: optNum(d.assets),
    groupKey: str(d.groupKey) || undefined
  }
}

/** 用户计数（hqUsers/userData?uid=；需登录，未登录返回 null 由渲染层降级） */
export async function getUserStats(token: string | null, uid: number | string): Promise<UserStats | null> {
  if (!token) return null
  const resp = await apiRequest<Record<string, unknown>>(endpoint('userData').path, {
    method: 'GET',
    query: { uid: String(uid), token }
  })
  const d = (resp.data ?? {}) as Record<string, unknown>
  return {
    fanNum: num(d.fanNum),
    contentsNum: num(d.contentsNum),
    commentsNum: num(d.commentsNum),
    isClock: num(d.isClock)
  }
}

/** 当前账号状态（hqUsers/userStatus?token；能量币/经验/等级） */
export async function getSelfStatus(token: string | null): Promise<SelfStatus | null> {
  if (!token) return null
  const resp = await apiRequest<Record<string, unknown>>(endpoint('userStatus').path, {
    method: 'GET',
    query: { token }
  })
  const d = (resp.data ?? {}) as Record<string, unknown>
  return {
    assets: num(d.assets),
    experience: optNum(d.experience),
    lv: d.lv != null && d.lv !== '' ? (d.lv as number | string) : undefined
  }
}

/** 查询是否关注（isFollow code 1=已关注 0=未关注；未登录返回 false） */
export async function getFollowState(token: string | null, touid: number | string): Promise<boolean> {
  if (!token) return false
  const json = await apiRequest<{ code?: number }>(endpoint('isFollow').path, {
    method: 'GET',
    query: { token, touid: String(touid) },
    raw: true
  })
  return json.code === 1
}

/** 关注/取关（follow type 1=关注 0=取关，GET） */
export async function setFollow(
  token: string | null,
  touid: number | string,
  follow: boolean
): Promise<{ ok: boolean; error?: string }> {
  if (!token) return { ok: false, error: '未登录，无法关注' }
  try {
    const resp = await apiRequest(endpoint('follow').path, {
      method: 'GET',
      query: { token, touid: String(touid), type: follow ? 1 : 0 }
    })
    if (resp.code === 1) return { ok: true }
    return { ok: false, error: resp.msg || '操作失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 关注/粉丝条目规整（userJson 为目标用户信息） */
function toUserFollowItem(item: Record<string, unknown>): UserFollowItem {
  const userJson = (item.userJson as Record<string, unknown> | undefined) ?? {}
  return {
    uid: str(item.uid ?? userJson.uid ?? ''),
    touid: str(item.touid ?? ''),
    created: Number(item.created ?? 0) || 0,
    userJson,
    name: str(userJson.name ?? userJson.nickname ?? userJson.screenName ?? ''),
    avatar: str(userJson.avatar) || undefined,
    introduce: str(userJson.introduce) || undefined,
    experience: optNum(userJson.experience)
  }
}

/** 关注列表（followList uid=目标用户；uid/touid 与目标关系见官方 H5 源码） */
export async function listFollows(
  token: string | null,
  uid: number | string,
  page = 1,
  limit = 20
): Promise<{ items: UserFollowItem[]; total: number }> {
  const query: Record<string, unknown> = { uid: String(uid), limit, page }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('followList').path, { method: 'GET', query })
  return {
    items: (resp.data ?? []).map(toUserFollowItem),
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 粉丝列表（fanList 必须用 touid；uid 参数会返回全站粉丝数据，2026-08-15 实测） */
export async function listFans(
  token: string | null,
  touid: number | string,
  page = 1,
  limit = 20
): Promise<{ items: UserFollowItem[]; total: number }> {
  const query: Record<string, unknown> = { touid: String(touid), limit, page }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('fanList').path, { method: 'GET', query })
  return {
    items: (resp.data ?? []).map(toUserFollowItem),
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 收藏文章元数据缓存（markList 不返回 active，按 cid 查一次文章列表补 hideScore；TTL 5 分钟） */
const markArticleMetaCache = new Map<string, { at: number; meta: RemoteArticle | null }>()
async function getMarkArticleMeta(token: string | null, cid: string): Promise<RemoteArticle | null> {
  const cached = markArticleMetaCache.get(cid)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.meta
  try {
    const res = await listRemoteArticles(token, { searchParams: { cid }, limit: 2, order: 'created' })
    const hit = res.items.find((a) => String(a.cid) === cid) ?? null
    markArticleMetaCache.set(cid, { at: Date.now(), meta: hit })
    return hit
  } catch {
    markArticleMetaCache.set(cid, { at: Date.now(), meta: null })
    return null
  }
}

/** 收藏列表条目规整（markList 仅本人；官方 usermark 页直接按文章卡渲染） */
function toMarkItem(item: Record<string, unknown>): UserMarkItem {
  return {
    cid: str(item.cid ?? item.id ?? ''),
    title: str(item.title ?? '未命名'),
    type: str(item.type) || undefined,
    text: str(item.text) || undefined,
    cover: str(item.cover) || undefined,
    images: Array.isArray(item.images) ? (item.images as unknown[]).map(String) : undefined,
    score: str(item.score) || undefined,
    views: num(item.views) || undefined,
    likes: num(item.likes) || undefined,
    commentsNum: num(item.commentsNum) || undefined,
    created: optNum(item.created),
    size: optNum(item.size),
    authorId: str(item.authorId ?? '') || undefined,
    authorInfo: (item.authorInfo as Record<string, unknown> | undefined) ?? undefined,
    active: Array.isArray(item.active)
      ? (item.active as unknown[]).map((a) => {
          const o = (a ?? {}) as Record<string, unknown>
          return { mid: str(o.mid ?? o.id ?? ''), name: str(o.name) || undefined, type: str(o.type) || undefined }
        })
      : null
  }
}

/** 有并发上限的异步遍历（收藏回查 / 动态聚合等扇出场景防触发风控） */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        await fn(next)
      }
    })
  )
}

/** 我的收藏（hqUserlog/markList?token；仅本人） */
export async function listMarks(
  token: string | null,
  page = 1,
  limit = 20
): Promise<{ items: UserMarkItem[]; total: number }> {
  if (!token) return { items: [], total: 0 }
  const resp = await apiRequest<ListData>(endpoint('markList').path, {
    method: 'GET',
    query: { token, limit, page }
  })
  const items = (resp.data ?? []).map(toMarkItem)
  // 收藏文章同样遵守活动评分隔离；markList 通常不返回 active，按 cid 回查文章列表补标记
  const mids = await getOngoingReviewMids(token)
  await mapLimit(items, 4, async (m) => {
    const knownHidden = (m.active ?? []).some((a) => mids.has(String(a.mid)))
    if (knownHidden) {
      m.score = '-.-'
      m.hideScore = true
      return
    }
    if (m.active == null || m.active.length === 0) {
      const meta = await getMarkArticleMeta(token, m.cid)
      if (meta?.hideScore === true) {
        m.score = '-.-'
        m.hideScore = true
      }
    }
  })
  return {
    items,
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 用户发表的文章（contentsList searchParams authorId 必须为数字） */
export async function listUserArticles(
  token: string | null,
  uid: number | string,
  page = 1,
  limit = 20
): Promise<{ items: RemoteArticle[]; total: number }> {
  return listRemoteArticles(token, {
    searchParams: { type: 'post', authorId: uidNum(uid) },
    limit,
    page,
    order: 'created'
  })
}

/** 用户发表的评审（reviewList searchParams={uid}） */
export async function listUserReviews(
  token: string | null,
  uid: number | string,
  page = 1,
  limit = 20
): Promise<{ items: ReviewItem[]; total: number }> {
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({ uid: String(uid) }),
    limit,
    page,
    order: 'created'
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('reviewList').path, { method: 'GET', query })
  const items = sanitizeReviewList((resp.data ?? []).map(toReviewItem), await getOngoingReviewMids(token))
  return {
    items,
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 用户发表的评论（commentsList searchParams={type:"comment", authorId}；authorId 数字） */
export async function listUserComments(
  token: string | null,
  uid: number | string,
  page = 1,
  limit = 20
): Promise<{ items: CommentItem[]; total: number }> {
  return fetchCommentsBySearchParams(
    token,
    { type: 'comment', authorId: uidNum(uid) },
    limit,
    page,
    'created'
  )
}

/** 评论是否关联评审（reviewid>0 即评审讨论） */
function reviewIdOf(c: CommentItem): string | null {
  const v = c.reviewid
  if (v == null || String(v) === '' || String(v) === '0') return null
  return String(v)
}

/** 动态条目：文章 */
function toFeedArticle(
  u: { uid: string; name: string; avatar?: string; experience?: number },
  a: RemoteArticle,
  hideScore: boolean
): FollowFeedItem {
  return {
    kind: 'article',
    created: a.created,
    uid: u.uid,
    userName: u.name,
    avatar: u.avatar,
    experience: u.experience,
    cid: a.cid,
    articleTitle: a.title,
    text: a.text || undefined,
    score: hideScore ? undefined : a.score && a.score !== '-.-' ? a.score : undefined,
    hideScore,
    views: a.views,
    likes: a.likes,
    commentsNum: a.commentsNum,
    size: a.size
  }
}

/** 动态条目：评审 */
function toFeedReview(
  u: { uid: string; name: string; avatar?: string; experience?: number },
  r: ReviewItem,
  hideScore: boolean
): FollowFeedItem {
  const info = r.articleInfo as Record<string, unknown> | undefined
  // 评审自身评分缺失（如往期活动 actualscore='-.-'）时，回退展示文章评分；
  // 但进行中/评审中活动的文章不暴露评分
  const actual = str(r.actualscore)
  const articleScore = str(info?.score)
  const score =
    hideScore ? undefined : actual && actual !== '-.-' ? actual : articleScore && articleScore !== '-.-' ? articleScore : undefined
  return {
    kind: 'review',
    created: r.created ?? 0,
    uid: u.uid,
    userName: u.name,
    avatar: u.avatar,
    experience: u.experience,
    cid: str(r.cid ?? ''),
    articleTitle: str(info?.title ?? ''),
    reviewId: str(r.id),
    text: str(r.zonghe ?? '').trim() || str(r.dianzi ?? '').trim() || undefined,
    score,
    hideScore,
    replyNum: num(r.replyNum) || undefined
  }
}

/** 动态条目：评论 / 评审评论 */
function toFeedComment(u: { uid: string; name: string; avatar?: string; experience?: number }, c: CommentItem): FollowFeedItem {
  const rid = reviewIdOf(c)
  return {
    kind: rid ? 'review_comment' : 'comment',
    created: c.created,
    uid: u.uid,
    userName: u.name,
    avatar: u.avatar,
    experience: u.experience,
    cid: String(c.cid ?? ''),
    articleTitle: c.articleTitle,
    commentId: String(c.coid),
    text: c.text,
    reviewid: rid ?? undefined
  }
}

/**
 * 关注动态聚合（design.md v0.0.8「动态」）：
 * 拉取本人关注列表（上限 maxUsers），并发抓取每个关注者的最新文章/评审/评论（各 limitPerUser 条），
 * 评审评论由评论条目 reviewid>0 拆分得到；按 created 倒序合并，cap 条数。
 * 无单接口支持，采用扇出聚合；并发 4 路 + 单路失败不影响整体。
 */
export async function listFollowFeed(
  token: string | null,
  selfUid: number | string,
  opts: { maxUsers?: number; limitPerUser?: number; cap?: number } = {}
): Promise<FollowFeedItem[]> {
  if (!token) return []
  const maxUsers = opts.maxUsers ?? 100
  const limitPerUser = opts.limitPerUser ?? 5
  const cap = opts.cap ?? 300

  const follows = await listFollows(token, selfUid, 1, maxUsers)
  const targets = follows.items.map((f) => ({
    uid: str(f.userJson?.uid ?? f.touid),
    name: str(f.name ?? f.userJson?.name ?? ''),
    avatar: f.avatar,
    experience: f.experience
  }))

  const feed: FollowFeedItem[] = []
  const queue = [...targets]
  const collect = async (u: (typeof targets)[number]): Promise<void> => {
    const uid = uidNum(u.uid)
    const [articles, reviews, comments] = await Promise.all([
      listUserArticles(token, uid, 1, limitPerUser).catch(() => ({ items: [] as RemoteArticle[], total: 0 })),
      listUserReviews(token, uid, 1, limitPerUser).catch(() => ({ items: [] as ReviewItem[], total: 0 })),
      listUserComments(token, uid, 1, limitPerUser).catch(() => ({ items: [] as CommentItem[], total: 0 }))
    ])
    for (const a of articles.items) {
      // 进行中/评审中活动：文章脱敏后 hideScore=true，动态作者展示名同步匿名化
      const hideScore = a.hideScore === true
      const articleUser = hideScore
        ? { uid: u.uid, name: '匿名用户', avatar: undefined, experience: u.experience }
        : u
      feed.push(toFeedArticle(articleUser, a, hideScore))
    }
    for (const r of reviews.items) {
      feed.push(toFeedReview(u, r, r.hideScore === true))
    }
    for (const c of comments.items) feed.push(toFeedComment(u, c))
  }

  const workerCount = Math.min(4, queue.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        try {
          await collect(next)
        } catch {
          // 单个关注者聚合失败不阻塞整体动态流
        }
      }
    })
  )

  return feed.sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).slice(0, cap)
}

/** 签到（addLog type=clock；成功后回读 userStatus 拿最新能量币余额） */
export async function clockIn(token: string | null): Promise<ClockResult> {
  if (!token) return { ok: false, error: '未登录，无法签到' }
  try {
    const json = await apiRequest<{
      code?: number
      msg?: string
      clockData?: { award?: number; addExp?: number }
    }>(endpoint('addLog').path, {
      method: 'GET',
      query: { params: JSON.stringify({ type: 'clock' }), token },
      raw: true
    })
    if (json.code !== 1) return { ok: false, error: json.msg || '签到失败' }
    const status = await getSelfStatus(token)
    return {
      ok: true,
      award: optNum(json.clockData?.award),
      addExp: optNum(json.clockData?.addExp),
      assets: status?.assets
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
