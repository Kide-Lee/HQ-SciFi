import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenu'
import { buildEditableContextMenu } from './editableContextMenu'
import { appMenuItems } from './appMenuItems'

export type { ContextMenuItem }

/** 菜单与视口边缘的安全距离（px） */
const EDGE_MARGIN = 8

/**
 * v1.1.12：自绘右键菜单调用入口。
 * 用法：`const showMenu = useContextMenu()` → 在元素的 onContextMenu 里
 * `showMenu(e, [{ label, icon, onSelect }])`；不调用则本次右键不出菜单。
 * 菜单本体由 App 根部唯一的 <ContextMenuHost /> 渲染（样式与暗色主题共用全局变量）。
 */
export function useContextMenu(): (e: React.MouseEvent, items: ContextMenuItem[], title?: string) => void {
  const openMenu = useContextMenuStore((s) => s.openMenu)
  return useCallback(
    (e, items, title) => {
      if (items.length === 0) return
      e.preventDefault()
      // 嵌套区域（如编辑器里的链接、正文里的图片）各自只出最内层菜单
      e.stopPropagation()
      openMenu({ x: e.clientX, y: e.clientY, items, title })
    },
    [openMenu]
  )
}

/**
 * 全局唯一的右键菜单宿主（挂在 App 根部）。
 * 行为：视口边缘自动翻转、点击外部/Esc/滚动/失焦关闭、↑↓ 选择 + Enter 执行。
 */
export function ContextMenuHost(): React.JSX.Element | null {
  const menu = useContextMenuStore((s) => s.menu)
  const closeMenu = useContextMenuStore((s) => s.closeMenu)
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(-1)

  // 先量尺寸再定位：useLayoutEffect 在绘制前完成，避免菜单在边缘「先闪一下再跳」
  useLayoutEffect(() => {
    if (!menu) {
      setPos(null)
      setActive(-1)
      return
    }
    const el = ref.current
    const w = el?.offsetWidth ?? 0
    const h = el?.offsetHeight ?? 0
    setPos({
      left: Math.max(EDGE_MARGIN, Math.min(menu.x, window.innerWidth - w - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(menu.y, window.innerHeight - h - EDGE_MARGIN))
    })
    setActive(-1)
  }, [menu])

  // 展示用菜单项 = 各上下文自己的项 + 统一追加的系统项（刷新 / 开发者工具）
  const items = useMemo<ContextMenuItem[]>(
    () => (menu ? [...menu.items, ...appMenuItems()] : []),
    [menu]
  )

  /** 可键盘选中的项（跳过置灰项与分隔线） */
  const enabledIndexes = useCallback(
    (): number[] => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0),
    [items]
  )

  // 兜底：没有任何组件接管时（组件处理器会 preventDefault）由这里出菜单。
  // 两件事必须一起做：
  // 1) 兜底菜单内容——可编辑元素出「与编辑器一致的基础编辑菜单」，其他空地方右键至少要有
  //    「刷新」「开发者工具」（由下方 appMenuItems() 统一追加，所以 items 传空数组即可）；
  // 2) 压掉 WebView 原生菜单——Electron 的渲染进程没有默认右键菜单，而 WebKitGTK/WebView2 有
  //    （英文的 Back/Forward/Reload/Select All），不在这里 preventDefault 就会漏出英文菜单。
  // window 冒泡阶段晚于 React 根容器，可据此判断「有没有人接管」。
  const openMenu = useContextMenuStore((s) => s.openMenu)
  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented) return
      const el = e.target instanceof HTMLElement ? e.target : null
      const items = (el ? buildEditableContextMenu(el) : null) ?? []
      e.preventDefault()
      e.stopPropagation()
      openMenu({ x: e.clientX, y: e.clientY, items })
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [openMenu])

  useEffect(() => {
    if (!menu) return
    const onMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeMenu()
        return
      }
      const list = enabledIndexes()
      if (list.length === 0) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((cur) => {
          const at = list.indexOf(cur)
          const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at <= 0 ? list.length - 1 : at - 1)
          return list[next]
        })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[active]
        if (item && !item.disabled) {
          closeMenu()
          item.onSelect?.()
        }
      }
    }
    const onDismiss = (): void => closeMenu()
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
    // 捕获阶段监听所有滚动容器（正文/列表滚动时菜单跟随失效，直接关掉）
    document.addEventListener('scroll', onDismiss, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('blur', onDismiss)
      document.removeEventListener('scroll', onDismiss, true)
    }
  }, [menu, active, closeMenu, enabledIndexes, items])

  if (!menu) return null

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        visibility: pos ? 'visible' : 'hidden'
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.title && <div className="context-menu-title">{menu.title}</div>}
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {item.divided && <div className="context-menu-sep" />}
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? ' danger' : ''}${i === active ? ' active' : ''}`}
            disabled={item.disabled}
            onMouseEnter={() => setActive(item.disabled ? -1 : i)}
            onClick={() => {
              if (item.disabled) return
              closeMenu()
              item.onSelect?.()
            }}
          >
            <span className="context-menu-icon">{item.icon}</span>
            <span className="context-menu-label">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  )
}
