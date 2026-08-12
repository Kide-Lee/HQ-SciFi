import type { ReactNode } from 'react'

/** v0.0.6：通用右栏 tab 定义（文章页与编辑器共用） */
export interface RightTab<T extends string = string> {
  key: T
  label: string
  /** tab 徽标（如评论数）；仅 >0 时显示 */
  badge?: number
  content: ReactNode
}

interface RightPanelProps<T extends string> {
  /** 全部可用 tab（可为空——空时不渲染面板，调用方应同时隐藏展开按钮） */
  tabs: Array<RightTab<T>>
  /** 当前激活 tab（不在 tabs 中时回退到第一个） */
  activeTab: T
  onTabChange: (tab: T) => void
  /** 展开状态（收起时宽度 0） */
  open: boolean
  /** 展开宽度比例（0-1，默认 1/3） */
  splitRatio?: number
  /** 拖动分栏中：禁用宽度过渡（实时跟手） */
  dragging?: boolean
}

/**
 * v0.0.6：通用右栏容器（复用阅读页 .reader-panel 样式）。
 * 规则（对文章页与编辑器右栏一视同仁）：
 * - 零 tab：不渲染任何内容
 * - 单 tab：不设 tab 栏，直接渲染内容
 * - 多 tab：显示 tab 栏
 */
export function RightPanel<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  open,
  splitRatio = 1 / 3,
  dragging = false
}: RightPanelProps<T>): React.JSX.Element | null {
  if (tabs.length === 0) return null
  const active = tabs.some((t) => t.key === activeTab) ? activeTab : tabs[0].key
  const current = tabs.find((t) => t.key === active)
  if (!current) return null
  const single = tabs.length === 1

  return (
    <aside
      className={`reader-panel${open ? '' : ' collapsed'}${dragging ? ' dragging' : ''}`}
      style={{ width: open ? `${splitRatio * 100}%` : 0 }}
    >
      {!single && (
        <div className="reader-panel-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`reader-panel-tab${t.key === active ? ' active' : ''}`}
              onClick={() => onTabChange(t.key)}
            >
              {t.label}
              {t.badge != null && t.badge > 0 ? ` ${t.badge}` : ''}
            </button>
          ))}
        </div>
      )}
      {current.content}
    </aside>
  )
}
