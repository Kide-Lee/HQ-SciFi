import { useEffect, useRef } from 'react'
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from '@codemirror/view'
import { EditorState, StateField } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { renderMdPreview } from '../lib/mdPreview'

interface IrEditorProps {
  /** 文档标识：变化时用最新 content 重建（切换文档） */
  docKey: string
  /** 初始内容（仅创建时使用一次；之后源码编辑为内容唯一来源） */
  content: string
  /** markdown 内容变化回调 */
  onChange: (md: string) => void
}

/** 光标所在块（标题单行 / 列表连续组 / 段落按空行分界）的渲染 widget */
class IrPreviewWidget extends WidgetType {
  constructor(readonly html: string) {
    super()
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = 'ir-block-preview reader-body'
    div.innerHTML = this.html
    return div
  }

  ignoreEvent(): boolean {
    return true
  }

  eq(other: IrPreviewWidget): boolean {
    return other.html === this.html
  }
}

interface BlockRange {
  /** widget 插入位置（块尾） */
  pos: number
  html: string
}

/** 解析光标所在块：标题单行；列表项取连续列表组；普通段落以空行为界 */
function currentBlock(doc: { lineAt(pos: number): { from: number; to: number; text: string; number: number }; line(n: number): { from: number; to: number; text: string; number: number }; lines: number; toString(): string }, pos: number): BlockRange | null {
  if (doc.lines === 0) return null
  const isList = (t: string): boolean => /^\s*([-*+]|\d+[.)])\s/.test(t)
  const cur = doc.lineAt(pos)
  const isHeading = /^#{1,6}\s/.test(cur.text)
  let start = cur.number
  let end = cur.number
  if (isHeading) {
    // 标题块仅当前行
  } else if (isList(cur.text)) {
    while (start > 1 && isList(doc.line(start - 1).text)) start--
    while (end < doc.lines && isList(doc.line(end + 1).text)) end++
  } else {
    while (start > 1 && doc.line(start - 1).text.trim() !== '') start--
    while (end < doc.lines && doc.line(end + 1).text.trim() !== '') end++
  }
  const from = doc.line(start).from
  const to = doc.line(end).to
  const text = doc.toString().slice(from, to).trim()
  if (!text) return null
  return { pos: to, html: renderMdPreview(text) }
}

/** 即时预览装饰：块尾插入当前块的渲染结果 */
const irPreviewField = StateField.define<DecorationSet>({
  create(state): DecorationSet {
    // 初始化即计算首块，打开文档即可见光标块渲染
    const block = currentBlock(state.doc, state.selection.main.head)
    return block
      ? Decoration.set([Decoration.widget({ widget: new IrPreviewWidget(block.html), block: true }).range(block.pos)])
      : Decoration.none
  },
  update(value, tr): DecorationSet {
    if (!tr.docChanged && !tr.selection) return value
    const block = currentBlock(tr.state.doc, tr.state.selection.main.head)
    const set = block
      ? Decoration.set([
          Decoration.widget({ widget: new IrPreviewWidget(block.html), block: true }).range(block.pos)
        ])
      : Decoration.none
    return set
  },
  provide: (f) => EditorView.decorations.from(f)
})

/**
 * 即时预览（IR）编辑模式：Typora 式即时渲染——
 * 全宽 Markdown 源码编辑（CodeMirror，语法高亮），
 * 光标所在块（段落/标题/列表组）下方实时渲染其效果，输入即更新。
 */
export function InstantRenderEditor({ docKey, content, onChange }: IrEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          basicSetup,
          markdown(),
          irPreviewField,
          // Mod-s 保存由 EditorPane 全局监听处理，这里拦截浏览器默认行为即可
          keymap.of([{ key: 'Mod-s', run: () => true }]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
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
    <div className="ir-editor">
      <div className="cm-host" ref={containerRef} />
    </div>
  )
}
