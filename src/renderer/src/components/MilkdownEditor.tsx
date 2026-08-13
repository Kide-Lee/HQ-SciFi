import { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, parserCtx, editorViewCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { math } from '@milkdown/plugin-math'
import { nord } from '@milkdown/theme-nord'
import { MilkdownToolbar } from './MilkdownToolbar'
import { EditorBar } from './EditorBar'
import { kaitiSchema, toggleKaitiCommand } from '../lib/kaitiMark'
import { mediaNode, insertMediaCommand } from '../lib/mediaNode'
import { mathClickPlugin } from '../lib/mathClick'
import { useEditorStore } from '../stores/editor'
import { MathModal } from './MathModal'
import '@milkdown/theme-nord/style.css'
import 'katex/dist/katex.min.css'

interface MilkdownEditorProps {
  /** 文档标识：变化时用最新 content 重建编辑器（切换文档） */
  docKey: string
  /** 初始内容（仅创建时使用一次；之后编辑器为内容唯一来源，经 onChange 回流） */
  content: string
  /** markdown 内容变化回调（输入即触发，由上层落盘/同步） */
  onChange: (md: string) => void
}

/**
 * 可视化（WYSIWYG）编辑模式：milkdown v7（ProseMirror 内核），
 * 输入 Markdown 语法即时渲染为富文本。内容变化经 listener 同步为 md 字符串。
 */
export function MilkdownEditor({ docKey, content, onChange }: MilkdownEditorProps): React.JSX.Element {
  return (
    <MilkdownProvider>
      <Inner docKey={docKey} content={content} onChange={onChange} />
    </MilkdownProvider>
  )
}

function Inner({ docKey, content, onChange }: MilkdownEditorProps): React.JSX.Element {
  // 用 ref 持有最新值：编辑器仅在 docKey 变化时重建，输入期间 content 更新不触发重建（避免丢光标）
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEditor(
    (container) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container)
          ctx.set(defaultValueCtx, contentRef.current)
          // 用户输入 → 同步 md 到上层 store（dirty + 防抖落盘由 store 处理）
          ctx.get(listenerCtx).markdownUpdated((_, md) => onChangeRef.current(md))
        })
        .config(nord)
        .use(commonmark)
        .use(gfm)
        .use(math)
        .use(mathClickPlugin)
        .use(kaitiSchema)
        .use(toggleKaitiCommand)
        .use(mediaNode)
        .use(insertMediaCommand)
        .use(history)
        .use(listener),
    [docKey]
  )

  // v0.0.6+：搜索替换注入——订阅 externalContent（seq 变化）替换整个 doc；
  // 替换经 listener 回流 onChange → store.content 与编辑器保持一致并防抖落盘
  const externalContent = useEditorStore((s) => s.externalContent)
  const [instLoading, getInstance] = useInstance()
  useEffect(() => {
    const ext = externalContent
    if (!ext || instLoading) return
    const editor = getInstance()
    if (!editor) return
    editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx)
      const parser = ctx.get(parserCtx)
      const doc = parser(ext.md)
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content))
      view.focus()
    })
    // 仅 seq 变化触发；替换完成后 content 经 onChange 回流，不再重复注入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalContent?.seq])

  // v0.0.6：公式弹窗状态 + 确认处理（插入 math_block / 重编辑 setNodeAttribute）
  const mathModal = useEditorStore((s) => s.mathModal)
  const closeMathModal = useEditorStore((s) => s.closeMathModal)

  function handleMathConfirm(latex: string): void {
    if (instLoading) return
    const editor = getInstance()
    if (!editor) return
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      if (mathModal.pos == null) {
        // 插入新公式（块级 math_block）
        const nodeType = view.state.schema.nodes.math_block
        if (nodeType) view.dispatch(view.state.tr.replaceSelectionWith(nodeType.create({ value: latex })))
      } else if (latex) {
        // 重编辑：更新节点 attrs.value，toDOM 重绘 KaTeX
        view.dispatch(view.state.tr.setNodeAttribute(mathModal.pos, 'value', latex))
      } else {
        // v0.0.7：清空编辑区确定 = 删除公式——块公式替换为空段落（留空行），行内公式直接删除
        const pos = mathModal.pos
        const node = view.state.doc.nodeAt(pos)
        if (node) {
          if (node.type.name === 'math_block') {
            const paragraph = view.state.schema.nodes.paragraph
            if (paragraph) view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, paragraph.create()))
          } else {
            view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize))
          }
        }
      }
      view.focus()
    })
    closeMathModal()
  }

  return (
    <div className="md-editor-wrap">
      {/* v0.0.6：编辑栏并入编辑器内部——第一行（保存/同步/发布/违禁 + 格式按钮组 + 字数 + 模式切换） */}
      <EditorBar formatSlot={<MilkdownToolbar />} />
      <div className="milkdown-theme-nord prose md-editor-host">
        <Milkdown />
      </div>
      {/* v0.0.6：公式编辑弹窗（插入/重编辑；v0.0.7 起清空编辑区确定 = 删除） */}
      <MathModal
        open={mathModal.open}
        value={mathModal.value}
        editable={mathModal.pos != null}
        onClose={closeMathModal}
        onConfirm={handleMathConfirm}
      />
    </div>
  )
}
