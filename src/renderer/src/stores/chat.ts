import { create } from 'zustand'

export interface ChatTarget {
  uid: string
  name: string
  avatar?: string
}

interface ChatState {
  target: ChatTarget | null
  open: (target: ChatTarget) => void
  close: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null })
}))
