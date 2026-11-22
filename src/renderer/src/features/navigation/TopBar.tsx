import { useEffect, useState } from 'react'
import {
  Bell,
  Copy,
  Eye,
  MessageCircle,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Settings,
  Square,
  Undo2,
  X
} from 'lucide-react'
import { SECTION_LABELS, useUiStore } from '../../stores/ui'
import { useReaderStore } from '../../stores/reader'
import { useEditorStore } from '../../stores/editor'
import { useUserStore } from '../../stores/user'
import { useNotificationStore } from '../../stores/notifications'

/** 页面标题推导（v0.0.3：所有页面顶栏显示当前页面标题） */
function usePageTitle(): string {
  const section = useUiStore((s) => s.section)
  const listContext = useUiStore((s) => s.listContext)
  const selectedId = useUiStore((s) => s.selectedId)
  const readingCid = useReaderStore((s) => s.readingCid)
  const detail = useReaderStore((s) => s.detail)
  const currentPath = useEditorStore((s) => s.currentPath)
  const userPageUid = useUiStore((s) => s.userPageUid)
  const profile = useUserStore((s) => s.profile)

  // v0.0.8：用户页优先（标题显示昵称/UID）
  if (userPageUid) {
    return profile?.name ?? `用户主页 · UID ${userPageUid}`
  }

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
  const listContext = useUiStore((s) => s.listContext)
  const closeList = useUiStore((s) => s.closeList)
  const librarySearchActive = useUiStore((s) => s.librarySearchActive)
  const setLibrarySearchActive = useUiStore((s) => s.setLibrarySearchActive)
  const readingCid = useReaderStore((s) => s.readingCid)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const currentPath = useEditorStore((s) => s.currentPath)
  const closeEditor = useEditorStore((s) => s.close)
  const editMode = useEditorStore((s) => s.mode)
  const setEditMode = useEditorStore((s) => s.setMode)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const panelMode = useUiStore((s) => s.panelMode)
  const panelTab = useUiStore((s) => s.panelTab)
  const togglePanel = useUiStore((s) => s.togglePanel)
  const totalUnread = useNotificationStore((s) => s.totalUnread)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebarCollapsed)
  const userPageUid = useUiStore((s) => s.userPageUid)
  const closeUserPage = useUiStore((s) => s.closeUserPage)

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

  // v0.0.6+：Ctrl/Cmd+F 调出右栏「搜索」（仅文章页/编辑器页有搜索 tab 时生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        const canSearch = !!readingCid || (section === 'writing' && !!currentPath)
        if (!canSearch) return
        e.preventDefault()
        useUiStore.getState().openPanelTab('search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readingCid, section, currentPath])

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

  // v0.1.11：文章栏只在阅读页/编辑器页可用（用户页、栏目列表页没有业务 tab）
  const articleAvailable = !userPageUid && (!!readingCid || section === 'writing')
  const settingsActive = panelOpen && panelMode === 'settings'
  const articleActive = panelOpen && panelMode === 'article'
  // v0.1.11：有未读通知时，「设置」按钮恢复为旧的通知按钮样式（铃铛 + 红点），点击直达消息
  const notificationButton = totalUnread > 0
  const messagesActive = settingsActive && panelTab === 'messages'

  // 返回按钮：按页面层级只保留一个「返回」，顺序与 usePageTitle 的优先级一致。
  // listContext 覆盖推荐「精选 / AI模型」、活动详情、连载合集等所有列表页；
  // 阅读态优先回列表（此时 listContext 仍在，不能再显示两个返回）。
  const backAction = userPageUid
    ? closeUserPage
    : readingCid
      ? closeArticle
      : section === 'writing' && currentPath
        ? closeEditor
        : listContext
          ? closeList
          : section === 'library' && librarySearchActive
            ? () => setLibrarySearchActive(false)
            : null

  // 离开文章页/编辑器后收起残留的文章栏，避免回到文章页时无故重新弹出
  useEffect(() => {
    if (articleAvailable) return
    const ui = useUiStore.getState()
    if (ui.panelOpen && ui.panelMode === 'article') ui.closePanel()
  }, [articleAvailable])

  return (
    <header className={isMac ? 'topbar topbar-mac' : 'topbar'} data-hqsf-drag-region="">
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
        {backAction && (
          <button className="topbar-back-btn" onClick={backAction} title="返回">
            <Undo2 size={14} />
          </button>
        )}
      </div>
      <div className="topbar-title" title={title}>
        {title}
      </div>
      <div className="topbar-controls">
        {/* v0.1.11：右栏按钮拆为「设置」（历史/消息/设置）与「文章」（目录/评论/评审/搜索）两个 */}
        {/* 「文章」仅在阅读页/编辑器页出现；图标规则：常态显示各自图标 → hover 显示「右栏待打开」→ 展开后只显示「右栏已打开」 */}
        <button
          className={`topbar-btn panel-toggle${settingsActive ? ' open' : ''}${
            notificationButton ? ' has-notification' : ''
          }`}
          onClick={() => {
            if (!notificationButton) {
              togglePanel('settings')
              return
            }
            const ui = useUiStore.getState()
            if (ui.panelOpen && ui.panelMode === 'settings' && ui.panelTab === 'messages') {
              ui.closePanel()
            } else {
              ui.openPanelTab('messages')
            }
          }}
          title={
            notificationButton
              ? messagesActive
                ? '收起消息'
                : '查看消息'
              : settingsActive
                ? '收起设置栏（历史 / 消息 / 设置）'
                : '展开设置栏（历史 / 消息 / 设置）'
          }
          aria-label={notificationButton ? '消息' : '设置栏'}
          aria-expanded={notificationButton ? messagesActive : settingsActive}
        >
          {/* 有未读时常态图标换成铃铛（保留红点）；hover / 展开图标与普通状态一致 */}
          {notificationButton ? (
            <Bell size={14} className="panel-ico idle" />
          ) : (
            <Settings size={14} className="panel-ico idle" />
          )}
          <PanelRightOpen size={14} className="panel-ico peek" />
          <PanelRightClose size={14} className="panel-ico open" />
          {notificationButton && <span className="topbar-notify-dot" />}
        </button>
        {articleAvailable && (
          <button
            className={`topbar-btn panel-toggle${articleActive ? ' open' : ''}`}
            onClick={() => togglePanel('article')}
            title={articleActive ? '收起文章栏（目录 / 评论 / 评审 / 搜索）' : '展开文章栏（目录 / 评论 / 评审 / 搜索）'}
            aria-label="文章栏"
            aria-expanded={articleActive}
          >
            <MessageCircle size={14} className="panel-ico idle" />
            <PanelRightOpen size={14} className="panel-ico peek" />
            <PanelRightClose size={14} className="panel-ico open" />
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
