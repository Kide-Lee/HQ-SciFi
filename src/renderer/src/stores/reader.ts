import { create } from 'zustand'
import type { ArticleDetail, CommentItem, RemoteArticle, ReviewItem, ReviewPayload } from '../../../shared/types'
import { useUiStore } from './ui'

/** 列表排序（对应官方 topList：评分/点赞/评论/阅读/时间/回复；size 按字数为本地排序） */
export const ARTICLE_ORDERS: Array<{ key: string; label: string }> = [
  { key: 'score', label: '评分榜' },
  { key: 'likes', label: '点赞榜' },
  { key: 'commentsNum', label: '评论榜' },
  { key: 'views', label: '阅读榜' },
  { key: 'size', label: '按字数' },
  { key: 'created', label: '按时间' },
  { key: 'replyTime', label: '按回复' }
]

/** 评审列表排序（v0.0.2：reviewList order 实测支持 created/score/joy/helpful/earnest + 负号反方向） */
export const REVIEW_ORDERS: Array<{ key: string; label: string }> = [
  { key: 'created', label: '按时间' },
  { key: 'score', label: '按评分' },
  { key: 'joy', label: '按开心' },
  { key: 'helpful', label: '按有用' },
  { key: 'earnest', label: '按认真' }
]

interface ReaderState {
  // ---- 阅读 ----
  /** 当前阅读的文章 cid */
  readingCid: string | null
  /** 文章详情（HTML 正文） */
  detail: ArticleDetail | null
  detailLoading: boolean
  detailError: string | null

  // ---- 评审 ----
  reviews: ReviewItem[]
  reviewsLoading: boolean
  /** 评审列表排序（v0.0.2：所有评审支持排序+倒序） */
  reviewOrder: string
  /** 评审排序方向：false=降序（服务端默认） true=升序 */
  reviewOrderAsc: boolean
  /** 提交进行中 */
  submitting: boolean
  /** 提交结果提示（成功/失败） */
  submitMessage: string | null

  // ---- 评论（评论区） ----
  comments: CommentItem[]
  commentsTotal: number
  commentsLoading: boolean
  /** 是否还有下一页（按「本页返回条数 == limit」判断，同 listHasMore 策略） */
  commentsHasMore: boolean
  /** 发表进行中 */
  commentSubmitting: boolean
  /** 发表结果提示（成功/失败文案） */
  commentMessage: string | null

  // ---- 文章列表（作品库/推荐等浏览入口） ----
  list: RemoteArticle[]
  listTotal: number
  listPage: number
  listLoading: boolean
  listError: string | null
  listOrder: string
  /**
   * v0.0.6+：栏目首页（推荐/连载/活动/作品库顶层概览）当前展示的文章合集，
   * 供右栏搜索使用（首页数据在组件本地 state，汇总上报到 store）
   */
  homeList: RemoteArticle[]
  setHomeList: (items: RemoteArticle[]) => void
  /**
   * 排序方向：false=服务端默认（降序，大→小）；true=升序（小→大）。
   * 所有排序按钮共用一个 ↑/↓ 切换（v0.0.2）。
   */
  listOrderAsc: boolean
  /**
   * 是否还有下一页。注意：selectContents 的 total 不可靠（实测 total=20 但第 2 页仍有数据），
   * 用「本页返回条数 == limit」判断；首屏置 true 直至某页返回不足一页。
   */
  listHasMore: boolean

  // ---- 评审任务（文章卡片强调） ----
  /** cid → 任务状态（0 待评审 / 1 已完成），空对象 = 未拉取或非任务文章 */
  reviewTaskByCid: Record<string, number>
  /** 已成功拉取过评审任务（避免无任务时空对象反复请求；失败不置位，允许重试） */
  reviewTasksLoaded: boolean
  /** 拉取当前账号评审任务（幂等：已拉过则跳过；失败静默，不影响列表） */
  loadReviewTasks: () => Promise<void>

  openArticle: (cid: string) => Promise<void>
  closeArticle: () => void
  loadReviews: (cid: string) => Promise<void>
  setReviewOrder: (order: string) => void
  toggleReviewOrderAsc: () => void
  submit: (payload: ReviewPayload) => Promise<boolean>
  setAttitude: (reviewId: number | string, type: number) => Promise<void>
  clearSubmitMessage: () => void

  // ---- 评论动作 ----
  loadComments: (cid: string, opts?: { append?: boolean }) => Promise<void>
  /** 发表/回复评论（reviewid 为关联评审 id）；成功后重拉列表并提示，返回是否成功 */
  submitComment: (payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }) => Promise<boolean>
  clearCommentMessage: () => void

  loadList: (opts?: { searchParams?: Record<string, unknown>; mid?: number | string; order?: string; append?: boolean; choice?: boolean }) => Promise<void>
  setOrder: (order: string) => void
  /** 切换当前排序方向（所有排序字段共用一个 ↑/↓） */
  toggleOrderAsc: () => void
  clearList: () => void
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  readingCid: null,
  detail: null,
  detailLoading: false,
  detailError: null,

  reviews: [],
  reviewsLoading: false,
  reviewOrder: 'created',
  reviewOrderAsc: false,
  submitting: false,
  submitMessage: null,

  comments: [],
  commentsTotal: 0,
  commentsLoading: false,
  commentsHasMore: true,
  commentSubmitting: false,
  commentMessage: null,

  list: [],
  listTotal: 0,
  listPage: 1,
  listLoading: false,
  listError: null,
  listOrder: 'created',
  listOrderAsc: false,
  listHasMore: true,
  homeList: [],
  setHomeList: (homeList) => set({ homeList }),

  reviewTaskByCid: {},
  reviewTasksLoaded: false,

  openArticle: async (cid) => {
    if (get().readingCid === cid && get().detail) return
    set({ readingCid: cid, detail: null, detailError: null, detailLoading: true, reviews: [], comments: [] })
    try {
      const res = await window.hqsf.getRemoteArticle(cid)
      if (res.ok) {
        set({ detail: res.data, detailLoading: false })
        void get().loadReviews(cid)
        void get().loadComments(cid)
      } else {
        set({ detailError: res.error, detailLoading: false })
      }
    } catch (err) {
      set({ detailError: (err as Error).message, detailLoading: false })
    }
  },

  closeArticle: () =>
    set({ readingCid: null, detail: null, detailError: null, reviews: [], comments: [], commentMessage: null }),

  loadReviews: async (cid) => {
    set({ reviewsLoading: true })
    try {
      // v0.0.2：评审列表按 reviewOrder/reviewOrderAsc 排序（order=-field 为升序）
      const order = get().reviewOrderAsc ? `-${get().reviewOrder}` : get().reviewOrder
      const res = await window.hqsf.listReviews({ cid, order })
      set({ reviews: res.ok ? res.data.items : [], reviewsLoading: false })
    } catch (err) {
      set({ reviews: [], reviewsLoading: false })
    }
  },

  setReviewOrder: (order) => {
    set({ reviewOrder: order })
    const cid = get().readingCid
    if (cid) void get().loadReviews(cid)
  },

  toggleReviewOrderAsc: () => {
    set({ reviewOrderAsc: !get().reviewOrderAsc })
    const cid = get().readingCid
    if (cid) void get().loadReviews(cid)
  },

  submit: async (payload) => {
    if (get().submitting) return false
    set({ submitting: true, submitMessage: null })
    const res = await window.hqsf.submitReview(payload)
    set({ submitting: false })
    if (res.ok && res.data.ok) {
      // v0.0.2：编辑评审（带 id）提交后按审核流程提示（review 条目无 status 字段，兜底文案）
      set({ submitMessage: payload.id != null && payload.id !== '' ? '评审已更新，等待审核' : '评审已提交，感谢你的评价' })
      const cid = get().readingCid
      if (cid) void get().loadReviews(cid)
      return true
    }
    set({ submitMessage: `提交失败: ${res.ok ? res.data.error : res.error}` })
    return false
  },

  setAttitude: async (reviewId, type) => {
    await window.hqsf.setReviewAttitude(reviewId, type)
    // 态度在本地已体现（官方接口返回计数，简单起见提交后重拉评审列表）
    const cid = get().readingCid
    if (cid) void get().loadReviews(cid)
  },

  clearSubmitMessage: () => set({ submitMessage: null }),

  loadComments: async (cid, opts = {}) => {
    const append = opts.append ?? false
    const limit = 20
    const page = append ? Math.floor(get().comments.length / limit) + 1 : 1
    set({ commentsLoading: true })
    try {
      // 评论按 coid（自增 id）升序 = 最早在前；新评论靠后，回复楼中楼紧随
      const res = await window.hqsf.listComments(cid, { order: 'coid', limit, page })
      if (res.ok) {
        const items = res.data.items
        set({
          comments: append ? [...get().comments, ...items] : items,
          commentsTotal: res.data.total,
          commentsLoading: false,
          commentsHasMore: items.length >= limit
        })
      } else {
        set({ commentsLoading: false, commentsHasMore: false })
      }
    } catch (err) {
      set({ commentsLoading: false, commentsHasMore: false })
    }
  },

  submitComment: async (payload) => {
    if (get().commentSubmitting) return false
    set({ commentSubmitting: true, commentMessage: null })
    const res = await window.hqsf.addComment(payload)
    set({ commentSubmitting: false })
    if (res.ok && res.data.ok) {
      // 首次评论可能进审核（auditlevel=1），服务端返回成功但新评论未必立即可见；提示后重拉
      set({ commentMessage: '评论已提交，感谢参与' })
      const cid = get().readingCid
      if (cid) void get().loadComments(cid)
      return true
    }
    set({ commentMessage: `评论发布失败: ${res.ok ? res.data.error : res.error}` })
    return false
  },

  clearCommentMessage: () => set({ commentMessage: null }),

  loadList: async (opts = {}) => {
    const append = opts.append ?? false
    const page = append ? get().listPage + 1 : 1
    const limit = 20
    set({ listLoading: true, listError: null })
    try {
      const order = opts.order ?? (opts.choice ? undefined : get().listOrder)
      const asc = get().listOrderAsc
      // 服务端 order：size 不受支持（实测），用 created 稳定取数后本地按字数排序；
      // 其余字段服务端支持负号前缀反方向（order=-field = 升序）
      const serverOrder =
        order && !opts.choice ? (order === 'size' ? 'created' : asc ? `-${order}` : order) : undefined
      const res = await window.hqsf.listRemoteArticles({
        searchParams: opts.searchParams,
        mid: opts.mid,
        choice: opts.choice,
        order: serverOrder,
        limit,
        page
      })
      if (res.ok) {
        let items = res.data.items
        // 按字数排序：接口不支持，本地排（当前已加载列表内）
        if (order === 'size') {
          items = [...items].sort((a, b) =>
            asc ? (a.size ?? 0) - (b.size ?? 0) : (b.size ?? 0) - (a.size ?? 0)
          )
        }
        // selectContents 的 total 不可靠：返回不足一页才算没有更多
        const hasMore = items.length >= limit
        set({
          list: append ? [...get().list, ...items] : items,
          listTotal: res.data.total,
          listPage: page,
          listLoading: false,
          listHasMore: hasMore
        })
      } else {
        set({ listError: res.error, listLoading: false })
      }
    } catch (err) {
      set({ listError: (err as Error).message, listLoading: false })
    }
  },

  setOrder: (order) => {
    set({ listOrder: order })
    // 切排序需保持当前列表上下文（作品库分类 mid/searchParams），否则会拉回全部文章
    const ctx = useUiStore.getState().listContext
    void get().loadList({
      order,
      mid: ctx?.mid,
      searchParams: ctx?.searchParams,
      choice: ctx?.choice
    })
  },

  toggleOrderAsc: () => {
    set({ listOrderAsc: !get().listOrderAsc })
    const ctx = useUiStore.getState().listContext
    void get().loadList({
      order: get().listOrder,
      mid: ctx?.mid,
      searchParams: ctx?.searchParams,
      choice: ctx?.choice
    })
  },

  clearList: () =>
    set({ list: [], listTotal: 0, listPage: 1, listError: null, listHasMore: true }),

  loadReviewTasks: async () => {
    // 幂等：已成功拉取过则不再重复请求（无任务时为空对象，用独立 loaded 标志）
    if (get().reviewTasksLoaded) return
    try {
      const res = await window.hqsf.listReviewTasks()
      if (res.ok) {
        const map: Record<string, number> = {}
        for (const t of res.data) map[t.cid] = t.status
        set({ reviewTaskByCid: map, reviewTasksLoaded: true })
      }
    } catch {
      // 任务拉取失败静默：不影响文章列表浏览
    }
  }
}))
