import { useEffect, useRef } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { sourceSearchField } from '../lib/sourceSearch'

interface SplitEditorProps {
  /** 文档标识：变化时用最新 content 重建（切换文档） */
  docKey: string
  /** 初始内容（仅创建时使用一次；之后源码编辑为内容唯一来源，经 onChange 回流） */
  content: string
  /** markdown 内容变化回调 */
  onChange: (md: string) => void
  /** v0.0.7+：编辑器视图就绪回调（源码搜索高亮刷新/滚动用） */
  onViewReady?: (view: EditorView) => void
}

/**
 * 源码（SV）编辑模式：左栏 CodeMirror 6 源码编辑。
 * v0.0.6：整篇预览移至编辑器右栏「预览」tab（右栏与文章页共用，见 EditorPane）。
 * v0.0.7：搜索高亮装饰（全部匹配 + 活动匹配）内置——SV 模式搜索匹配源码本身。
 */
export function SplitEditor({ docKey, content, onChange, onViewReady }: SplitEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onViewReadyRef = useRef(onViewReady)
  onViewReadyRef.current = onViewReady

  // 切文档时重建编辑器实例
  useEffect(() => {
    if (!containerRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          basicSetup,
          markdown(),
          // v0.0.7+：源码模式自动换行（长行折行显示，不改变文件内容）
          EditorView.lineWrapping,
          // v0.0.7+：搜索高亮装饰（docChanged 自动重算，查询词/活动序号变化经 refresh 事务触发）
          sourceSearchField,
          // Mod-s 保存由 EditorPane 全局监听处理，这里拦截浏览器默认行为即可
          keymap.of([{ key: 'Mod-s', run: () => true }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              onChangeRef.current(u.state.doc.toString())
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
    onViewReadyRef.current?.(view)
    return () => {
      view.destroy()
    }
  }, [docKey])

  return (
    <div className="split-editor">
      {/* v0.0.6：源码模式无编辑栏（保存用 Ctrl/Cmd-S，同步/发布需切回可视化模式） */}
      <div className="cm-host" ref={containerRef} />
    </div>
  )
}
