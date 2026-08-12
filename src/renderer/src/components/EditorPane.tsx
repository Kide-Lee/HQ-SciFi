import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Eye, FilePlus, Folder, FolderPlus, PenLine, Trash2, X } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { useDocsStore } from '../stores/docs'
import { useUiStore } from '../stores/ui'
import { ErrorBanner } from './ErrorBanner'
import { formatSize, formatTs, expandMediaTags } from '../lib/sanitize'
import { renderMdPreview } from '../lib/mdPreview'
import { RightPanel, type RightTab } from './RightPanel'
import type { ArticleRow, LocalNode } from '../../../shared/types'
import { MilkdownEditor } from './MilkdownEditor'
import { SplitEditor } from './SplitEditor'

/** 远端非草稿类型的展示名（同步/推送后角标显示当前远端状态） */
const REMOTE_TYPE_LABEL: Partial<Record<ArticleRow['type'], string>> = {
  waiting: '待审核',
  post: '已发布',
  reject: '已拒绝'
}

/** v0.0.6：统计树中 md 文档总数（递归） */
function countAllDocs(nodes: LocalNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.isDir ? (node.children ? countAllDocs(node.children) : 0) : 1),
    0
  )
}

/** v0.0.6：字数统计——不计空格与标点符号（按 Unicode 码点） */
function countWords(text: string): number {
  return [...text.replace(/[\s\p{P}\p{S}]/gu, '')].length
}

/** 编辑器视图：双模式编辑（milkdown 所见即所得 / SV 分屏预览）+ 属性栏（类型/标签/活动/公开/违禁检测）+ 工具栏 */
export function EditorPane(): React.JSX.Element {
  const currentPath = useEditorStore((s) => s.currentPath)
  const currentDir = useEditorStore((s) => s.currentDir)
  const setCurrentDir = useEditorStore((s) => s.setCurrentDir)
  const content = useEditorStore((s) => s.content)
  const meta = useEditorStore((s) => s.meta)
  const setMeta = useEditorStore((s) => s.setMeta)
  const dirty = useEditorStore((s) => s.dirty)
  const synced = useEditorStore((s) => s.synced)
  const busy = useEditorStore((s) => s.busy)
  const error = useEditorStore((s) => s.error)
  const update = useEditorStore((s) => s.update)
  const save = useEditorStore((s) => s.save)
  const createDraft = useEditorStore((s) => s.createDraft)
  const openDoc = useEditorStore((s) => s.open)
  const close = useEditorStore((s) => s.close)
  const push = useDocsStore((s) => s.push)
  const pushing = useDocsStore((s) => s.pushing)
  const refreshLocal = useDocsStore((s) => s.refreshLocal)
  const localTree = useDocsStore((s) => s.localTree)
  const deleteLocal = useDocsStore((s) => s.deleteLocal)
  const docError = useDocsStore((s) => s.error)
  const clearDocError = useDocsStore((s) => s.clearError)
  const lastPull = useDocsStore((s) => s.lastPull)
  const articles = useDocsStore((s) => s.articles)

  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  // v0.0.7：编辑模式——所见即所得（milkdown+工具栏）/ 分屏预览 SV（源码+右栏整篇渲染）
  // v0.0.6：mode 提升到 editor store（顶栏「展开右栏」按钮需感知模式以判断预览 tab）
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const toc = useEditorStore((s) => s.toc)
  // v0.0.6：编辑器右栏（预览/目录）展开与 tab 由 ui store 管理（顶栏按钮切换）
  const editorPanelOpen = useUiStore((s) => s.editorPanelOpen)
  const editorPanelTab = useUiStore((s) => s.editorPanelTab)
  const setEditorPanelTab = useUiStore((s) => s.setEditorPanelTab)
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

  // v0.0.7：文章元数据属性栏——类型/标签/活动/公开 + 违禁词检测
  const [cats, setCats] = useState<Array<{ mid: string; name: string }>>([])
  const [tags, setTags] = useState<Array<{ mid: string; name: string }>>([])
  const [acts, setActs] = useState<Array<{ mid: string; name: string }>>([])
  const [forbidMsg, setForbidMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // v0.0.6：标签多选下拉面板展开态
  const [tagOpen, setTagOpen] = useState(false)

  // 编辑态加载 metas（类型/标签/活动）；失败静默（属性栏置空，同步/发布仍可用类型必选校验拦截）
  useEffect(() => {
    if (!currentPath) return
    void window.hqsf.listMetas('category').then((r) => {
      if (r.ok) setCats(r.data.map((m) => ({ mid: String(m.mid), name: m.name })))
    })
    void window.hqsf.listMetas('tag').then((r) => {
      if (r.ok) setTags(r.data.map((m) => ({ mid: String(m.mid), name: m.name })))
    })
    void window.hqsf.listMetas('active').then((r) => {
      if (r.ok) setActs(r.data.map((m) => ({ mid: String(m.mid), name: m.name })))
    })
    setForbidMsg(null)
  }, [currentPath])

  /** 违禁词检测：官方接口（hqContents/userTextBlockStatus，付费 5 能量币/次），先确认再检测 */
  async function handleCheckForbidden(): Promise<void> {
    if (!window.confirm('违禁词检测将消耗 5 能量币，是否继续？')) return
    const fileName = (currentPath ?? '').split('/').pop()?.replace(/\.md$/i, '') ?? ''
    setForbidMsg(null)
    const res = await window.hqsf.checkForbidden(fileName, content)
    if (!res.ok) {
      setForbidMsg({ ok: false, text: res.error || '检测失败' })
      return
    }
    const msg = res.data.msg || '检测完成'
    setForbidMsg({ ok: msg.includes('无违规'), text: msg })
  }

  /** 标签 toggle（meta.tags 数组） */
  function toggleTag(name: string): void {
    const cur = meta.tags ?? []
    setMeta({ tags: cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name] })
  }

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

  async function handlePush(isDraft: boolean): Promise<void> {
    if (!currentPath) return
    await save() // 先落盘，确保上传的是最新内容
    const res = await push(currentPath, isDraft)
    if (!res) {
      showToast('操作失败')
      return
    }
    if (res.ok) {
      showToast(isDraft ? '已同步到草稿' : '已提交发布')
    } else {
      showToast(res.error ?? '操作失败')
    }
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

  // 当前文件在索引中的记录：展示对应远端状态（草稿/待审核/已发布/已拒绝）
  // 服务端允许这些状态的文章编辑后再存草稿或发布，故按钮不禁用
  const currentRow = currentPath ? articles.find((a) => a.filePath === currentPath) : undefined
  const remoteTypeLabel = currentRow?.cid ? REMOTE_TYPE_LABEL[currentRow.type] : undefined
  const statusTip = remoteTypeLabel
    ? `对应远端状态「${remoteTypeLabel}」；可编辑后存为草稿，或发布进入待审核`
    : undefined
  const statusLabel = dirty
    ? remoteTypeLabel
      ? `未保存（${remoteTypeLabel}）`
      : '未保存'
    : synced
      ? (remoteTypeLabel ?? '已同步')
      : '本地草稿'
  const pushingNow = pushing === currentPath
  // v0.0.6：编辑栏字数统计（不计空格标点），不足 3000 / 超过 33000 提醒
  const wordCount = countWords(content)
  const wordTip = wordCount < 3000 ? '字数不足' : wordCount > 33000 ? '字数太多' : null

  // v0.0.6：分屏预览的整篇渲染 HTML（右栏「预览」tab；输入防抖后更新，代价可控）；
  // 音乐/视频标签（[music 163]/[video bilibili]…）展开为 iframe，与阅读视图一致
  const previewHtml = useMemo(() => expandMediaTags(renderMdPreview(content)), [content])

  /** v0.0.6：编辑器右栏目录跳转——按当前模式定位标题容器 */
  function jumpToEditorToc(idx: number): void {
    if (mode === 'split') {
      // 右栏同一时刻只渲染当前 tab：预览 tab 未激活时内容不在 DOM，先切过去再滚动
      setEditorPanelTab('preview')
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

  // v0.0.6：编辑器右栏 tabs——预览（仅分屏预览模式）/ 目录（正文有标题时）；
  // 单 tab 无 tab 栏、零 tab 不渲染（RightPanel 内置），顶栏按钮据此联动
  const editorTabs: Array<RightTab<'preview' | 'toc'>> = [
    ...(mode === 'split'
      ? [
          {
            key: 'preview' as const,
            label: '预览',
            content: (
              <div className="reader-panel-scroll">
                <div
                  className="reader-body editor-preview-body"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            )
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
      : [])
  ]

  return (
    <div className="editor-pane">
      {/* v0.0.6：编辑栏（v0.0.6 样式改进：两行——功能按钮 + 模式切换 / 元数据 + 字数），仅编辑态显示 */}
      {currentPath && (
        <div className="editor-bar">
          <div className="editor-bar-row">
            <button className="toolbar-btn" onClick={() => setShowNew((v) => !v)}>
              + 新建草稿
            </button>
            <button className="toolbar-btn" onClick={() => void save()} disabled={!dirty || busy}>
              保存
            </button>
            <button
              className="toolbar-btn accent"
              onClick={() => void handlePush(true)}
              disabled={!meta.category || pushingNow || busy}
              title={meta.category ? '将当前内容保存为远端草稿' : '请先选择文章类型'}
            >
              {pushingNow ? '同步中 …' : '同步到草稿'}
            </button>
            <button
              className="toolbar-btn primary"
              onClick={() => void handlePush(false)}
              disabled={!meta.category || pushingNow || busy}
              title={meta.category ? '发布后进入待审核，由服务器裁决为已发布或已拒绝' : '请先选择文章类型'}
            >
              发布
            </button>
            <button
              className="toolbar-btn"
              onClick={() => void handleCheckForbidden()}
              title="按本地禁词表检查标题与正文（发布时服务端仍会独立检测）"
            >
              违禁词检测
            </button>
            {forbidMsg && (
              <span className={`forbid-result ${forbidMsg.ok ? 'ok' : 'bad'}`}>{forbidMsg.text}</span>
            )}
            <span className="toolbar-spacer" />
            <span className={`status-badge ${dirty ? 'warn' : synced ? 'ok' : ''}`} title={statusTip}>
              {statusLabel}
            </span>
            {/* v0.0.6：模式切换按钮去文字只留图标，放编辑栏右面（关闭按钮左边） */}
            <div className="editor-mode-switch">
              <button
                className={`mode-btn${mode === 'wysiwyg' ? ' active' : ''}`}
                onClick={() => setMode('wysiwyg')}
                title="所见即所得：输入 Markdown 语法即时渲染为富文本（带编辑工具栏）"
              >
                <PenLine size={15} />
              </button>
              <button
                className={`mode-btn${mode === 'split' ? ' active' : ''}`}
                onClick={() => setMode('split')}
                title="分屏预览（SV）：左侧源码编辑，右侧整篇实时渲染"
              >
                <Eye size={15} />
              </button>
            </div>
            {/* v0.0.6：.editor-close 取消，沿用 .topbar-back-btn 样式 */}
            <button className="topbar-back-btn editor-close-btn" onClick={() => void close()} title="关闭当前文档">
              <X size={14} /> 关闭
            </button>
          </div>
          {/* v0.0.6：第二行——类型/活动/公开/标签 + 字数统计 */}
          <div className="editor-bar-row editor-bar-meta">
            <label className="meta-field">
              <span className="meta-label">类型</span>
              <select
                value={meta.category ?? ''}
                onChange={(e) => setMeta({ category: e.target.value || undefined })}
                className={!meta.category ? 'unset' : ''}
              >
                <option value="">选择类型…</option>
                {cats.map((c) => (
                  <option key={c.mid} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="meta-field meta-tags-field">
              <span className="meta-label">标签</span>
              <div className="meta-tags-select">
                <div
                  className={`meta-tags-trigger${tagOpen ? ' open' : ''}`}
                  onClick={() => setTagOpen((v) => !v)}
                  title="点击选择标签（多选）；已选标签可点击移除"
                >
                  {(meta.tags ?? []).length === 0 ? (
                    <span className="muted">选择标签…</span>
                  ) : (
                    (meta.tags ?? []).map((n) => (
                      <span
                        key={n}
                        className="meta-tag-chip"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleTag(n)
                        }}
                        title={`移除「${n}」`}
                      >
                        {n} ×
                      </span>
                    ))
                  )}
                </div>
                {tagOpen && (
                  <div className="meta-tags-menu">
                    {tags.length === 0 && <span className="muted">（加载中/无标签）</span>}
                    {tags.map((t) => (
                      <label key={t.mid} className="meta-tags-option">
                        <input
                          type="checkbox"
                          checked={(meta.tags ?? []).includes(t.name)}
                          onChange={() => toggleTag(t.name)}
                        />
                        {t.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <label className="meta-field">
              <span className="meta-label">活动</span>
              <select
                value={meta.active ?? ''}
                onChange={(e) => setMeta({ active: e.target.value || undefined })}
              >
                <option value="">不参加</option>
                {acts.map((a) => (
                  <option key={a.mid} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="meta-field meta-check">
              <input
                type="checkbox"
                checked={meta.isopen !== false}
                onChange={(e) => setMeta({ isopen: e.target.checked })}
              />
              <span>公开阅读</span>
            </label>
            <span className="toolbar-spacer" />
            {/* v0.0.6：字数（不计空格标点）；不足 3000 提醒「字数不足」，超过 33000 提醒「字数太多」 */}
            <span className={`editor-words${wordTip ? ' warn' : ''}`} title={wordTip ?? '正文字数（不计空格与标点）'}>
              {wordCount} 字
              {wordTip && <span className="editor-words-tip">{wordTip}</span>}
            </span>
          </div>
        </div>
      )}

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
        {currentPath ? (
          <>
            <div className="editor-main">
              {mode === 'wysiwyg' ? (
                <MilkdownEditor docKey={currentPath} content={content} onChange={update} />
              ) : (
                <SplitEditor docKey={currentPath} content={content} onChange={update} />
              )}
            </div>
            {/* v0.0.6：编辑器右栏（预览/目录，与文章页共用 RightPanel 与规则） */}
            <RightPanel
              tabs={editorTabs}
              activeTab={editorPanelTab}
              onTabChange={setEditorPanelTab}
              open={editorPanelOpen}
            />
          </>
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
