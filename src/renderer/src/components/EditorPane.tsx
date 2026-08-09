import { useEffect, useRef, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { useEditorStore } from '../stores/editor'
import { useDocsStore } from '../stores/docs'
import { ErrorBanner } from './ErrorBanner'
import { formatSize, formatTs } from '../lib/sanitize'
import type { ArticleRow, LocalNode } from '../../../shared/types'

/** 远端非草稿类型的展示名（同步/推送后角标显示当前远端状态） */
const REMOTE_TYPE_LABEL: Partial<Record<ArticleRow['type'], string>> = {
  waiting: '待审核',
  post: '已发布',
  reject: '已拒绝'
}

/** 编辑器视图：CodeMirror 6 编辑本地 md + 工具栏（同步到草稿/发布/保存） */
export function EditorPane(): React.JSX.Element {
  const currentPath = useEditorStore((s) => s.currentPath)
  const content = useEditorStore((s) => s.content)
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

  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  contentRef.current = content

  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  // v0.0.6：待二次确认删除的本地文件 path（再点一次执行删除；点击其他处恢复）
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pullErrors = lastPull?.errors ?? []

  // 切换文档时重建编辑器实例
  useEffect(() => {
    if (!containerRef.current || !currentPath) return
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          basicSetup,
          markdown(),
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void save()
                return true
              }
            }
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) update(u.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace', lineHeight: '1.7' }
          })
        ]
      }),
      parent: containerRef.current
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath])

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
    const path = await createDraft(title)
    if (path) {
      setShowNew(false)
      setNewTitle('')
      showToast('已新建本地草稿')
      // 新文件已落盘：刷新本地目录树，让侧栏「本地存档」即时出现该草稿
      await refreshLocal()
    }
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

  return (
    <div className="editor-pane">
      {/* v0.0.6：工具栏仅在编辑态显示；写作首页不显示（新建草稿入口在首页头部） */}
      {currentPath && (
        <div className="editor-toolbar">
          <button className="toolbar-btn" onClick={() => setShowNew((v) => !v)}>
            + 新建草稿
          </button>
          {currentPath && (
            <>
              <button className="toolbar-btn" onClick={() => void save()} disabled={!dirty || busy}>
                保存
              </button>
              <button className="toolbar-btn accent" onClick={() => void handlePush(true)} disabled={!currentPath || pushingNow || busy} title="将当前内容保存为远端草稿">
                {pushingNow ? '同步中 …' : '同步到草稿'}
              </button>
              <button className="toolbar-btn primary" onClick={() => void handlePush(false)} disabled={!currentPath || pushingNow || busy} title="发布后进入待审核，由服务器裁决为已发布或已拒绝">
                发布
              </button>
            </>
          )}
          {currentPath && (
            <span className={`status-badge ${dirty ? 'warn' : synced ? 'ok' : ''}`} title={statusTip}>
              {statusLabel}
            </span>
          )}
          <span className="toolbar-spacer" />
          <span className="editor-path" title={currentPath ?? ''}>
            {currentPath ? currentPath.split('/').pop() : ''}
          </span>
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
          <div className="cm-host" ref={containerRef} />
        ) : (
          /* v0.0.6：写作首页——本地存档以文章卡片展示（标题/摘要/字数/最后编辑时间/删除） */
          <div className="editor-empty editor-local-home">
            <div className="editor-local-home-head">
              <h3>本地存档</h3>
              {localTree.length > 0 && <span className="editor-local-count">{localTree.length} 项</span>}
              <button className="primary-btn" onClick={() => setShowNew(true)}>
                + 新建草稿
              </button>
            </div>
            {localTree.length === 0 ? (
              <p className="muted editor-local-hint">
                本地存档为空。点「+ 新建草稿」开始写作，或从左侧栏同步远端草稿。
              </p>
            ) : (
              <div className="editor-local-cards">
                {localTree.map((node) =>
                  node.isDir ? (
                    <div key={node.path} className="editor-local-dir">
                      {node.name}/
                    </div>
                  ) : (
                    <div key={node.path} className="editor-local-card">
                      <button
                        className="editor-local-card-main"
                        onClick={() => {
                          setConfirmDelete(null)
                          void openDoc(node.path)
                        }}
                        title={node.path}
                      >
                        <div className="editor-local-card-title">{node.name.replace(/\.md$/i, '')}</div>
                        {node.summary ? <div className="editor-local-card-summary">{node.summary}</div> : null}
                        <div className="editor-local-card-meta">
                          {node.words != null && <span>{formatSize(node.words)} 字</span>}
                          {node.mtime != null && <span>最后编辑 {formatTs(Math.floor(node.mtime / 1000))}</span>}
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
      {currentPath && (
        <div className="editor-close" onClick={() => close()} title="关闭当前文档">
          <X size={12} /> 关闭
        </div>
      )}
    </div>
  )
}
