import { create } from 'zustand'

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
}

interface UiState {
  section: TopSection
  selectedId: string | null
  /** 当前栏目列表的取数上下文（null = 不显示列表） */
  listContext: ListContext | null
  setSection: (section: TopSection) => void
  setSelectedId: (id: string | null) => void
  /** 打开栏目列表（作品库分类等） */
  openList: (ctx: ListContext) => void
  closeList: () => void
}

export const useUiStore = create<UiState>((set) => ({
  section: 'writing',
  selectedId: null,
  listContext: null,
  setSection: (section) => set({ section, selectedId: null, listContext: null }),
  setSelectedId: (selectedId) => set({ selectedId }),
  openList: (ctx) => set({ selectedId: ctx.title, listContext: ctx }),
  closeList: () => set({ listContext: null })
}))
