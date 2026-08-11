import { useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { nord } from '@milkdown/theme-nord'
import '@milkdown/theme-nord/style.css'

interface MilkdownEditorProps {
  /** 文档标识：变化时用最新 content 重建编辑器（切换文档） */
  docKey: string
  /** 初始内容（仅创建时使用一次；之后编辑器为内容唯一来源，经 onChange 回流） */
  content: string
  /** markdown 内容变化回调（输入即触发，由上层落盘/同步） */
  onChange: (md: string) => void
}

/**
 * 所见即所得（WYSIWYG）编辑模式：milkdown v7（ProseMirror 内核），
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
        .use(history)
        .use(listener),
    [docKey]
  )

  return (
    <div className="milkdown-theme-nord prose md-editor-host">
      <Milkdown />
    </div>
  )
}
