import { create } from 'zustand'
import type { ArticleDetail, RemoteArticle, ReviewItem, ReviewPayload } from '../../../shared/types'
import { useUiStore } from './ui'

/** 列表排序（对应官方 topList：评分/点赞/评论/阅读/时间/回复） */
export const ARTICLE_ORDERS: Array<{ key: string; label: string }> = [
  { key: 'score', label: '评分榜' },
  { key: 'likes', label: '点赞榜' },
  { key: 'commentsNum', label: '评论榜' },
  { key: 'views', label: '阅读榜' },
  { key: 'created', label: '按时间' },
  { key: 'replyTime', label: '按回复' }
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
  /** 提交进行中 */
  submitting: boolean
  /** 提交结果提示（成功/失败） */
  submitMessage: string | null

  // ---- 文章列表（作品库/推荐等浏览入口） ----
  list: RemoteArticle[]
  listTotal: number
  listPage: number
  listLoading: boolean
  listError: string | null
  listOrder: string

  openArticle: (cid: string) => Promise<void>
  closeArticle: () => void
  loadReviews: (cid: string) => Promise<void>
  submit: (payload: ReviewPayload) => Promise<boolean>
  setAttitude: (reviewId: number | string, type: number) => Promise<void>
  clearSubmitMessage: () => void

  loadList: (opts?: { searchParams?: Record<string, unknown>; mid?: number | string; order?: string; append?: boolean }) => Promise<void>
  setOrder: (order: string) => void
  clearList: () => void
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  readingCid: null,
  detail: null,
  detailLoading: false,
  detailError: null,

  reviews: [],
  reviewsLoading: false,
  submitting: false,
  submitMessage: null,

  list: [],
  listTotal: 0,
  listPage: 1,
  listLoading: false,
  listError: null,
  listOrder: 'created',

  openArticle: async (cid) => {
    if (get().readingCid === cid && get().detail) return
    set({ readingCid: cid, detail: null, detailError: null, detailLoading: true, reviews: [] })
    try {
      const res = await window.hqsf.getRemoteArticle(cid)
      if (res.ok) {
        set({ detail: res.data, detailLoading: false })
        void get().loadReviews(cid)
      } else {
        set({ detailError: res.error, detailLoading: false })
      }
    } catch (err) {
      set({ detailError: (err as Error).message, detailLoading: false })
    }
  },

  closeArticle: () => set({ readingCid: null, detail: null, detailError: null, reviews: [] }),

  loadReviews: async (cid) => {
    set({ reviewsLoading: true })
    try {
      const res = await window.hqsf.listReviews({ cid })
      set({ reviews: res.ok ? res.data.items : [], reviewsLoading: false })
    } catch (err) {
      set({ reviews: [], reviewsLoading: false })
    }
  },

  submit: async (payload) => {
    if (get().submitting) return false
    set({ submitting: true, submitMessage: null })
    const res = await window.hqsf.submitReview(payload)
    set({ submitting: false })
    if (res.ok && res.data.ok) {
      set({ submitMessage: '评审已提交，感谢你的评价' })
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

  loadList: async (opts = {}) => {
    const append = opts.append ?? false
    const page = append ? get().listPage + 1 : 1
    set({ listLoading: true, listError: null })
    try {
      const res = await window.hqsf.listRemoteArticles({
        searchParams: opts.searchParams,
        mid: opts.mid,
        order: opts.order ?? get().listOrder,
        limit: 20,
        page
      })
      if (res.ok) {
        set({
          list: append ? [...get().list, ...res.data.items] : res.data.items,
          listTotal: res.data.total,
          listPage: page,
          listLoading: false
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
      searchParams: ctx?.searchParams
    })
  },

  clearList: () => set({ list: [], listTotal: 0, listPage: 1, listError: null })
}))
