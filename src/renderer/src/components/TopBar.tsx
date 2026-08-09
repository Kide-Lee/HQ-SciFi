import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Minus, PanelLeftClose, PanelLeftOpen, PanelRight, Square, X } from 'lucide-react'
import { SECTION_LABELS, useUiStore } from '../stores/ui'
import { useReaderStore } from '../stores/reader'
import { useEditorStore } from '../stores/editor'

/** 页面标题推导（v0.0.3：所有页面顶栏显示当前页面标题） */
function usePageTitle(): string {
  const section = useUiStore((s) => s.section)
  const listContext = useUiStore((s) => s.listContext)
  const selectedId = useUiStore((s) => s.selectedId)
  const readingCid = useReaderStore((s) => s.readingCid)
  const detail = useReaderStore((s) => s.detail)
  const currentPath = useEditorStore((s) => s.currentPath)

  // 文章阅读态优先（写作视图打开远端文章也走这里）
  if (readingCid) return detail?.title ?? '阅读'
  if (section === 'writing') {
    return currentPath ? (currentPath.split('/').pop() ?? SECTION_LABELS.writing) : SECTION_LABELS.writing
  }
  if (listContext) return `${SECTION_LABELS[section]} · ${listContext.title ?? selectedId ?? ''}`
  return SECTION_LABELS[section]
}

/**
 * v0.0.3 全局顶栏（无边框窗口）：
 * 左侧页面标题；右侧为「展开右栏」（仅文章页）+ 最小化 / 全屏 / 关闭窗口控件。
 * 整条顶栏为窗口拖拽区域（按钮区 no-drag，由 CSS 控制）。
 */
export function TopBar(): React.JSX.Element {
  const title = usePageTitle()
  const readingCid = useReaderStore((s) => s.readingCid)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const panelOpen = useUiStore((s) => s.readerPanelOpen)
  const togglePanel = useUiStore((s) => s.toggleReaderPanel)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebarCollapsed)

  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let alive = true
    void window.hqsf.windowControls.isMaximized().then((v) => {
      if (alive) setMaximized(v)
    })
    const off = window.hqsf.windowControls.onMaximizedChanged((v) => {
      if (alive) setMaximized(v)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <header className="topbar">
      {/* v0.0.3：左侧——阅读态显示「返回列表」 */}
      <div className="topbar-left">
        {readingCid && (
          <button className="topbar-back-btn" onClick={closeArticle} title="返回列表">
            <ArrowLeft size={13} /> 返回列表
          </button>
        )}
      </div>
      <div className="topbar-title" title={title}>
        {title}
      </div>
      <div className="topbar-controls">
        {/* v0.0.3：折叠左栏（与右栏按钮同排） */}
        <button
          className="topbar-btn"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? '展开左栏' : '折叠左栏'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        {readingCid && (
          <button
            className={`topbar-btn ${panelOpen ? 'active' : ''}`}
            onClick={togglePanel}
            title={panelOpen ? '收起右栏' : '展开右栏'}
          >
            <PanelRight size={14} />
          </button>
        )}
        <button className="topbar-btn" onClick={() => void window.hqsf.windowControls.minimize()} title="最小化">
          <Minus size={14} />
        </button>
        <button
          className="topbar-btn"
          onClick={() => void window.hqsf.windowControls.toggleMaximize()}
          title={maximized ? '还原窗口' : '全屏'}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="topbar-btn topbar-close"
          onClick={() => void window.hqsf.windowControls.close()}
          title="关闭"
        >
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
