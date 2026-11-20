import { useEffect, useRef, useState } from 'react'

interface CollapseProps {
  /** 展开态（由父组件持有） */
  open: boolean
  /** 追加到动画容器上的类名（可选） */
  className?: string
  children: React.ReactNode
}

/** 与 index.css 中 .tree-collapse 的过渡时长保持一致（transitionend 丢失时的兜底） */
const TRANSITION_MS = 300

/**
 * 高度自适应的展开/收起过渡容器（左栏各树分组共用）。
 *
 * 动画用 CSS 的 grid-template-rows: 0fr ↔ 1fr 实现：无需测量内容高度，
 * 内容异步加载（活动文章懒加载等）或数量变化时高度也不会跳变。
 * 动画容器始终挂载，内容子节点首次展开时才渲染、收起动画结束后卸载，
 * 因此保留原有的按需渲染行为，同时兼顾展开与收起的过渡。
 */
export function Collapse({ open, className, children }: CollapseProps): React.JSX.Element {
  const [openedOnce, setOpenedOnce] = useState(open)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) {
      setOpenedOnce(true)
      return
    }
    if (!openedOnce) return
    // 收起：等 grid-template-rows 过渡结束再卸载内容（内容提前消失会让高度动画落空）
    const el = rootRef.current
    let finished = false
    let timer = 0
    const finish = (): void => {
      if (finished) return
      finished = true
      if (timer) window.clearTimeout(timer)
      el?.removeEventListener('transitionend', onEnd)
      setOpenedOnce(false)
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === el && event.propertyName === 'grid-template-rows') finish()
    }
    el?.addEventListener('transitionend', onEnd)
    timer = window.setTimeout(finish, TRANSITION_MS)
    return () => {
      finished = true
      if (timer) window.clearTimeout(timer)
      el?.removeEventListener('transitionend', onEnd)
    }
  }, [open, openedOnce])

  return (
    <div
      ref={rootRef}
      className={`tree-collapse${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      inert={!open}
    >
      <div className="tree-collapse-inner">{open || openedOnce ? children : null}</div>
    </div>
  )
}