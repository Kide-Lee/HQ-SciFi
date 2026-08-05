import { apiRequest } from './net/api'
import type {
  ArticleDetail,
  ArticleListOptions,
  RemoteArticle,
  ReviewItem,
  ReviewPayload,
  ReviewSubmitResult
} from '../shared/types'

/**
 * 阅读与评审适配层（design.md M2 读审一体，api-research.md §3/§4）。
 * - 列表：contentsList（公开，带 token 更稳）/ getMetaContents（分类 mid）
 * - 详情：contentsInfo（需登录；GET 阅读形态，响应为裸对象）
 * - 评审：reviewList（公开，searchParams={cid} 过滤）、reviewInfo、
 *   addReview / editReview（GET + params JSON）、attitude
 * 接口变动只改这一处（design.md 风险 7：适配层隔离）。
 */

const PAGE_SIZE = 20

type ListData = Record<string, unknown>[] | null

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

/** 时间戳规整：统一为秒 */
function normTs(v: unknown): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : n
}

/** 列表条目 → RemoteArticle（字段做类型规整，缺失给默认值） */
function toRemoteArticle(item: Record<string, unknown>, index: number): RemoteArticle {
  return {
    cid: str(item.cid ?? item.id ?? ''),
    title: str(item.title ?? '未命名'),
    type: str(item.type),
    status: str(item.status),
    score: str(item.score),
    text: str(item.text),
    authorId: str(item.authorId ?? ''),
    authorInfo: (item.authorInfo as Record<string, unknown> | undefined) ?? undefined,
    category: item.category,
    tag: item.tag,
    collection: item.collection,
    cover: str(item.cover),
    introduction: str(item.introduction),
    views: num(item.views),
    likes: num(item.likes),
    commentsNum: num(item.commentsNum),
    created: normTs(item.created),
    modified: normTs(item.modified),
    isAnonymous: !!item.isAnonymous,
    active: Array.isArray(item.active) ? (item.active as Array<{ mid: number | string }>) : null,
    size: num(item.size) || undefined
  }
}

/** 拉取文章列表：分类（mid）走 getMetaContents，其余走 contentsList */
export async function listRemoteArticles(
  token: string | null,
  opts: ArticleListOptions = {}
): Promise<{ items: RemoteArticle[]; total: number }> {
  const limit = opts.limit ?? PAGE_SIZE
  const page = opts.page ?? 1
  const query: Record<string, unknown> = {
    limit,
    page,
    ...(opts.order ? { order: opts.order } : {})
  }
  if (token) query.token = token

  if (opts.mid != null) {
    query.searchParams = JSON.stringify({ mid: opts.mid })
    const resp = await apiRequest<ListData>('hqMetas/selectContents', {
      method: 'GET',
      query
    })
    return {
      items: (resp.data ?? []).map((it, i) => toRemoteArticle(it, i)),
      total: num(resp.total) || (resp.data ?? []).length
    }
  }

  query.searchParams = JSON.stringify(opts.searchParams ?? { type: 'post' })
  if (opts.searchKey) query.searchKey = opts.searchKey
  const resp = await apiRequest<ListData>('hqContents/contentsList', {
    method: 'GET',
    query
  })
  return {
    items: (resp.data ?? []).map((it, i) => toRemoteArticle(it, i)),
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 拉取文章详情（完整 HTML 正文；需登录）。contentsInfo 响应为裸对象 */
export async function fetchRemoteArticle(token: string, cid: string): Promise<ArticleDetail> {
  const obj = await apiRequest<Record<string, unknown>>('hqContents/contentsInfo', {
    method: 'GET',
    query: { key: cid, isMd: 0, token },
    raw: true
  })
  if (!obj || typeof obj.title !== 'string') {
    throw new Error(`拉取文章失败: ${str(obj?.msg) || '未公开或不存在'}`)
  }
  const userJson = obj.userJson as Record<string, unknown> | undefined
  const authorId =
    str(obj.authorId) ||
    str((userJson && (userJson.uid ?? userJson.id)) ?? '')
  return {
    cid,
    title: str(obj.title),
    text: str(obj.text),
    score: str(obj.score),
    authorId,
    userJson,
    views: num(obj.views),
    likes: num(obj.likes),
    commentsNum: num(obj.commentsNum),
    created: normTs(obj.created),
    modified: normTs(obj.modified),
    size: num(obj.size) || undefined,
    isAnonymous: !!obj.isAnonymous,
    category: obj.category,
    active: Array.isArray(obj.active) ? (obj.active as Array<{ mid: number | string }>) : null,
    markdown: num(obj.markdown)
  }
}

/** 评审条目规整 */
function toReviewItem(item: Record<string, unknown>): ReviewItem {
  return {
    id: str(item.id ?? item.rid ?? ''),
    cid: str(item.cid ?? item.key ?? ''),
    activeid: item.activeid != null ? str(item.activeid) : undefined,
    isAi: num(item.isAi),
    attitudeType: num(item.attitudeType),
    actualscore: str(item.actualscore),
    score: str(item.score),
    dianzi: str(item.dianzi),
    wenbi: str(item.wenbi),
    renwu: str(item.renwu),
    jiezou: str(item.jiezou),
    liyi: str(item.liyi),
    zonghe: str(item.zonghe),
    joy: num(item.joy),
    helpful: num(item.helpful),
    earnest: num(item.earnest),
    userJson: (item.userJson as Record<string, unknown> | undefined) ?? undefined,
    articleInfo: (item.articleInfo as Record<string, unknown> | undefined) ?? undefined,
    created: normTs(item.created)
  }
}

/** 拉取某文章（或某活动）的评审列表。reviewList 公开；searchParams={cid} 按文章过滤 */
export async function listReviews(
  token: string | null,
  opts: { cid?: string; activeid?: number | string; limit?: number; page?: number; order?: string } = {}
): Promise<{ items: ReviewItem[]; total: number }> {
  const searchParams: Record<string, unknown> = {}
  if (opts.cid) searchParams.cid = opts.cid
  if (opts.activeid != null && opts.activeid !== 0) searchParams.activeid = opts.activeid
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify(searchParams),
    limit: opts.limit ?? PAGE_SIZE,
    page: opts.page ?? 1,
    ...(opts.order ? { order: opts.order } : {})
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>('review/reviewList', {
    method: 'GET',
    query
  })
  return {
    items: (resp.data ?? []).map(toReviewItem),
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 组装评审提交参数（addReview/editReview 共用；score 为逗号分隔分数串） */
function reviewParams(p: ReviewPayload): Record<string, unknown> {
  const params: Record<string, unknown> = {
    dianzi: p.dianzi,
    wenbi: p.wenbi,
    renwu: p.renwu,
    jiezou: p.jiezou,
    liyi: p.liyi,
    dianziScore: p.dianziScore,
    wenbiScore: p.wenbiScore,
    renwuScore: p.renwuScore,
    jiezouScore: p.jiezouScore,
    liyiScore: p.liyiScore,
    cid: p.cid,
    score: [p.dianziScore, p.wenbiScore, p.jiezouScore, p.renwuScore, p.liyiScore].join(',')
  }
  if (p.zonghe) params.zonghe = p.zonghe
  if (p.activeid != null && p.activeid !== 0) params.activeid = p.activeid
  if (p.id != null && p.id !== '') params.id = p.id
  return params
}

/** 提交评审；p.id 存在时走 editReview，否则 addReview。GET + params JSON（官方实测） */
export async function submitReview(token: string, payload: ReviewPayload): Promise<ReviewSubmitResult> {
  try {
    const endpoint = payload.id != null && payload.id !== '' ? 'review/editReview' : 'review/addReview'
    const resp = await apiRequest<{ msg?: string }>(endpoint, {
      method: 'GET',
      query: { params: JSON.stringify(reviewParams(payload)), token }
    })
    if (resp.code === 1) return { ok: true }
    return { ok: false, error: resp.msg || '提交失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 评审态度表态：type 0=joy 开心 / 1=helpful 有用 / 2=earnest 认真 */
export async function setReviewAttitude(
  token: string,
  reviewId: number | string,
  type: number
): Promise<ReviewSubmitResult> {
  try {
    const resp = await apiRequest('review/attitude', {
      method: 'GET',
      query: { token, id: reviewId, type }
    })
    if (resp.code === 1) return { ok: true }
    return { ok: false, error: resp.msg || '表态失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 作品库分类（hqMetas/metasList，type=category；返回 mid/name/slug/count 等） */
export interface CategoryMeta {
  mid: number | string
  name: string
  slug: string
  description?: string
  count?: number
}

export async function listCategories(token: string | null): Promise<CategoryMeta[]> {
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({ type: 'category' }),
    limit: 50,
    page: 1,
    order: 'order'
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>('hqMetas/metasList', {
    method: 'GET',
    query
  })
  return (resp.data ?? []).map((m) => ({
    mid: str(m.mid ?? m.id ?? ''),
    name: str(m.name),
    slug: str(m.slug),
    description: str(m.description),
    count: num(m.count)
  }))
}
