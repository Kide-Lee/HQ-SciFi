import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, FilePlus, Folder, FolderPlus, Trash2 } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { useDocsStore } from '../stores/docs'
import { useUiStore } from '../stores/ui'
import { ErrorBanner } from './ErrorBanner'
import { formatSize, formatTs, expandMediaTags } from '../lib/sanitize'
import { renderMdPreview } from '../lib/mdPreview'
import { RightPanel, type RightTab } from './RightPanel'
import { SearchPanel } from './SearchPanel'
import { EditorPreview } from './EditorPreview'
import { editorSearchParams, refreshEditorSearch, scrollToActiveSearch } from '../lib/editorSearch'
import { sourceSearchParams, refreshSourceSearch, scrollToSourceMatch } from '../lib/sourceSearch'
import type { EditorView } from '@milkdown/prose/view'
import type { EditorView as CMEditorView } from '@codemirror/view'
import type { LocalNode } from '../../../shared/types'
import { MilkdownEditor } from './MilkdownEditor'
import { SplitEditor } from './SplitEditor'

/** v0.0.6：统计树中 md 文档总数（递归） */
function countAllDocs(nodes: LocalNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.isDir ? (node.children ? countAllDocs(node.children) : 0) : 1),
    0
  )
}

/** 编辑器视图：双模式编辑（milkdown 可视化 / SV 源码模式）+ 工具栏 */
export function EditorPane(): React.JSX.Element {
  const currentPath = useEditorStore((s) => s.currentPath)
  const currentDir = useEditorStore((s) => s.currentDir)
  const setCurrentDir = useEditorStore((s) => s.setCurrentDir)
  const content = useEditorStore((s) => s.content)
  const dirty = useEditorStore((s) => s.dirty)
  const error = useEditorStore((s) => s.error)
  const update = useEditorStore((s) => s.update)
  const save = useEditorStore((s) => s.save)
  const createDraft = useEditorStore((s) => s.createDraft)
  const openDoc = useEditorStore((s) => s.open)
  const refreshLocal = useDocsStore((s) => s.refreshLocal)
  const localTree = useDocsStore((s) => s.localTree)
  const deleteLocal = useDocsStore((s) => s.deleteLocal)
  const docError = useDocsStore((s) => s.error)
  const clearDocError = useDocsStore((s) => s.clearError)
  const lastPull = useDocsStore((s) => s.lastPull)

  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  // v0.0.7：编辑模式——可视化（milkdown+工具栏）/ 源码模式 SV（源码+右栏整篇渲染）
  // v0.0.6：mode 提升到 editor store（顶栏「展开右栏」按钮需感知模式以判断预览 tab）
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const toc = useEditorStore((s) => s.toc)
  // v0.0.6：编辑器右栏（预览/目录/搜索）展开与 tab 由 ui store 管理（顶栏按钮切换，全局单份）
  const panelOpen = useUiStore((s) => s.panelOpen)
  const panelTab = useUiStore((s) => s.panelTab)
  const setPanelTab = useUiStore((s) => s.setPanelTab)
  // v0.0.7+：搜索词/正则/活动序号（与 SearchPanel 共享，驱动 WYSIWYG 装饰与源码高亮）
  const searchQuery = useUiStore((s) => s.searchQuery)
  const searchRegex = useUiStore((s) => s.searchRegex)
  const searchActive = useUiStore((s) => s.searchActive)
  // v0.0.7+：WYSIWYG 的 ProseMirror view 句柄（搜索装饰刷新/滚动用；切换模式即失效）
  const pmViewRef = useRef<EditorView | null>(null)
  // v0.0.7+：源码模式的 CodeMirror view 句柄（源码搜索高亮/滚动用；切换模式即失效）
  const cmViewRef = useRef<CMEditorView | null>(null)
  useEffect(() => {
    if (mode !== 'wysiwyg') pmViewRef.current = null
    if (mode !== 'split') cmViewRef.current = null
  }, [mode])

  // v0.0.7+：搜索词/正则变化 → 同步参数并刷新 WYSIWYG 装饰与源码高亮
  useEffect(() => {
    const active = useUiStore.getState().searchActive
    editorSearchParams.query = searchQuery
    editorSearchParams.regex = searchRegex
    editorSearchParams.active = active
    sourceSearchParams.query = searchQuery
    sourceSearchParams.regex = searchRegex
    sourceSearchParams.active = active
    if (mode === 'wysiwyg' && pmViewRef.current) refreshEditorSearch(pmViewRef.current)
    if (mode === 'split' && cmViewRef.current) refreshSourceSearch(cmViewRef.current)
  }, [searchQuery, searchRegex, mode])

  // v0.0.7+：活动序号变化 → 刷新高亮（滚动定位由 jumpToSearch 负责，避免输入时意外滚动）
  useEffect(() => {
    editorSearchParams.active = searchActive
    sourceSearchParams.active = searchActive
    if (mode === 'wysiwyg' && pmViewRef.current) refreshEditorSearch(pmViewRef.current)
    if (mode === 'split' && cmViewRef.current) refreshSourceSearch(cmViewRef.current)
  }, [searchActive, mode])
  // v0.0.6：新建文件夹输入框状态
  const [showNewDir, setShowNewDir] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  // v0.0.6：首页排序（编辑时间/字数 + 升降序，默认编辑时间降序）
  const [sortBy, setSortBy] = useState<'mtime' | 'words'>('mtime')
  const [sortAsc, setSortAsc] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // v0.0.6：待二次确认删除的本地文件 path（再点一次执行删除；点击其他处恢复）
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)


  const pullErrors = lastPull?.errors ?? []

  // v0.0.6：当前浏览目录的子树（根目录时直接用整棵树）
  const dirNode = currentDir ? findDirNode(localTree, currentDir) : null
  const items = currentDir ? (dirNode?.children ?? []) : localTree
  // v0.0.6：排序——文件夹始终在前（名称序），文件按编辑时间/字数排序（支持升降序）
  const sortedItems = useMemo<LocalNode[]>(() => {
    const dirs = items.filter((n) => n.isDir)
    const files = items.filter((n) => !n.isDir)
    const key = (n: LocalNode): number => (sortBy === 'words' ? n.words ?? 0 : n.mtime ?? 0)
    const sorted = [...files].sort((a, b) => {
      const diff = key(b) - key(a)
      return sortAsc ? -diff : diff
    })
    return [...dirs, ...sorted]
  }, [items, sortBy, sortAsc])

  // v0.0.7：全局 Ctrl/Cmd-S 保存（milkdown 内部无 keymap，两种模式统一由这里处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (currentPath && dirty) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentPath, dirty, save])

  function showToast(msg: string): void {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleDelete(node: LocalNode): Promise<void> {
    if (confirmDelete !== node.path) {
      // 第一次点击：进入二次确认态（3 秒后自动恢复）
      setConfirmDelete(node.path)
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(null), 3000)
      return
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
    setConfirmDelete(null)
    const ok = await deleteLocal(node.path)
    if (ok) showToast(`已删除「${node.name.replace(/\.md$/i, '')}」`)
  }

  async function handleCreateDraft(): Promise<void> {
    const title = newTitle.trim()
    if (!title) return
    // v0.0.6：在当前浏览目录内新建（dirNode.rel 相对存档根）
    const dirRel = currentDir ? (dirNode?.rel ?? '') : ''
    const path = await createDraft(title, dirRel)
    if (path) {
      setShowNew(false)
      setNewTitle('')
      showToast('已新建本地草稿')
      // 新文件已落盘：刷新本地目录树，让侧栏「本地存档」即时出现该草稿
      await refreshLocal()
    }
  }

  /** v0.0.6：新建文件夹（当前浏览目录下），成功后刷新树 */
  async function handleCreateDir(): Promise<void> {
    const name = newDirName.trim()
    if (!name) return
    const rel = currentDir ? `${currentDir.replace(/\\/g, '/')}/${name}` : name
    const res = await window.hqsf.createLocalDir(rel)
    if (res.ok) {
      setShowNewDir(false)
      setNewDirName('')
      showToast('已创建文件夹')
      await refreshLocal()
    } else {
      showToast(res.error || '创建文件夹失败')
    }
  }

  /** v0.0.6：按绝对路径在树中查找目录节点（找不到返回 null） */
  function findDirNode(nodes: LocalNode[], dir: string): LocalNode | null {
    for (const n of nodes) {
      if (!n.isDir) continue
      if (n.path === dir) return n
      if (n.children) {
        const found = findDirNode(n.children, dir)
        if (found) return found
      }
    }
    return null
  }

  /** v0.0.6：面包屑相对路径分段 → 绝对路径（按名称逐级在树中查找） */
  function relPathToAbs(nodes: LocalNode[], segs: string[]): string {
    let level = nodes
    let abs = ''
    for (const seg of segs) {
      const hit = level.find((n) => n.isDir && n.name === seg)
      if (!hit) return ''
      abs = hit.path
      level = hit.children ?? []
    }
    return abs
  }

  // v0.0.6：源码模式（SV）的整篇渲染 HTML（右栏「预览」tab；输入防抖后更新，代价可控）；
  // 音乐/视频标签（[music 163]/[video bilibili]…）展开为 iframe，与阅读视图一致
  const previewHtml = useMemo(() => expandMediaTags(renderMdPreview(content)), [content])

  /** v0.0.6：编辑器右栏目录跳转——按当前模式定位标题容器 */
  function jumpToEditorToc(idx: number): void {
    if (mode === 'split') {
      // 右栏同一时刻只渲染当前 tab：预览 tab 未激活时内容不在 DOM，先切过去再滚动
      setPanelTab('preview')
      setTimeout(() => {
        const scope = document.querySelector('.editor-pane .reader-panel .editor-preview-body')
        const el = scope?.querySelectorAll('h1,h2,h3,h4,h5,h6')[idx]
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 150)
      return
    }
    const scope = document.querySelector('.editor-pane .milkdown-theme-nord')
    const el = scope?.querySelectorAll('h1,h2,h3,h4,h5,h6')[idx]
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // v0.0.6：编辑器右栏 tabs——预览（仅源码模式）/ 目录（正文有标题时）/ 搜索（基础 tab）；
  // 单 tab 无 tab 栏、零 tab 不渲染（RightPanel 内置），顶栏按钮据此联动
  const applyExternalContent = useEditorStore((s) => s.applyExternalContent)
  /** v0.0.7+：编辑器搜索跳转——SV 模式滚动源码编辑器中的匹配（不再切预览）；
   *  WYSIWYG 刷新装饰并滚动活动匹配 */
  const jumpToSearch = (idx: number): void => {
    if (mode === 'split') {
      if (!cmViewRef.current) return
      sourceSearchParams.active = idx
      refreshSourceSearch(cmViewRef.current)
      scrollToSourceMatch(cmViewRef.current)
      return
    }
    if (!pmViewRef.current) return
    editorSearchParams.active = idx
    refreshEditorSearch(pmViewRef.current)
    scrollToActiveSearch(pmViewRef.current)
  }
  const editorTabs: Array<RightTab<'preview' | 'toc' | 'search'>> = [
    ...(mode === 'split'
      ? [
          {
            key: 'preview' as const,
            label: '预览',
            content: <EditorPreview html={previewHtml} />
          }
        ]
      : []),
    ...(toc.length > 0
      ? [
          {
            key: 'toc' as const,
            label: '目录',
            content: (
              <div className="reader-panel-scroll">
                <ul className="reader-toc-list">
                  {toc.map((t) => (
                    <li key={t.idx} className={`reader-toc-item lv-${Math.min(6, Math.max(1, t.level))}`}>
                      <a
                        href={`#etoc-${t.idx + 1}`}
                        onClick={(e) => {
                          e.preventDefault()
                          jumpToEditorToc(t.idx)
                        }}
                      >
                        {t.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )
          }
        ]
      : []),
    // v0.0.6+：搜索（基础 tab）——编辑器支持批量/逐个/正则替换
    {
      key: 'search' as const,
      label: '搜索',
      content: (
        <SearchPanel
          text={content}
          onJump={jumpToSearch}
          replaceable
          onReplace={applyExternalContent}
        />
      )
    }
  ]

  // v0.0.6+：写作首页右栏——搜索本地文档（标题+摘要），点击打开
  const homeItems = useMemo<Array<{ id: string; title: string; text?: string }>>(() => {
    const out: Array<{ id: string; title: string; text?: string }> = []
    const walk = (nodes: LocalNode[]): void => {
      for (const n of nodes) {
        if (n.isDir) {
          if (n.children) walk(n.children)
        } else {
          out.push({ id: n.path, title: n.name.replace(/\.md$/i, ''), text: n.summary })
        }
      }
    }
    walk(localTree)
    return out
  }, [localTree])
  const homeTabs: Array<RightTab<'search'>> = [
    {
      key: 'search',
      label: '搜索',
      content: <SearchPanel items={homeItems} onOpenItem={(path) => void openDoc(path)} />
    }
  ]

  return (
    <div className="editor-pane">
      {pullErrors.length > 0 && (
        <ErrorBanner title={`同步失败 ${pullErrors.length} 处`} details={pullErrors} />
      )}

      {showNew && (
        <div className="new-draft-bar">
          <input
            placeholder="新草稿标题"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreateDraft()
            }}
            autoFocus
          />
          <button className="toolbar-btn" onClick={() => void handleCreateDraft()} disabled={!newTitle.trim()}>
            创建
          </button>
        </div>
      )}

      {(error || docError) && (
        <ErrorBanner
          title="操作失败"
          message={error ?? docError ?? ''}
          onDismiss={() => {
            useEditorStore.setState({ error: null })
            clearDocError()
          }}
        />
      )}

      <div className={`editor-body${currentPath ? ' editing' : ' home'}`}>
        <div className="editor-main">
          {currentPath ? (
            mode === 'wysiwyg' ? (
              <MilkdownEditor
                docKey={currentPath}
                content={content}
                onChange={update}
                onViewReady={(view) => {
                  // 防陈旧实例：视图已脱离文档（卸载/StrictMode 重挂）则丢弃
                  if (view.dom.isConnected) pmViewRef.current = view
                }}
              />
            ) : (
              <SplitEditor
                docKey={currentPath}
                content={content}
                onChange={update}
                onViewReady={(view) => {
                  // 防陈旧实例：视图已脱离文档（卸载/StrictMode 重挂）则丢弃
                  if (view.dom.isConnected) cmViewRef.current = view
                }}
              />
            )
          ) : (
            /* v0.0.6：写作首页——本地存档目录导航 + 文章卡片 */
            <div className="editor-empty editor-local-home">
            <div className="editor-local-home-head">
              {/* v0.0.6：面包屑（原「本地存档」标题改为纯面包屑） */}
              <span className="editor-local-crumbs">
                <button
                  className={`crumb ${currentDir === '' ? 'current' : ''}`}
                  onClick={() => setCurrentDir('')}
                >
                  存档根
                </button>
                {(dirNode?.rel ?? '')
                  .split('/')
                  .filter(Boolean)
                  .map((seg, i, arr) => {
                    const targetAbs = relPathToAbs(localTree, arr.slice(0, i + 1))
                    return (
                      <span key={`${seg}-${i}`} className="crumb-seg">
                        <span className="crumb-sep">/</span>
                        <button
                          className={`crumb ${i === arr.length - 1 ? 'current' : ''}`}
                          onClick={() => targetAbs && setCurrentDir(targetAbs)}
                        >
                          {seg}
                        </button>
                      </span>
                    )
                  })}
              </span>
              {localTree.length > 0 && (
                <span className="editor-local-count">{countAllDocs(localTree)} 项</span>
              )}
              <div className="editor-local-actions">
                {/* v0.0.6：排序（编辑时间/字数 + 升降序），样式类似作品库列表工具栏 */}
                <div className="editor-local-sorts">
                  <button
                    className={`order-btn ${sortBy === 'mtime' ? 'active' : ''}`}
                    onClick={() => setSortBy('mtime')}
                  >
                    编辑时间
                  </button>
                  <button
                    className={`order-btn ${sortBy === 'words' ? 'active' : ''}`}
                    onClick={() => setSortBy('words')}
                  >
                    字数
                  </button>
                  <button
                    className={`order-btn order-dir-btn ${sortAsc ? 'asc' : ''}`}
                    onClick={() => setSortAsc((v) => !v)}
                    title={sortAsc ? '当前升序（小→大），点击切回降序' : '当前降序（大→小），点击切换为升序'}
                  >
                    {sortAsc ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  </button>
                </div>
                {/* v0.0.6：新建文件夹/新建草稿用图标表示（hover 提示） */}
                <button
                  className="ghost-btn editor-local-icon-btn"
                  onClick={() => setShowNewDir((v) => !v)}
                  title={showNewDir ? '取消新建文件夹' : '新建文件夹'}
                >
                  <FolderPlus size={15} />
                </button>
                <button
                  className="ghost-btn editor-local-icon-btn"
                  onClick={() => setShowNew(true)}
                  title="新建草稿"
                >
                  <FilePlus size={15} />
                </button>
              </div>
            </div>

            {/* v0.0.6：新建文件夹输入框 */}
            {showNewDir && (
              <div className="new-draft-bar">
                <input
                  value={newDirName}
                  placeholder="文件夹名称"
                  onChange={(e) => setNewDirName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateDir()
                  }}
                  autoFocus
                />
                <button className="toolbar-btn" onClick={() => void handleCreateDir()} disabled={!newDirName.trim()}>
                  创建
                </button>
                <button className="toolbar-btn" onClick={() => setShowNewDir(false)}>
                  取消
                </button>
              </div>
            )}

            {sortedItems.length === 0 ? (
              <p className="muted editor-local-hint">
                {currentDir ? '此文件夹为空。' : '本地存档为空。点「+ 新建草稿」开始写作，或从左侧栏同步远端草稿。'}
              </p>
            ) : (
              <div className="editor-local-cards">
                {sortedItems.map((node) =>
                  node.isDir ? (
                    <button
                      key={node.path}
                      className="editor-local-dir-entry"
                      onClick={() => {
                        setConfirmDelete(null)
                        setCurrentDir(node.path)
                      }}
                      title={node.path}
                    >
                      <Folder size={15} />
                      <span className="editor-local-dir-name">{node.name}</span>
                      <ChevronRight size={13} className="editor-local-dir-arrow" />
                    </button>
                  ) : (
                    <div key={node.path} className="article-card editor-local-card">
                      <button
                        className="article-card-main"
                        onClick={() => {
                          setConfirmDelete(null)
                          void openDoc(node.path)
                        }}
                        title={node.path}
                      >
                        <div className="article-card-body">
                          <div className="article-card-title">
                            <span className="article-card-title-text">{node.name.replace(/\.md$/i, '')}</span>
                          </div>
                          {/* v0.0.6：有摘要垂直居中；无摘要卡片中央提示无法提取 */}
                          <div className="article-card-excerpt editor-local-excerpt">
                            {node.summary ? (
                              <span className="excerpt-text">{node.summary}</span>
                            ) : (
                              <span className="excerpt-none">{`(´･ω･\`) 无法提取到摘要`}</span>
                            )}
                          </div>
                          <div className="article-card-meta">
                            <span className="article-card-stats">
                              {node.words != null && <span>{formatSize(node.words)} 字</span>}
                              {node.mtime != null && (
                                <span>最后编辑 {formatTs(Math.floor(node.mtime / 1000))}</span>
                              )}
                            </span>
                          </div>
                        </div>
                      </button>
                      <button
                        className={`editor-local-card-del${confirmDelete === node.path ? ' confirming' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDelete(node)
                        }}
                        title={confirmDelete === node.path ? '再次点击确认删除' : '删除这篇草稿'}
                      >
                        <Trash2 size={14} />
                        {confirmDelete === node.path && <span>确认删除？</span>}
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
          )}
        </div>
        {/* v0.0.6+：右栏（编辑态=预览/目录/搜索；写作首页=搜索本地文档） */}
        <RightPanel
          tabs={currentPath ? editorTabs : homeTabs}
          activeTab={panelTab}
          onTabChange={setPanelTab}
          open={panelOpen}
        />
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
