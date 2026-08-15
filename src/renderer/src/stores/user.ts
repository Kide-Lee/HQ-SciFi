import { create } from 'zustand'
import type {
  ClockResult,
  CommentItem,
  FollowFeedItem,
  RemoteArticle,
  ReviewItem,
  SelfStatus,
  UserFollowItem,
  UserMarkItem,
  UserPageTab,
  UserProfile,
  UserStats
} from '../../../shared/types'
import { useAuthStore } from './auth'

/** 列表分页状态（用户页各 tab 通用；hasMore 按「本页条数 == limit」判断，同文章列表惯例） */
export interface UserListState<T> {
  items: T[]
  total: number
  page: number
  hasMore: boolean
  loading: boolean
  error: string | null
}

const PAGE_SIZE = 20

function emptyList<T>(): UserListState<T> {
  return { items: [], total: 0, page: 1, hasMore: true, loading: false, error: null }
}

/** 当前会话 uid（token 只在主进程；渲染层从 session 容错取） */
export function currentUid(): string {
  const s = useAuthStore.getState().session
  return String(s?.userinfo?.uid ?? s?.userinfo?.id ?? '')
}

interface UserState {
  uid: string | null
  isSelf: boolean
  /** 当前左栏 tab（home = 主页四栏预览） */
  tab: UserPageTab
  profile: UserProfile | null
  stats: UserStats | null
  /** 关注数（本人页头部展示；来自 followList 首页 total） */
  followTotal: number | null
  followState: boolean
  followBusy: boolean
  selfStatus: SelfStatus | null
  clocking: boolean
  clockMessage: string | null
  /** 粉丝 tab 子视图：本人页默认「关注」，可切「粉丝」 */
  fanMode: 'follows' | 'fans'

  home: {
    marks: UserMarkItem[]
    articles: RemoteArticle[]
    reviews: ReviewItem[]
    comments: CommentItem[]
    loading: boolean
    error: string | null
  }

  dynamic: UserListState<FollowFeedItem>
  marks: UserListState<UserMarkItem>
  fans: UserListState<UserFollowItem>
  articles: UserListState<RemoteArticle>
  reviews: UserListState<ReviewItem>
  comments: UserListState<CommentItem>

  /** 打开用户页（uid 校验后重置全部状态并开始加载头部与主页） */
  openUserPage: (uid: string | number) => void
  close: () => void
  setTab: (tab: UserPageTab) => void
  setFanMode: (mode: 'follows' | 'fans') => void
  loadHeader: () => Promise<void>
  loadHome: () => Promise<void>
  loadTab: (append?: boolean) => Promise<void>
  toggleFollow: () => Promise<void>
  clock: () => Promise<void>
}

/** 关注者信息字段容错（userJson 为目标用户） */
export function followItemDisplay(f: UserFollowItem): { uid: string; name: string; avatar?: string; introduce?: string; experience?: number } {
  const u = f.userJson as Record<string, unknown> | undefined
  // 关注列表的 userJson 是被关注者（f.uid 是本人），粉丝列表的 userJson 是粉丝；
  // 用户页粉丝 tab 两种模式都展示「对方」，因此优先取 userJson.uid
  return {
    uid: String(u?.uid ?? f.uid ?? ''),
    name: String(f.name ?? u?.name ?? u?.nickname ?? u?.screenName ?? ''),
    avatar: f.avatar ?? (u?.avatar ? String(u.avatar) : undefined),
    introduce: f.introduce ?? (u?.introduce ? String(u.introduce) : undefined),
    experience: f.experience ?? (u?.experience != null && u.experience !== '' ? Number(u.experience) : undefined)
  }
}

export const useUserStore = create<UserState>((set, get) => ({
  uid: null,
  isSelf: false,
  tab: 'home',
  profile: null,
  stats: null,
  followTotal: null,
  followState: false,
  followBusy: false,
  selfStatus: null,
  clocking: false,
  clockMessage: null,
  fanMode: 'follows',

  home: { marks: [], articles: [], reviews: [], comments: [], loading: false, error: null },
  dynamic: emptyList<FollowFeedItem>(),
  marks: emptyList<UserMarkItem>(),
  fans: emptyList<UserFollowItem>(),
  articles: emptyList<RemoteArticle>(),
  reviews: emptyList<ReviewItem>(),
  comments: emptyList<CommentItem>(),

  openUserPage: (uid) => {
    const id = String(uid ?? '')
    if (!id || id === '0') return
    if (get().uid === id) {
      // 同一用户：回到主页预览，保持已加载数据
      set({ tab: 'home' })
      return
    }
    set({
      uid: id,
      isSelf: currentUid() === id,
      tab: 'home',
      profile: null,
      stats: null,
      followTotal: null,
      followState: false,
      followBusy: false,
      selfStatus: null,
      clocking: false,
      clockMessage: null,
      fanMode: 'follows',
      home: { marks: [], articles: [], reviews: [], comments: [], loading: false, error: null },
      dynamic: emptyList<FollowFeedItem>(),
      marks: emptyList<UserMarkItem>(),
      fans: emptyList<UserFollowItem>(),
      articles: emptyList<RemoteArticle>(),
      reviews: emptyList<ReviewItem>(),
      comments: emptyList<CommentItem>()
    })
    void get().loadHeader()
    void get().loadHome()
  },

  close: () => {
    set({ uid: null, tab: 'home', profile: null, stats: null, followTotal: null, followState: false, selfStatus: null, clockMessage: null })
  },

  setTab: (tab) => {
    if (get().tab === tab) return
    set({ tab })
    // home 数据已有则不重拉；列表 tab 首次进入自动加载
    if (tab !== 'home') void get().loadTab()
  },

  setFanMode: (mode) => {
    if (get().fanMode === mode) return
    set({ fanMode: mode, fans: emptyList<UserFollowItem>() })
    void get().loadTab()
  },

  loadHeader: async () => {
    const uid = get().uid
    if (!uid) return
    const [profileRes, statsRes] = await Promise.all([
      window.hqsf.getUserProfile(uid),
      window.hqsf.getUserStats(uid)
    ])
    set({
      profile: profileRes.ok ? profileRes.data : null,
      stats: statsRes.ok ? statsRes.data : null
    })
    if (!get().isSelf) {
      const f = await window.hqsf.getFollowState(uid)
      set({ followState: f.ok && f.data === true })
    } else {
      const st = await window.hqsf.getSelfStatus()
      if (st.ok && st.data) set({ selfStatus: st.data })
      // 本人页头部展示关注数：followList 首页 total 即关注数（不整表枚举）
      const fl = await window.hqsf.listFollows(uid, 1, 1)
      if (fl.ok) set({ followTotal: fl.data.total })
    }
  },

  loadHome: async () => {
    const { uid, isSelf } = get()
    if (!uid) return
    set({ home: { marks: [], articles: [], reviews: [], comments: [], loading: true, error: null } })

    type HomeRes<T> = { ok: true; data: { items: T[]; total: number } } | { ok: false; error: string }
    const [a, r, c, m] = (await Promise.all([
      window.hqsf.listUserArticles(uid, 1, 4),
      window.hqsf.listUserReviews(uid, 1, 4),
      window.hqsf.listUserComments(uid, 1, 4),
      isSelf ? window.hqsf.listMarks(1, 4) : Promise.resolve({ ok: false as const, error: '' })
    ])) as [HomeRes<RemoteArticle>, HomeRes<ReviewItem>, HomeRes<CommentItem>, HomeRes<UserMarkItem>]

    const all = [a, r, c, ...(isSelf ? [m] : [])]
    const failed = all.filter((x): x is { ok: false; error: string } => !x.ok)
    set({
      home: {
        marks: m.ok ? m.data.items : [],
        articles: a.ok ? a.data.items : [],
        reviews: r.ok ? r.data.items : [],
        comments: c.ok ? c.data.items : [],
        loading: false,
        error: failed.length > 0 ? failed[0].error : null
      }
    })
  },

  loadTab: async (append = false) => {
    const { uid, tab, isSelf } = get()
    if (!uid) return
    if (tab === 'home') return

    const key = tab as 'dynamic' | 'marks' | 'fans' | 'articles' | 'reviews' | 'comments'
    const cur = get()[key] as UserListState<unknown>
    if (!append && cur.items.length > 0) return
    if (cur.loading) return
    const page = append ? cur.page + 1 : 1

    // 未登录的受限 tab：清空并提示
    if (key === 'dynamic' || key === 'marks') {
      if (!useAuthStore.getState().session) {
        set({ [key]: { ...emptyList(), error: '未登录，无法查看' } } as Partial<UserState>)
        return
      }
    }

    set({ [key]: { ...cur, loading: true, error: null } } as Partial<UserState>)

    try {
      let res:
        | { ok: true; data: { items: unknown[]; total: number } }
        | { ok: false; error: string }
        | { ok: true; data: unknown[] }
      if (key === 'dynamic') {
        const r = await window.hqsf.listFollowFeed()
        res = r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
      } else if (key === 'marks') {
        const r = await window.hqsf.listMarks(page, PAGE_SIZE)
        res = r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
      } else if (key === 'fans') {
        // 本人页按 fanMode 切换关注/粉丝；他人页只有「粉丝」
        const mode = get().isSelf ? get().fanMode : 'fans'
        const r =
          mode === 'follows'
            ? await window.hqsf.listFollows(uid, page, PAGE_SIZE)
            : await window.hqsf.listFans(uid, page, PAGE_SIZE)
        res = r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
      } else if (key === 'articles') {
        const r = await window.hqsf.listUserArticles(uid, page, PAGE_SIZE)
        res = r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
      } else if (key === 'reviews') {
        const r = await window.hqsf.listUserReviews(uid, page, PAGE_SIZE)
        res = r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
      } else {
        const r = await window.hqsf.listUserComments(uid, page, PAGE_SIZE)
        res = r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }
      }

      if (res.ok) {
        const items = Array.isArray(res.data) ? res.data : (res.data as { items: unknown[] }).items
        const total = Array.isArray(res.data) ? items.length : (res.data as { total: number }).total
        const prev = get()[key] as UserListState<unknown>
        // 评论列表经脱敏补拉后返回 nextPage/hasMore，按游标追加避免翻页错位
        const nextPage = Array.isArray(res.data) ? null : (res.data as { nextPage?: number }).nextPage
        const hasMore = Array.isArray(res.data)
          ? items.length >= PAGE_SIZE
          : (res.data as { hasMore?: boolean }).hasMore ?? items.length >= PAGE_SIZE
        set({
          [key]: {
            items: append ? [...prev.items, ...items] : items,
            total,
            page: key === 'comments' && nextPage != null ? nextPage - 1 : page,
            hasMore,
            loading: false,
            error: null
          }
        } as Partial<UserState>)
      } else {
        const prev = get()[key] as UserListState<unknown>
        set({ [key]: { ...prev, loading: false, error: res.error } } as Partial<UserState>)
      }
    } catch (err) {
      const prev = get()[key] as UserListState<unknown>
      set({ [key]: { ...prev, loading: false, error: (err as Error).message } } as Partial<UserState>)
    }
  },

  toggleFollow: async () => {
    const { uid, followBusy, followState } = get()
    if (!uid || followBusy) return
    set({ followBusy: true })
    const res = await window.hqsf.followUser(uid, !followState)
    set({ followBusy: false })
    if (res.ok && res.data.ok) {
      set({ followState: !followState })
      // 关注/取关后粉丝数可能变化：重拉头部统计（自己页关注数也会变）
      void get().loadHeader()
    }
  },

  clock: async () => {
    const { clocking } = get()
    if (clocking) return
    set({ clocking: true, clockMessage: null })
    const res = await window.hqsf.clockIn()
    set({ clocking: false })
    if (res.ok && res.data.ok) {
      const r = res.data as ClockResult
      const cur = get()
      set({
        selfStatus: r.assets != null ? { ...(cur.selfStatus ?? { assets: r.assets }), assets: r.assets } : cur.selfStatus,
        stats: cur.stats ? { ...cur.stats, isClock: 1 } : null,
        clockMessage: r.award != null ? `签到成功，获得 ${r.award} 能量币` : '签到成功'
      })
    } else {
      set({ clockMessage: res.ok ? res.data.error ?? '签到失败' : res.error })
    }
  }
}))
