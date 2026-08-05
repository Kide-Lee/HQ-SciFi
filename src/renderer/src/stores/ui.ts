import { create } from 'zustand'

export type TopSection = 'writing' | 'recommend' | 'serial' | 'activity' | 'library'

export const SECTION_LABELS: Record<TopSection, string> = {
  writing: '写作',
  recommend: '推荐',
  serial: '连载',
  activity: '活动',
  library: '作品库'
}

interface UiState {
  section: TopSection
  selectedId: string | null
  setSection: (section: TopSection) => void
  setSelectedId: (id: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  section: 'writing',
  selectedId: null,
  setSection: (section) => set({ section, selectedId: null }),
  setSelectedId: (selectedId) => set({ selectedId })
}))
