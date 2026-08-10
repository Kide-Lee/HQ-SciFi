import { create } from 'zustand'
import type { ActivityPhase } from '../lib/activity'

export type TopSection = 'writing' | 'recommend' | 'serial' | 'activity' | 'library'

export const SECTION_LABELS: Record<TopSection, string> = {
  writing: '写作',
  recommend: '推荐',
  serial: '连载',
  activity: '活动',
  library: '作品库'
}

/** 栏目列表上下文（M2 作品库 / M3 各栏目共用）：决定 ArticleListView 拉取什么 */
export interface ListContext {
  /** 列表标题 */
  title: string
  /** 内容形态：articles 文章列表（默认）/ gpt AI 模型卡片 */
  kind?: 'articles' | 'gpt'
  /** 分类/连载/活动 mid（走 selectContents） */
  mid?: number | string
  /** searchParams 过滤（contentsList） */
  searchParams?: Record<string, unknown>
  /** 精选源（choiceList，推荐栏目） */
  choice?: boolean
  /**
   * 活动状态（v0.0.2）：进行中/评审中的活动文章无评分，
   * 列表需隐藏「评分榜」排序、评分与排名
   */
  activityPhase?: ActivityPhase
  /** 活动的完整 meta（v0.0.2：列表页顶部展示活动介绍用） */
  meta?: {
    mid: number | string
    name: string
    imgurl?: string
    description?: string
    deadline?: number
  }
}

interface UiState {
  section: TopSection
  selectedId: string | null
  /** 当前栏目列表的取数上下文（null = 不显示列表） */
  listContext: ListContext | null
  /**
   * v0.0.2：左栏定位目标——从文章标签跳转时设置，
   * Sidebar 据此展开活动树并高亮/滚动到该文章标题
   */
  revealTarget: { section: TopSection; mid?: number | string; cid?: string } | null
  /**
   * v0.0.3：左栏折叠状态（由顶栏折叠按钮切换；localStorage 持久化，
   * 提升到全局以便 TopBar 与 Sidebar 共用）
   */
  sidebarCollapsed: boolean
  /**
   * v0.0.3：阅读页右栏（目录/评论/评审）展开状态，
   * 由顶栏「展开右栏」按钮切换（原 ReaderView 内部 showReview 提升至此）
   */
  readerPanelOpen: boolean
  /** v0.0.3：右栏当前 tab（目录 / 评论 / 评审） */
  readerPanelTab: 'toc' | 'comments' | 'review'
  /**
   * v0.0.6：登录模态是否打开（未登录也可浏览/写作，登录作为覆盖层从用户卡唤起）
   */
  loginOpen: boolean
  setSection: (section: TopSection) => void
  setSelectedId: (id: string | null) => void
  /** 打开栏目列表（作品库分类等） */
  openList: (ctx: ListContext) => void
  closeList: () => void
  setRevealTarget: (target: { section: TopSection; mid?: number | string; cid?: string } | null) => void
  toggleReaderPanel: () => void
  toggleSidebarCollapsed: () => void
  setReaderPanelTab: (tab: 'toc' | 'comments' | 'review') => void
  openLogin: () => void
  closeLogin: () => void
}

export const useUiStore = create<UiState>((set) => ({
  section: 'writing',
  selectedId: null,
  listContext: null,
  revealTarget: null,
  sidebarCollapsed: localStorage.getItem('hqsf-sidebar-collapsed') === '1',
  readerPanelOpen: false,
  readerPanelTab: 'review',
  loginOpen: false,
  setSection: (section) => set({ section, selectedId: null, listContext: null }),
  setSelectedId: (selectedId) => set({ selectedId }),
  openList: (ctx) => set({ selectedId: ctx.title, listContext: ctx }),
  closeList: () => set({ listContext: null }),
  setRevealTarget: (revealTarget) => set({ revealTarget }),
  toggleReaderPanel: () => set((s) => ({ readerPanelOpen: !s.readerPanelOpen })),
  toggleSidebarCollapsed: () =>
    set((s) => {
      const v = !s.sidebarCollapsed
      localStorage.setItem('hqsf-sidebar-collapsed', v ? '1' : '0')
      return { sidebarCollapsed: v }
    }),
  setReaderPanelTab: (readerPanelTab) => set({ readerPanelTab }),
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false })
}))
