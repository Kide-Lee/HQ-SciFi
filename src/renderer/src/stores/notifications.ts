import { create } from 'zustand'
import type { AppNotification, NotificationCategory } from '../../../shared/types'

export { type AppNotification, type NotificationCategory }

interface NotificationState {
  notifications: AppNotification[]
  totalUnread: number
  loading: boolean
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  refreshUnread: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markCategoryRead: (category: NotificationCategory) => Promise<void>
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  totalUnread: 0,
  loading: false,
  loaded: false,
  error: null,

  load: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const res = await window.hqsf.listNotifications()
      if (res.ok) {
        // 列表可能分页，未读数以 unreadNum 接口为准
        const unreadRes = await window.hqsf.getUnreadCount()
        set({
          notifications: res.data.items,
          totalUnread: unreadRes.ok ? unreadRes.data.total : res.data.totalUnread,
          loaded: true,
          loading: false
        })
      } else {
        set({ error: res.error, loaded: true, loading: false })
      }
    } catch (err) {
      set({ error: (err as Error).message, loaded: true, loading: false })
    }
  },

  refreshUnread: async () => {
    try {
      const res = await window.hqsf.getUnreadCount()
      if (res.ok) set({ totalUnread: res.data.total })
    } catch {
      // 静默：列表加载时会刷新 totalUnread
    }
  },

  markRead: async (id) => {
    const target = get().notifications.find((n) => n.id === id)
    if (!target || target.read) return
    // 真实 setRead 按分类标记已读，因此单条已读也按整个分类处理
    await get().markCategoryRead(target.category)
  },

  markCategoryRead: async (category) => {
    const ids = get().notifications.filter((n) => n.category === category && !n.read).map((n) => n.id)
    if (ids.length === 0) return
    set((s) => ({
      notifications: s.notifications.map((n) => (n.category === category ? { ...n, read: true } : n)),
      totalUnread: Math.max(0, s.totalUnread - ids.length)
    }))
    const res = await window.hqsf.markNotificationsRead([category])
    if (!res.ok) void get().load()
  }
}))
