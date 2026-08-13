import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

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
}

/** v0.0.7：分栏比例界限（右栏:总宽，0.2–0.6，与文章页原实现一致） */
const RATIO_MIN = 0.2
const RATIO_MAX = 0.6
/** localStorage 持久化键（沿用文章页原名，所有右栏共享一份比例） */
const RATIO_STORAGE_KEY = 'reader-split-ratio'

/**
 * v0.0.6：通用右栏容器（复用阅读页 .reader-panel 样式）。
 * 规则（对文章页与编辑器右栏一视同仁）：
 * - 零 tab：不渲染任何内容
 * - 单 tab：不设 tab 栏，直接渲染内容
 * - 多 tab：显示 tab 栏
 * v0.0.7：可拖动分栏内置——所有挂右栏的视图（文章页/编辑器/列表栏目页）均可
 * 拖动左缘分隔条调整宽度（比例持久化；收起时隐藏分隔条，拖动中禁用宽度过渡）。
 */
export function RightPanel<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  open
}: RightPanelProps<T>): React.JSX.Element | null {
  // v0.0.7：右栏宽度比例（右栏:总宽），默认 1/3，localStorage 持久化
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem(RATIO_STORAGE_KEY))
    return v >= RATIO_MIN && v <= RATIO_MAX ? v : 1 / 3
  })
  // v0.0.7：拖动分栏中（禁用右栏宽度过渡，保证实时跟手）
  const [dragging, setDragging] = useState(false)
  const asideRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    localStorage.setItem(RATIO_STORAGE_KEY, String(splitRatio))
  }, [splitRatio])

  // v0.0.7：拖动分隔条调整右栏比例（以右栏所在横向容器为基准计算）
  function onDividerDown(e: ReactMouseEvent): void {
    e.preventDefault()
    setDragging(true)
    const onMove = (ev: MouseEvent): void => {
      const layout = asideRef.current?.parentElement
      if (!layout) return
      const rect = layout.getBoundingClientRect()
      if (rect.width <= 0) return
      setSplitRatio(Math.min(RATIO_MAX, Math.max(RATIO_MIN, (rect.right - ev.clientX) / rect.width)))
    }
    const onUp = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (tabs.length === 0) return null
  const active = tabs.some((t) => t.key === activeTab) ? activeTab : tabs[0].key
  const current = tabs.find((t) => t.key === active)
  if (!current) return null
  const single = tabs.length === 1

  return (
    <>
      {open && (
        <div className="reader-divider" onMouseDown={onDividerDown} title="拖动调整右栏宽度" />
      )}
      <aside
        ref={asideRef}
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
    </>
  )
}
