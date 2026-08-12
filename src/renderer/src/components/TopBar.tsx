import { useEffect, useState } from 'react'
import { Copy, Eye, Minus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, PenLine, Square, Undo2, X } from 'lucide-react'
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
  const section = useUiStore((s) => s.section)
  const readingCid = useReaderStore((s) => s.readingCid)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const currentPath = useEditorStore((s) => s.currentPath)
  const closeEditor = useEditorStore((s) => s.close)
  const editMode = useEditorStore((s) => s.mode)
  const setEditMode = useEditorStore((s) => s.setMode)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const togglePanel = useUiStore((s) => s.togglePanel)
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

  // v0.0.6+：Ctrl/Cmd+F 调出右栏「搜索」（Word 导航窗格式）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        useUiStore.getState().openPanelTab('search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // macOS 用原生红绿灯（hiddenInset），渲染层隐藏自绘窗口按钮、左栏避开红绿灯
  const [platform, setPlatform] = useState('')
  useEffect(() => {
    let alive = true
    void window.hqsf.getAppInfo().then((info) => {
      if (alive) setPlatform(info.platform)
    })
    return () => {
      alive = false
    }
  }, [])
  const isMac = platform === 'darwin'

  return (
    <header className={isMac ? 'topbar topbar-mac' : 'topbar'}>
      {/* v0.0.3：左侧——阅读态显示「返回列表」 */}
      <div className="topbar-left">
        {/* v0.0.6：折叠左栏按钮移到顶栏左侧（原在右侧窗口控件旁） */}
        <button
          className="topbar-btn"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? '展开左栏' : '折叠左栏'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        {/* v0.0.6：编辑模式切换——单按钮放折叠按钮与返回按钮之间；显示当前模式图标，hover 显示另一模式图标，点击切换 */}
        {section === 'writing' && currentPath && (
          <button
            className="topbar-btn editor-mode-toggle"
            onClick={() => setEditMode(editMode === 'wysiwyg' ? 'split' : 'wysiwyg')}
            title={
              editMode === 'wysiwyg'
                ? '当前：可视化模式。点击切换到源码模式'
                : '当前：源码模式。点击切换到可视化模式'
            }
          >
            {editMode === 'wysiwyg' ? (
              <>
                <Eye size={14} className="mode-ico current" />
                <PenLine size={14} className="mode-ico alt" />
              </>
            ) : (
              <>
                <PenLine size={14} className="mode-ico current" />
                <Eye size={14} className="mode-ico alt" />
              </>
            )}
          </button>
        )}
        {readingCid && (
          <button className="topbar-back-btn" onClick={closeArticle} title="返回">
            <Undo2 size={14} />
          </button>
        )}
        {/* v0.0.6：编辑页与文章页统一「返回」按钮（仅图标）——写作编辑态关闭当前文档 */}
        {section === 'writing' && currentPath && (
          <button className="topbar-back-btn" onClick={closeEditor} title="返回">
            <Undo2 size={14} />
          </button>
        )}
      </div>
      <div className="topbar-title" title={title}>
        {title}
      </div>
      <div className="topbar-controls">
        {/* v0.0.6+：所有视图均可调出右栏（搜索为基础 tab，故按钮恒显示） */}
        <button
          className="topbar-btn"
          onClick={togglePanel}
          title={panelOpen ? '收起右栏' : '展开右栏'}
        >
          {panelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
        {/* macOS 用原生红绿灯，不渲染自绘窗口按钮 */}
        {!isMac && (
          <>
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
          </>
        )}
      </div>
    </header>
  )
}
