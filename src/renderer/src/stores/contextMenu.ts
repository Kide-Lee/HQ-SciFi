import { create } from 'zustand'
import type { ReactNode } from 'react'

/**
 * v1.1.12：自绘右键菜单的全局状态。
 * 菜单只承载「没有按钮入口」的操作——凡已有按钮的功能不重复出现在右键菜单里。
 */
export interface ContextMenuItem {
  /** 展示文案（同时作为 React key 的组成部分） */
  label: string
  icon?: ReactNode
  /** 选中执行（可选：仅作占位/标题时省略） */
  onSelect?: () => void
  /** 置灰不可点（例如未登录时的「同步到草稿」） */
  disabled?: boolean
  /** 危险操作（红色描边） */
  danger?: boolean
  /** 在此项之前插入分隔线（分组用） */
  divided?: boolean
}

export interface ContextMenuState {
  /** 打开位置（视口坐标，由 Host 做边缘翻转） */
  x: number
  y: number
  /** 顶部实体标题（如文件名；可选） */
  title?: string
  items: ContextMenuItem[]
}

interface ContextMenuStore {
  menu: ContextMenuState | null
  openMenu: (menu: ContextMenuState) => void
  closeMenu: () => void
}

export const useContextMenuStore = create<ContextMenuStore>((set) => ({
  menu: null,
  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null })
}))
