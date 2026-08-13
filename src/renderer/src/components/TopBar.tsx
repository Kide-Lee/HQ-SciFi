import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Minus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Square, X } from 'lucide-react'
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
  // v0.0.6：编辑态（写作 + 已打开文档）顶栏显示「返回」，替代原编辑器底部 .editor-close
  const editorPath = useEditorStore((s) => s.currentPath)
  const closeEditor = useEditorStore((s) => s.close)
  // v0.0.6：编辑器右栏（预览/目录）展开按钮（与文章页右栏按钮并列）
  const editorPanelOpen = useUiStore((s) => s.editorPanelOpen)
  const editorPanelAvailable = useUiStore((s) => s.editorPanelAvailable)
  const toggleEditorPanel = useUiStore((s) => s.toggleEditorPanel)
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
        {readingCid && (
          <button className="topbar-back-btn" onClick={closeArticle} title="返回列表">
            <ArrowLeft size={13} /> 返回列表
          </button>
        )}
        {/* v0.0.6：编辑态「返回」（沿用 .topbar-back-btn，替代原 .editor-close） */}
        {!readingCid && section === 'writing' && editorPath && (
          <button className="topbar-back-btn" onClick={() => void closeEditor()} title="关闭当前文档，返回写作首页">
            <ArrowLeft size={13} /> 返回
          </button>
        )}
      </div>
      <div className="topbar-title" title={title}>
        {title}
      </div>
      <div className="topbar-controls">
        {readingCid && (
          <button
            className="topbar-btn"
            onClick={togglePanel}
            title={panelOpen ? '收起右栏' : '展开右栏'}
          >
            {/* v0.0.6：与左栏折叠按钮统一——收起/展开换图标，不再用 active 变色 */}
            {panelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        )}
        {/* v0.0.6：编辑器右栏（预览/目录）展开按钮——仅编辑态且有可用 tab 时显示（无 tab 不显示右栏按钮） */}
        {!readingCid && section === 'writing' && editorPath && editorPanelAvailable && (
          <button
            className="topbar-btn"
            onClick={toggleEditorPanel}
            title={editorPanelOpen ? '收起右栏' : '展开右栏'}
          >
            {editorPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
        )}
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
