import { create } from 'zustand'
import type {
  ApiResult,
  ArticleDetail,
  CommentItem,
  ConvertDraftResult,
  EditRemoteResult,
  RemoteArticle,
  ReviewItem,
  ReviewPayload
} from '../../../shared/types'
import { useUiStore } from './ui'
import { useEditorStore } from './editor'
import { useDocsStore } from './docs'
import { isReviewDisabledArticle } from '../lib/category'

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
  /**
   * v0.0.10：当前文章是否属于「不开启评审、不显示评分」的分类
   * （科幻杂谈/官方公告/外文翻译）。统一在 openArticle 时计算，
   * 避免各视图各自判断遗漏；文章卡片仍按 article 自身判断。
   */
  reviewDisabled: boolean

  // ---- 评审 ----
  reviews: ReviewItem[]
  reviewsLoading: boolean
  /** v0.0.8.6：评审列表分页（深链定位目标评审可能在第 2+ 页） */
  reviewsPage: number
  reviewsHasMore: boolean
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

  // ---- 评审记录（v0.0.7：「已评审」= 本人评审过该文章，不限评审任务） ----
  /** cid → 本人已写过该文章的评审；loadMyReviewed 填充（登录/挂载时一次拉全） */
  myReviewedCids: Record<string, boolean>
  /** 已成功拉取过本人评审集合（幂等；失败不置位允许重试） */
  myReviewedLoaded: boolean
  /** 拉取当前账号写过的全部评审（reviewList 按会话 uid 分页枚举） */
  loadMyReviewed: () => Promise<void>

  openArticle: (cid: string) => Promise<void>
  closeArticle: () => void
  /**
   * 编辑远端文章（写作→草稿 / 四态文章的编辑入口）：
   * 非草稿先经服务端转存为草稿，再同步全文到本地存档，退出阅读态并切到写作打开编辑器。
   * 返回 IPC 结果；失败时留在当前阅读页（调用方展示错误）。
   */
  editRemoteArticle: (cid: string) => Promise<ApiResult<EditRemoteResult>>
  /** 远端文章转存为草稿（服务端处理）；成功后刷新四态索引（侧栏「草稿」即时更新） */
  convertToDraft: (cid: string) => Promise<ApiResult<ConvertDraftResult>>
  /**
   * 拉取评审列表（v0.0.8.6：支持分页追加——深链目标评审可能在第 2+ 页）
   */
  loadReviews: (cid: string, opts?: { append?: boolean }) => Promise<void>
  setReviewOrder: (order: string) => void
  toggleReviewOrderAsc: () => void
  submit: (payload: ReviewPayload) => Promise<boolean>
  setAttitude: (reviewId: number | string, type: number) => Promise<void>
  clearSubmitMessage: () => void

  // ---- 评论动作 ----
  /** 拉取评论列表（limit 支持深链定位时一次取更多，默认 20） */
  loadComments: (cid: string, opts?: { append?: boolean; limit?: number }) => Promise<void>
  /** 发表/回复评论（reviewid 为关联评审 id）；成功后重拉列表并提示，返回是否成功 */
  submitComment: (payload: { cid: string; text: string; parent?: number | string; reviewid?: number | string }) => Promise<boolean>
  clearCommentMessage: () => void

  loadList: (opts?: { searchParams?: Record<string, unknown>; mid?: number | string; order?: string; append?: boolean; choice?: boolean }) => Promise<void>
  setOrder: (order: string) => void
  /** 切换当前排序方向（所有排序字段共用一个 ↑/↓） */
  toggleOrderAsc: () => void
  clearList: () => void

  // ---- v0.0.8：首页「最新评审/最新讨论」深链目标 ----
  /**
   * 跳转定位目标：从首页信息流点击后设置，打开文章并切到对应右栏 tab 后，
   * 由评审/评论面板消费（滚动定位到目标评审卡片/评论；评审评论还需展开所属评审的评论区）。
   * 消费完成或目标文章与当前阅读文章不符时 clearTarget。
   */
  target: { cid: string; reviewId?: string; commentId?: string } | null
  setTarget: (t: { cid: string; reviewId?: string; commentId?: string } | null) => void
  clearTarget: () => void
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  readingCid: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  reviewDisabled: false,

  reviews: [],
  reviewsLoading: false,
  reviewsPage: 1,
  reviewsHasMore: true,
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
  myReviewedCids: {},
  myReviewedLoaded: false,

  openArticle: async (cid) => {
    if (get().readingCid === cid && get().detail) return
    set({
      readingCid: cid,
      detail: null,
      detailError: null,
      detailLoading: true,
      reviewDisabled: false,
      reviews: [],
      reviewsPage: 1,
      reviewsHasMore: true,
      comments: []
    })
    try {
      const res = await window.hqsf.getRemoteArticle(cid)
      if (res.ok) {
        set({ detail: res.data, detailLoading: false, reviewDisabled: isReviewDisabledArticle(res.data) })
        void get().loadReviews(cid)
        void get().loadComments(cid)
      } else {
        set({ detailError: res.error, detailLoading: false })
      }
    } catch (err) {
      set({ detailError: (err as Error).message, detailLoading: false })
    }
  },

  closeArticle: () => {
    set({ readingCid: null, detail: null, detailError: null, reviewDisabled: false, reviews: [], reviewsPage: 1, reviewsHasMore: true, comments: [], commentMessage: null })
    // 关闭阅读态后，侧栏选中回到编辑器当前打开的文档（若无则清除），避免高亮残留
    useUiStore.getState().setSelectedId(useEditorStore.getState().currentPath)
  },

  editRemoteArticle: async (cid) => {
    // 目标文章对应的本地文件若正被编辑器打开：先落盘未保存修改，
    // 避免主进程拉取覆盖磁盘后，内存陈旧内容经防抖保存回写（v0.0.8 审查修复）
    const row = useDocsStore.getState().articles.find((a) => a.cid === cid)
    const ed = useEditorStore.getState()
    if (row?.filePath && ed.currentPath === row.filePath && ed.dirty) await ed.save()
    const res = await window.hqsf.editRemoteArticle(cid)
    if (!res.ok) return res
    // 退出阅读态 → 切到写作 → 打开同步到本地的文件（编辑器本地编辑）
    get().closeArticle()
    const ui = useUiStore.getState()
    ui.setSection('writing')
    ui.setSelectedId(res.data.filePath)
    if (useEditorStore.getState().currentPath === res.data.filePath) {
      // 磁盘刚被拉取覆盖：强制重载（open 同路径会早退，避免显示旧内容并回写覆盖）
      await useEditorStore.getState().reload()
    } else {
      await useEditorStore.getState().open(res.data.filePath)
    }
    await Promise.all([
      useDocsStore.getState().refreshLocal(),
      useDocsStore.getState().refreshArticles()
    ])
    return res
  },

  convertToDraft: async (cid) => {
    const res = await window.hqsf.convertToDraft(cid)
    if (res.ok) {
      // 索引同步为草稿态：侧栏「草稿」分组即时出现该文章（无本地文件时仍按文章可读）
      await useDocsStore.getState().refreshArticles()
    }
    return res
  },

  loadReviews: async (cid, opts = {}) => {
    const append = opts.append ?? false
    const page = append ? get().reviewsPage + 1 : 1
    const limit = 20
    set({ reviewsLoading: true })
    try {
      // v0.0.2：评审列表按 reviewOrder/reviewOrderAsc 排序（order=-field 为升序）
      const order = get().reviewOrderAsc ? `-${get().reviewOrder}` : get().reviewOrder
      const res = await window.hqsf.listReviews({ cid, order, page, limit })
      set({
        reviews: res.ok ? (append ? [...get().reviews, ...res.data.items] : res.data.items) : [],
        reviewsPage: res.ok ? page : 1,
        reviewsHasMore: res.ok ? res.data.items.length >= limit : false,
        reviewsLoading: false
      })
    } catch (err) {
      set({ reviews: [], reviewsPage: 1, reviewsHasMore: false, reviewsLoading: false })
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
      // v0.0.7：评审提交后刷新评审任务（服务端权威状态）——侧栏「待评审置顶/徽章」随之归位；
      // 若服务端仍判定待评审（如走审核），则保持原状，不会误报已完成
      set({ reviewTasksLoaded: false })
      void get().loadReviewTasks()
      // v0.0.7：提交即视为「已评审」（本人）——即使列表接口滞后，徽章/置顶立即正确
      if (cid) set({ myReviewedCids: { ...get().myReviewedCids, [cid]: true } })
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
    const limit = opts.limit ?? 20
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

  // v0.0.8：深链目标
  target: null,
  setTarget: (target) => set({ target }),
  clearTarget: () => set({ target: null }),

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
  },

  loadMyReviewed: async () => {
    // 幂等：已成功拉取过则不再重复请求（无评审时为空对象，用独立 loaded 标志）
    if (get().myReviewedLoaded) return
    try {
      const res = await window.hqsf.listMyReviews()
      if (res.ok) {
        const map: Record<string, boolean> = {}
        for (const c of res.data.cids) map[c] = true
        // 合并而非整体替换：快照在途时若用户已提交评审（submit 即时标记），
        // 替换会丢掉该标记；myReviewedCids 会话内只增不减，合并恒安全
        set({ myReviewedCids: { ...get().myReviewedCids, ...map }, myReviewedLoaded: true })
      }
    } catch {
      // 拉取失败静默：不影响浏览
    }
  }
}))
