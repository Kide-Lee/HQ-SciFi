import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { NotificationPanel } from './NotificationPanel'
import { useNotificationStore } from '../stores/notifications'
import { useUiStore } from '../stores/ui'

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

  // v0.0.9：右栏 tab 溢出折叠——最多显示 4 个，其余收进「更多」下拉；
  // 若当前激活 tab 在折叠区，则把它提升到可见区，避免用户看不到当前所在 tab。
  const MAX_VISIBLE_TABS = 4
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement | null>(null)
  // v0.0.9：全局「消息」tab——所有右栏统一注册，未读数来自本地通知中心
  const totalUnread = useNotificationStore((s) => s.totalUnread)
  const setPanelNotificationOnly = useUiStore((s) => s.setPanelNotificationOnly)
  // v0.0.9：当业务方没有提供任何 tab（只有全局「消息」tab）时，通知 RightPanel 当前为纯通知右栏
  const notificationOnly = tabs.length === 0
  useEffect(() => {
    setPanelNotificationOnly(notificationOnly)
  }, [notificationOnly, setPanelNotificationOnly])
  const messageTab: RightTab<string> = {
    key: 'messages',
    label: '消息',
    badge: totalUnread,
    content: <NotificationPanel />
  }
  // v0.0.9：消息 tab 放在「搜索」后面；没有搜索时保持最后
  const searchIndex = tabs.findIndex((t) => t.key === 'search')
  const allTabs: Array<RightTab<string>> =
    searchIndex >= 0
      ? [
          ...tabs.slice(0, searchIndex + 1),
          messageTab,
          ...tabs.slice(searchIndex + 1)
        ]
      : [...tabs, messageTab]

  // 点击下拉外部时关闭
  useEffect(() => {
    if (!moreOpen) return
    const onMouseDown = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [moreOpen])

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

  if (allTabs.length === 0) return null
  const active = allTabs.some((t) => t.key === activeTab) ? activeTab : allTabs[0].key
  const current = allTabs.find((t) => t.key === active)
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
        {!single && (() => {
          // v0.0.9：全局「消息」tab 始终保持可见；其余 tab 最多占 3 个可见位，
          // 若激活的是折叠区内的普通 tab，则提升该 tab 并挤掉第 3 个普通位。
          const messageTab = allTabs.find((t) => t.key === 'messages')
          const regularTabs = allTabs.filter((t) => t.key !== 'messages')
          const regularActiveIndex = regularTabs.findIndex((t) => t.key === active)
          let visibleTabs: Array<RightTab<string>>
          if (messageTab) {
            if (active === 'messages') {
              visibleTabs = [...regularTabs.slice(0, MAX_VISIBLE_TABS - 1), messageTab]
            } else if (regularActiveIndex >= MAX_VISIBLE_TABS - 1) {
              visibleTabs = [
                ...regularTabs.slice(0, MAX_VISIBLE_TABS - 2),
                regularTabs[regularActiveIndex],
                messageTab
              ]
            } else {
              visibleTabs = [...regularTabs.slice(0, MAX_VISIBLE_TABS - 1), messageTab]
            }
          } else {
            const activeIndex = allTabs.findIndex((t) => t.key === active)
            const activeInMore = activeIndex >= MAX_VISIBLE_TABS
            visibleTabs = activeInMore
              ? [...allTabs.slice(0, MAX_VISIBLE_TABS - 1), allTabs[activeIndex]]
              : allTabs.slice(0, MAX_VISIBLE_TABS)
          }
          const visibleKeys = new Set(visibleTabs.map((t) => t.key))
          const moreTabs = allTabs.filter((t) => !visibleKeys.has(t.key))
          return (
            <div className="reader-panel-tabs">
              {visibleTabs.map((t) => (
                <button
                  key={t.key}
                  className={`reader-panel-tab${t.key === active ? ' active' : ''}`}
                  onClick={() => onTabChange(t.key)}
                >
                  {t.label}
                  {t.badge != null && t.badge > 0 ? ` ${t.badge}` : ''}
                </button>
              ))}
              {moreTabs.length > 0 && (
                <div className="reader-panel-more" ref={moreRef}>
                  <button
                    className={`reader-panel-more-btn${moreOpen ? ' open' : ''}`}
                    onClick={() => setMoreOpen((v) => !v)}
                    title="更多"
                    aria-label="更多"
                    aria-expanded={moreOpen}
                  >
                    ⋯
                  </button>
                  {moreOpen && (
                    <div className="reader-panel-more-menu">
                      {moreTabs.map((t) => (
                        <button
                          key={t.key}
                          className={`reader-panel-more-item${t.key === active ? ' active' : ''}`}
                          onClick={() => {
                            onTabChange(t.key)
                            setMoreOpen(false)
                          }}
                        >
                          <span>{t.label}</span>
                          {t.badge != null && t.badge > 0 ? (
                            <span className="reader-panel-more-badge">{t.badge}</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
        {current.content}
      </aside>
    </>
  )
}
