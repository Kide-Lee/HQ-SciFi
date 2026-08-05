import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { useEditorStore } from '../stores/editor'
import { useDocsStore } from '../stores/docs'

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
  const docError = useDocsStore((s) => s.error)
  const clearDocError = useDocsStore((s) => s.clearError)
  const lastPull = useDocsStore((s) => s.lastPull)

  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  contentRef.current = content

  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
    }
  }

  async function copyErrors(): Promise<void> {
    await window.hqsf.copyText(pullErrors.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const statusLabel = dirty ? '未保存' : synced ? '已同步' : '本地草稿'
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
            <button className="toolbar-btn accent" onClick={() => void handlePush(true)} disabled={!currentPath || pushingNow || busy}>
              {pushingNow ? '同步中 …' : '同步到草稿'}
            </button>
            <button className="toolbar-btn primary" onClick={() => void handlePush(false)} disabled={!currentPath || pushingNow || busy}>
              发布
            </button>
          </>
        )}
        {currentPath && (
          <span className={`status-badge ${dirty ? 'warn' : synced ? 'ok' : ''}`}>{statusLabel}</span>
        )}
        <span className="toolbar-spacer" />
        <span className="editor-path" title={currentPath ?? ''}>
          {currentPath ? currentPath.split('/').pop() : ''}
        </span>
      </div>

      {pullErrors.length > 0 && (
        <div className="sync-error-banner">
          <div className="sync-error-head">
            <span className="sync-error-title">同步失败 {pullErrors.length} 处</span>
            <button className="copy-btn" onClick={() => void copyErrors()}>
              {copied ? '已复制 ✓' : '复制报错'}
            </button>
          </div>
          {pullErrors.map((e, i) => (
            <div key={i} className="sync-error-line">
              {e}
            </div>
          ))}
          <div className="sync-error-hint">
            提示：若持续「文章暂未公开访问 / 该文章不存在」，多为登录态过期 —— 请点侧栏「退出」后重新登录再试
          </div>
        </div>
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
        <div className="editor-error">
          {error ?? docError}
          <button className="dismiss" onClick={() => {
            useEditorStore.setState({ error: null })
            clearDocError()
          }}>
            ✕
          </button>
        </div>
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
