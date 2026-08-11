import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { renderMdPreview } from '../lib/mdPreview'

interface SplitEditorProps {
  /** 文档标识：变化时用最新 content 重建（切换文档） */
  docKey: string
  /** 初始内容（仅创建时使用一次；之后源码编辑为内容唯一来源，经 onChange 回流） */
  content: string
  /** markdown 内容变化回调 */
  onChange: (md: string) => void
}

/**
 * 即时预览编辑模式：左栏 CodeMirror 6 源码编辑 + 右栏 markdown-it 实时渲染。
 * 每处输入即更新预览（md → HTML），与阅读排版共用样式类。
 */
export function SplitEditor({ docKey, content, onChange }: SplitEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [preview, setPreview] = useState(() => renderMdPreview(content))

  // 切文档时重建编辑器实例
  useEffect(() => {
    if (!containerRef.current) return
    // 重建后同步预览为最新文档内容
    setPreview(renderMdPreview(contentRef.current))
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          basicSetup,
          markdown(),
          // Mod-s 保存由 EditorPane 全局监听处理，这里拦截浏览器默认行为即可
          keymap.of([{ key: 'Mod-s', run: () => true }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const md = u.state.doc.toString()
              onChangeRef.current(md)
              setPreview(renderMdPreview(md))
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px' },
            '.cm-scroller': {
              fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
              lineHeight: '1.7'
            }
          })
        ]
      }),
      parent: containerRef.current
    })
    return () => {
      view.destroy()
    }
  }, [docKey])

  return (
    <div className="split-editor">
      <div className="split-editor-source">
        <div className="cm-host" ref={containerRef} />
      </div>
      <div className="split-editor-preview reader-body" dangerouslySetInnerHTML={{ __html: preview }} />
    </div>
  )
}
