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
  /**
   * v0.0.8：强制隐藏「评分榜」（不显示活动状态徽章时使用）——
   * 活动状态查询失败等无法确认 phase 的入口，按保守处理隔离评分榜
   */
  hideScoreboard?: boolean
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
   * v0.0.3：右栏（目录/评论/评审/搜索…）展开状态，由顶栏「展开右栏」按钮切换。
   * v0.0.6+：从阅读/编辑器各一份合并为全局单份——所有视图均可调出右栏（搜索为基础 tab）。
   */
  panelOpen: boolean
  /** 右栏当前 tab（key 由各视图 tabs 定义：文章页 toc/comments/review/search、编辑器 preview/toc/search 等） */
  panelTab: string
  /**
   * v0.0.6：登录模态是否打开（未登录也可浏览/写作，登录作为覆盖层从用户卡唤起）
   */
  loginOpen: boolean
  /** v0.0.6+：搜索面板状态（Ctrl+F 调出；词与正则开关全局持久，切换视图不丢） */
  searchQuery: string
  searchRegex: boolean
  /** v0.0.7+：当前活动匹配序号（0-based；SearchPanel 计数/结果列表与正文高亮共享） */
  searchActive: number
  setSection: (section: TopSection) => void
  setSelectedId: (id: string | null) => void
  /** 打开栏目列表（作品库分类等） */
  openList: (ctx: ListContext) => void
  closeList: () => void
  setRevealTarget: (target: { section: TopSection; mid?: number | string; cid?: string } | null) => void
  togglePanel: () => void
  toggleSidebarCollapsed: () => void
  setPanelTab: (tab: string) => void
  /** 打开右栏并切到指定 tab（Ctrl+F 搜索用） */
  openPanelTab: (tab: string) => void
  setSearchQuery: (q: string) => void
  setSearchRegex: (v: boolean) => void
  setSearchActive: (idx: number) => void
  openLogin: () => void
  closeLogin: () => void
}

export const useUiStore = create<UiState>((set) => ({
  section: 'writing',
  selectedId: null,
  listContext: null,
  revealTarget: null,
  sidebarCollapsed: localStorage.getItem('hqsf-sidebar-collapsed') === '1',
  panelOpen: false,
  panelTab: 'search',
  loginOpen: false,
  searchQuery: '',
  searchRegex: false,
  searchActive: 0,
  setSection: (section) => set({ section, selectedId: null, listContext: null }),
  setSelectedId: (selectedId) => set({ selectedId }),
  openList: (ctx) => set({ selectedId: ctx.title, listContext: ctx }),
  closeList: () => set({ listContext: null }),
  setRevealTarget: (revealTarget) => set({ revealTarget }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleSidebarCollapsed: () =>
    set((s) => {
      const v = !s.sidebarCollapsed
      localStorage.setItem('hqsf-sidebar-collapsed', v ? '1' : '0')
      return { sidebarCollapsed: v }
    }),
  setPanelTab: (panelTab) => set({ panelTab }),
  openPanelTab: (panelTab) => set({ panelOpen: true, panelTab }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchRegex: (searchRegex) => set({ searchRegex }),
  setSearchActive: (searchActive) => set({ searchActive }),
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false })
}))
