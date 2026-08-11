import { apiRequest, endpoint } from './net/api'
import { mdToHtml } from './md2html'
import { deleteReadCache, getReadCache, setReadCache } from './db'
import type {
  ArticleDetail,
  ArticleListOptions,
  CommentItem,
  CommentSubmitResult,
  GptModel,
  LogOpResult,
  MarkStatus,
  MetaInfo,
  MetaRef,
  RemoteArticle,
  ReviewItem,
  ReviewPayload,
  ReviewSubmitResult,
  ReviewTaskItem
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

/**
 * 剥离正文外的媒体标记（列表摘要/标题/导言里出现的音乐/视频占位文本）：
 * 方括号版（正文 markExpand 语法）与紧凑版（列表摘要实测如 "music163509720124/music163"）。
 * 正文渲染仍需保留标记（expandMediaTags 展开成播放器），仅展示类文本剥离。
 */
const MEDIA_TAG_RE =
  /(?:\[music\s+163\]\s*\d{3,20}\s*\[\/music\s+163\]|\[music\s+qq\]\s*\d{3,20}\s*\[\/music\s+qq\]|\[video\s+bilibili\]\s*BV[0-9A-Za-z]{6,20}\s*\[\/video\s+bilibili\]|music163\s*\d{3,20}\s*\/music163|musicqq\s*\d{3,20}\s*\/musicqq)/g
function stripMediaTags(v: unknown): string {
  return str(v).replace(MEDIA_TAG_RE, '')
}

/** 列表条目 → RemoteArticle（字段做类型规整，缺失给默认值） */
/** 栏目引用规整（active/category/collection/tag 数组项，含 name+mid） */
function toMetaRef(v: unknown): MetaRef {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    mid: str(o.mid ?? o.id ?? ''),
    name: str(o.name) || undefined,
    type: str(o.type) || undefined,
    imgurl: str(o.imgurl) || undefined,
    deadline: normTs(o.deadline)
  }
}

function toRemoteArticle(item: Record<string, unknown>, index: number): RemoteArticle {
  return {
    cid: str(item.cid ?? item.id ?? ''),
    title: stripMediaTags(item.title ?? '未命名'),
    type: str(item.type),
    status: str(item.status),
    score: str(item.score),
    text: stripMediaTags(item.text),
    authorId: str(item.authorId ?? ''),
    authorInfo: (item.authorInfo as Record<string, unknown> | undefined) ?? undefined,
    category: Array.isArray(item.category) ? item.category.map(toMetaRef) : undefined,
    tag: Array.isArray(item.tag) ? item.tag.map(toMetaRef) : undefined,
    collection: Array.isArray(item.collection) ? item.collection.map(toMetaRef) : undefined,
    cover: str(item.cover),
    introduction: stripMediaTags(item.introduction),
    views: num(item.views),
    likes: num(item.likes),
    commentsNum: num(item.commentsNum),
    created: normTs(item.created),
    modified: normTs(item.modified),
    replyTime: normTs(item.replyTime),
    isAnonymous: !!item.isAnonymous,
    active: Array.isArray(item.active) ? item.active.map(toMetaRef) : null,
    size: num(item.size) || undefined,
    images: Array.isArray(item.images) ? (item.images as unknown[]).map(String) : undefined
  }
}

/** 拉取文章列表：精选（choice）走 choiceList，分类（mid）走 selectContents，其余走 contentsList */
export async function listRemoteArticles(
  token: string | null,
  opts: ArticleListOptions = {}
): Promise<{ items: RemoteArticle[]; total: number }> {
  const limit = opts.limit ?? PAGE_SIZE
  const page = opts.page ?? 1
  const query: Record<string, unknown> = {
    limit,
    page
  }
  // choiceList 固定顺序（实测 order 参数无效），不加 order；其余接口 order 生效
  if (!opts.choice && opts.order) query.order = opts.order
  if (token) query.token = token

  if (opts.choice) {
    const resp = await apiRequest<ListData>(endpoint('choiceList').path, {
      method: 'GET',
      query
    })
    return {
      items: (resp.data ?? []).map((it, i) => toRemoteArticle(it, i)),
      total: num(resp.total) || (resp.data ?? []).length
    }
  }

  if (opts.mid != null) {
    query.searchParams = JSON.stringify({ mid: opts.mid })
    const resp = await apiRequest<ListData>(endpoint('selectContents').path, {
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
  const resp = await apiRequest<ListData>(endpoint('contentsList').path, {
    method: 'GET',
    query
  })
  return {
    items: (resp.data ?? []).map((it, i) => toRemoteArticle(it, i)),
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/** 拉取 metas 栏目条目（M3：连载/活动/作品库/tag 树）。metasList 公开 */
export async function listMetas(
  token: string | null,
  type: string
): Promise<MetaInfo[]> {
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({ type }),
    limit: 100,
    page: 1,
    order: 'order'
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('metasList').path, {
    method: 'GET',
    query
  })
  return (resp.data ?? []).map((m) => ({
    mid: str(m.mid ?? m.id ?? ''),
    type: str(m.type),
    name: str(m.name),
    slug: str(m.slug),
    description: str(m.description),
    imgurl: str(m.imgurl),
    count: num(m.count),
    deadline: normTs(m.deadline),
    isReview: num(m.isReview),
    activeStatus: num(m.activeStatus)
  }))
}

/** 拉取 AI 模型列表（推荐栏目「AI模型」，gpt/gptList，公开） */
export async function listGptModels(token: string | null): Promise<GptModel[]> {
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({}),
    limit: 100,
    page: 1,
    order: 'created'
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('gptList').path, {
    method: 'GET',
    query
  })
  return (resp.data ?? []).map((m) => ({
    id: str(m.id ?? m.mid ?? ''),
    name: str(m.name),
    intro: str(m.intro),
    avatar: str(m.avatar),
    type: num(m.type),
    price: num(m.price),
    source: str(m.source)
  }))
}

/** 拉取当前账号的评审任务（review/reviewTask，按 uid；status 0=待评审 / 1=已完成） */
export async function listReviewTasks(token: string | null, uid: number | string): Promise<ReviewTaskItem[]> {
  const query: Record<string, unknown> = {
    uid,
    limit: 100,
    page: 1
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('reviewTask').path, {
    method: 'GET',
    query
  })
  return (resp.data ?? []).map((t) => {
    const contentJson = (t.contentJson as Record<string, unknown> | undefined) ?? {}
    const activeJson = (t.activeJson as Record<string, unknown> | undefined) ?? {}
    return {
      cid: str(t.cid ?? contentJson.cid ?? contentJson.id ?? ''),
      status: num(t.status),
      activeid: t.activeid != null ? str(t.activeid) : undefined,
      activeName: str(activeJson.name),
      articleTitle: str(contentJson.title)
    }
  })
}

/**
 * 拉取文章详情（完整 HTML 正文；需登录）。contentsInfo 响应为裸对象；结果本地缓存（1 天未使用即丢弃）。
 */
export async function fetchRemoteArticle(token: string, cid: string): Promise<ArticleDetail> {
  const cacheKey = `article:${cid}`
  const cached = getReadCache<ArticleDetail>(cacheKey)
  if (cached) return cached

  const obj = await apiRequest<Record<string, unknown>>(endpoint('contentsInfo').path, {
    method: 'GET',
    query: { key: cid, isMd: 0, token },
    raw: true
  })
  if (!obj || typeof obj.title !== 'string') {
    throw new Error(`拉取文章失败: ${str(obj?.msg) || '未公开或不存在'}`)
  }
  // 文章未公开/被隐藏（如 cid=1254 热岛，contentsInfo 仍返回 title 但 isopen=0）。
  // 走到此处说明本次缓存未命中（key 通常已被 getReadCache 清理/删除）；deleteReadCache
  // 是幂等兜底：防止并发请求刚写入的缓存、或未来 TTL 策略变化后的残留被读到。
  if (obj.isopen === 0 || obj.isopen === '0') {
    deleteReadCache(cacheKey)
    throw new Error(`拉取文章失败: ${str(obj?.msg) || '未公开或不存在'}`)
  }
  const userJson = obj.userJson as Record<string, unknown> | undefined
  const authorId =
    str(obj.authorId) ||
    str((userJson && (userJson.uid ?? userJson.id)) ?? '')
  const detail: ArticleDetail = {
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
    category: Array.isArray(obj.category) ? obj.category.map(toMetaRef) : undefined,
    collection: Array.isArray(obj.collection) ? obj.collection.map(toMetaRef) : undefined,
    active: Array.isArray(obj.active) ? obj.active.map(toMetaRef) : null,
    markdown: num(obj.markdown),
    introduction: stripMediaTags(obj.introduction) || undefined,
    isLikes: num(obj.isLikes)
  }
  setReadCache(cacheKey, detail)
  return detail
}

/** 评审条目规整 */
function toReviewItem(item: Record<string, unknown>): ReviewItem {
  return {
    id: str(item.id ?? item.rid ?? ''),
    cid: str(item.cid ?? item.key ?? ''),
    activeid: item.activeid != null ? str(item.activeid) : undefined,
    uid: item.uid != null ? str(item.uid) : str((item.userJson as Record<string, unknown> | undefined)?.uid ?? ''),
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
    /** v0.0.5：关联该评审的评论数（reviewList 返回 replyNum；此前转换丢弃导致按钮不显示） */
    replyNum: num(item.replyNum),
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
  const resp = await apiRequest<ListData>(endpoint('reviewList').path, {
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
    const endpointPath = payload.id != null && payload.id !== '' ? endpoint('editReview').path : endpoint('addReview').path
    const resp = await apiRequest<{ msg?: string }>(endpointPath, {
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
    const resp = await apiRequest(endpoint('attitude').path, {
      method: 'POST',
      body: { token, id: reviewId, type }
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
  imgurl?: string
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
  const resp = await apiRequest<ListData>(endpoint('metasList').path, {
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

// ---------- 评论（hqComments/，api-research.md §8） ----------

/** 评论条目规整（commentsList data 项；coid 为评论 id，parent 为上级评论 coid） */
function toCommentItem(item: Record<string, unknown>): CommentItem {
  const userJson = (item.userJson as Record<string, unknown> | undefined) ?? {}
  return {
    coid: str(item.coid ?? item.id ?? ''),
    cid: str(item.cid ?? ''),
    parent: str(item.parent ?? 0),
    text: str(item.text),
    author: str(item.author ?? userJson.name ?? '匿名'),
    authorId: str(item.authorId ?? userJson.uid ?? 0),
    // 实测（2026-08）：荒启定制版 commentsList 无顶层 avatar，头像在 userJson.avatar
    avatar: str(item.avatar) || str(userJson.avatar) || undefined,
    created: normTs(item.created),
    subNum: num(item.subNum),
    parentComments: (item.parentComments as CommentItem['parentComments'] | undefined) ?? undefined,
    // v0.0.3：评论-评审关联（荒启定制版 reviewid，实测 2026-08）
    reviewid: item.reviewid != null ? str(item.reviewid) : undefined
  }
}

/**
 * 拉取文章评论列表（hqComments/commentsList，GET；searchParams={cid} 过滤，非管理员强制 status=approved）。
 * order 仅支持 created / coid / cid（服务端白名单）。
 */
export async function listComments(
  token: string | null,
  cid: string,
  opts: { limit?: number; page?: number; order?: string } = {}
): Promise<{ items: CommentItem[]; total: number }> {
  const query: Record<string, unknown> = {
    searchParams: JSON.stringify({ cid }),
    limit: opts.limit ?? PAGE_SIZE,
    page: opts.page ?? 1,
    ...(opts.order ? { order: opts.order } : {})
  }
  if (token) query.token = token
  const resp = await apiRequest<ListData>(endpoint('commentsList').path, {
    method: 'GET',
    query
  })
  return {
    items: (resp.data ?? []).map(toCommentItem),
    total: num(resp.total) || (resp.data ?? []).length
  }
}

/**
 * 发表评论（hqComments/commentsAdd，GET + params JSON；官方校验 text ≥4 字，首次评论可能进审核）。
 * parent 为回复的上级评论 coid（顶层评论传 0/省略）。
 */
export async function addComment(
  token: string,
  payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }
): Promise<CommentSubmitResult> {
  const text = String(payload.text ?? '').trim()
  if (text.length < 4) return { ok: false, error: '评论内容至少 4 个字' }
  const params: Record<string, unknown> = { cid: String(payload.cid), text }
  if (payload.parent != null && String(payload.parent) !== '0') params.parent = payload.parent
  // v0.0.3：评论-评审关联（h5 前端「回复评审」即传 reviewid，实测字段存在于评论条目）
  if (payload.reviewid != null && String(payload.reviewid) !== '0') params.reviewid = payload.reviewid
  try {
    const resp = await apiRequest(endpoint('commentsAdd').path, {
      method: 'GET',
      query: { params: JSON.stringify(params), token }
    })
    if (resp.code === 1) return { ok: true }
    return { ok: false, error: resp.msg || '评论发布失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------- 用户互动（hqUserlog/：点赞 / 收藏 / 投币，api-research.md §8） ----------

/**
 * 用户日志操作（hqUserlog/addLog，GET + params JSON）。
 * type：likes=点赞（每日每 IP+UA+cid 一次，服务端 likes+1）/ mark=收藏（重复收藏报错）/
 * reward=投币（扣用户 assets 积分，num>0 且 ≤ 余额，不能打赏自己，作者得积分）。
 */
export async function addUserLog(
  token: string,
  type: 'likes' | 'mark' | 'reward',
  params: Record<string, unknown>
): Promise<LogOpResult> {
  try {
    const resp = await apiRequest(endpoint('addLog').path, {
      method: 'GET',
      query: { params: JSON.stringify({ type, ...params }), token }
    })
    if (resp.code === 1) return { ok: true }
    return { ok: false, error: resp.msg || '操作失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 查询收藏状态（hqUserlog/isMark，cid + type=content；返回 {isMark, logid}） */
export async function getMarkStatus(token: string, cid: string): Promise<MarkStatus> {
  const resp = await apiRequest<Record<string, unknown>>(endpoint('isMark').path, {
    method: 'GET',
    query: { cid, type: 'content', token }
  })
  const data = (resp.data ?? {}) as Record<string, unknown>
  const lid = str(data.logid)
  return { marked: num(data.isMark) > 0, logid: lid && Number(lid) > 0 ? lid : undefined }
}

/** 取消收藏（hqUserlog/removeLog，key=收藏日志 id，来自 isMark 返回的 logid） */
export async function removeUserLog(token: string, key: number | string): Promise<LogOpResult> {
  try {
    const resp = await apiRequest(endpoint('removeLog').path, {
      method: 'GET',
      query: { key: String(key), token }
    })
    if (resp.code === 1) return { ok: true }
    return { ok: false, error: resp.msg || '取消失败' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 违禁词检测（官方接口 hqContents/userTextBlockStatus，付费 5 能量币/次，腾讯云内容安全） */
export async function checkTextBlockStatus(
  token: string,
  title: string,
  markdown: string
): Promise<{ code: number; msg: string }> {
  const text = title + mdToHtml(markdown)
  const resp = await apiRequest(endpoint('userTextBlockStatus').path, {
    method: 'POST',
    body: { text, token }
  })
  return { code: resp.code, msg: resp.msg || '' }
}
