import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { NotificationPanel } from '../notifications/NotificationPanel'
import { SettingsPanel } from '../settings/SettingsPanel'
import { HistoryPanel } from './HistoryPanel'
import { useNotificationStore } from '../../stores/notifications'
import { useUiStore } from '../../stores/ui'

/** v0.0.6：通用右栏 tab 定义（文章页与编辑器共用） */
export interface RightTab<T extends string = string> {
  key: T
  label: string
  /** tab 徽标（如评论数）；仅 >0 时显示 */
  badge?: number
  content: ReactNode
}

interface RightPanelProps<T extends string> {
  /** 文章模式的业务 tab（可为空——空时不渲染面板，调用方应同时禁用「文章」按钮） */
  tabs: Array<RightTab<T>>
  /** 当前激活 tab（不在 tabs 中时回退到第一个） */
  activeTab: string
  onTabChange: (tab: string) => void
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
 * - v0.1.11：右栏分两种模式，由顶栏「设置」「文章」按钮切换：
 *   设置模式 = 历史 / 消息 / 设置（设置 tab 内再分系统/界面/用户）；
 *   文章模式 = 各视图传入的业务 tab（文章页：目录/评论/评审/搜索；编辑器：预览/目录/搜索…）。
 *   两种模式各自记住上次停留的 tab；设置面板恒有 3 个 tab、文章面板最多 4 个，故不再需要「更多」折叠。
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

  const panelMode = useUiStore((s) => s.panelMode)
  // v0.0.9：全局「消息」tab——所有右栏统一注册，未读数来自本地通知中心
  const totalUnread = useNotificationStore((s) => s.totalUnread)

  // 设置模式固定三个 tab；文章模式使用视图传入的业务 tab
  const historyTab: RightTab<string> = {
    key: 'history',
    label: '历史',
    content: <HistoryPanel />
  }
  const messageTab: RightTab<string> = {
    key: 'messages',
    label: '消息',
    badge: totalUnread,
    content: <NotificationPanel />
  }
  const settingsTab: RightTab<string> = {
    key: 'settings',
    label: '设置',
    content: <SettingsPanel />
  }
  const allTabs: Array<RightTab<string>> =
    panelMode === 'settings'
      ? [historyTab, messageTab, settingsTab]
      : (tabs as Array<RightTab<string>>)

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

  const active = allTabs.some((t) => t.key === activeTab) ? activeTab : allTabs[0]?.key
  const current = active ? allTabs.find((t) => t.key === active) : undefined
  // 文章模式下当前视图没有业务 tab（如作品库/推荐列表页）时不渲染面板
  if (!current) return null
  const single = allTabs.length === 1

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
            {allTabs.map((t) => (
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
