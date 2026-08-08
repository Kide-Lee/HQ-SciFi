import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { useEditorStore } from '../stores/editor'
import { useDocsStore } from '../stores/docs'
import { ErrorBanner } from './ErrorBanner'
import type { ArticleRow } from '../../../shared/types'

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
  const close = useEditorStore((s) => s.close)
  const push = useDocsStore((s) => s.push)
  const pushing = useDocsStore((s) => s.pushing)
  const refreshLocal = useDocsStore((s) => s.refreshLocal)
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

      <div className="editor-body">
        {currentPath ? (
          <div className="cm-host" ref={containerRef} />
        ) : (
          <div className="editor-empty">
            <p>从左侧选择一篇本地草稿，或新建一篇开始写作</p>
            <button className="primary-btn" onClick={() => setShowNew(true)}>
              + 新建草稿
            </button>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {currentPath && (
        <div className="editor-close" onClick={() => close()} title="关闭当前文档">
          ✕ 关闭
        </div>
      )}
    </div>
  )
}
