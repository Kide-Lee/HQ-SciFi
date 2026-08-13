import { useMemo } from 'react'

/** 右栏 tab 定义（文章页目录/评论/评审、编辑器预览/目录共用） */
export interface RightPanelTab {
  /** tab 唯一 id */
  id: string
  /** tab 栏文案 */
  label: string
  /** tab 计数徽标（可选，如「评论 12」） */
  count?: number
  /** 是否显示该 tab（由调用方按场景决定：评审仅非本人文章、目录仅在存在标题时） */
  visible: boolean
  /** tab 内容 */
  content: React.ReactNode
}

interface RightPanelProps {
  /** 当前 tab id；不在可见列表时渲染期自动回退到第一个可见 tab（store 回退由调用方负责） */
  tab: string | null
  onTabChange: (id: string) => void
  tabs: RightPanelTab[]
  /** 收起态（宽度 0，配合过渡动画） */
  collapsed?: boolean
  /** 拖动分栏中（禁用宽度过渡，保证跟手） */
  dragging?: boolean
  /** 面板宽度（如 `${ratio * 100}%`；收起时强制 0） */
  width?: string
  className?: string
}

/**
 * v0.0.6：通用右栏容器（右栏不是文章页独属的设计，编辑器等场景同样唤出）。
 * 规则（design.md v0.0.6）：
 * - 一个可见 tab 都没有 → 不渲染右栏；
 * - 仅一个可见 tab → 不渲染 tab 栏；
 * 样式沿用 .reader-panel（宽度/拖动分栏由调用方控制，如 ReaderView 的 splitRatio）。
 */
export function RightPanel({
  tab,
  onTabChange,
  tabs,
  collapsed = false,
  dragging = false,
  width,
  className
}: RightPanelProps): React.JSX.Element | null {
  const visible = useMemo(() => tabs.filter((t) => t.visible), [tabs])
  if (visible.length === 0) return null
  const current = visible.some((t) => t.id === tab) ? tab : visible[0].id
  const active = visible.find((t) => t.id === current) ?? visible[0]

  return (
    <aside
      className={`reader-panel${collapsed ? ' collapsed' : ''}${dragging ? ' dragging' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: collapsed ? 0 : width }}
    >
      {visible.length > 1 && (
        <div className="reader-panel-tabs">
          {visible.map((t) => (
            <button
              key={t.id}
              className={`reader-panel-tab ${current === t.id ? 'active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
              {t.count ? ` ${t.count}` : ''}
            </button>
          ))}
        </div>
      )}
      {active.content}
    </aside>
  )
}
