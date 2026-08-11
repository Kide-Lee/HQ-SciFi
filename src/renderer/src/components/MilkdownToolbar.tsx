import type { ReactNode } from 'react'
import {
  Bold, Code, Code2, Heading1, Heading2, Heading3, Image, Italic, Link,
  List, ListOrdered, Minus, Quote, Redo2, RemoveFormatting, Undo2
} from 'lucide-react'
import { useInstance } from '@milkdown/react'
import {
  toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  toggleLinkCommand, wrapInHeadingCommand, wrapInBlockquoteCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, createCodeBlockCommand,
  insertHrCommand, insertImageCommand, turnIntoTextCommand
} from '@milkdown/kit/preset/commonmark'
import { editorViewCtx } from '@milkdown/kit/core'
import { undo, redo } from '@milkdown/kit/prose/history'

/**
 * 所见即所得模式的编辑工具栏（milkdown 命令驱动）。
 * 必须位于 MilkdownProvider 内（经 useInstance 获取编辑器实例）。
 */
export function MilkdownToolbar(): React.JSX.Element {
  const [loading, get] = useInstance()

  const run = (fn: () => void): void => {
    if (loading) return
    fn()
    // 命令执行后聚焦回编辑器（按钮点击会抢焦点）
    const editor = get()
    if (editor) {
      editor.action((ctx) => ctx.get(editorViewCtx).focus())
    }
  }

  const askLink = (): void => {
    const href = window.prompt('链接地址（https://…）')
    if (href) run(() => toggleLinkCommand.run({ href }))
  }

  const askImage = (): void => {
    const src = window.prompt('图片地址（https://…）')
    if (src) run(() => insertImageCommand.run({ src }))
  }

  interface Btn {
    title: string
    icon: ReactNode
    action: () => void
  }

  const groups: Btn[][] = [
    [
      { title: '粗体', icon: <Bold size={14} />, action: () => run(() => toggleStrongCommand.run()) },
      { title: '斜体', icon: <Italic size={14} />, action: () => run(() => toggleEmphasisCommand.run()) },
      { title: '行内代码', icon: <Code size={14} />, action: () => run(() => toggleInlineCodeCommand.run()) },
      { title: '链接', icon: <Link size={14} />, action: askLink },
      { title: '图片', icon: <Image size={14} />, action: askImage }
    ],
    [
      { title: '标题 1', icon: <Heading1 size={15} />, action: () => run(() => wrapInHeadingCommand.run(1)) },
      { title: '标题 2', icon: <Heading2 size={15} />, action: () => run(() => wrapInHeadingCommand.run(2)) },
      { title: '标题 3', icon: <Heading3 size={15} />, action: () => run(() => wrapInHeadingCommand.run(3)) }
    ],
    [
      { title: '引用', icon: <Quote size={14} />, action: () => run(() => wrapInBlockquoteCommand.run()) },
      { title: '无序列表', icon: <List size={14} />, action: () => run(() => wrapInBulletListCommand.run()) },
      { title: '有序列表', icon: <ListOrdered size={14} />, action: () => run(() => wrapInOrderedListCommand.run()) },
      { title: '代码块', icon: <Code2 size={14} />, action: () => run(() => createCodeBlockCommand.run()) },
      { title: '分割线', icon: <Minus size={14} />, action: () => run(() => insertHrCommand.run()) },
      { title: '清除格式', icon: <RemoveFormatting size={14} />, action: () => run(() => turnIntoTextCommand.run()) }
    ],
    [
      {
        title: '撤销',
        icon: <Undo2 size={14} />,
        action: () => run(() => get()?.action((ctx) => undo(ctx.get(editorViewCtx).state, ctx.get(editorViewCtx).dispatch)))
      },
      {
        title: '重做',
        icon: <Redo2 size={14} />,
        action: () => run(() => get()?.action((ctx) => redo(ctx.get(editorViewCtx).state, ctx.get(editorViewCtx).dispatch)))
      }
    ]
  ]

  return (
    <div className="md-toolbar">
      {groups.map((group, gi) => (
        <div className="md-toolbar-group" key={gi}>
          {group.map((b) => (
            <button key={b.title} className="md-toolbar-btn" title={b.title} disabled={loading} onClick={b.action}>
              {b.icon}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
