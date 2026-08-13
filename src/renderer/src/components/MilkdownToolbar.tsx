import type { ReactNode } from 'react'
import {
  Bold, Code, Code2, Heading1, Heading2, Heading3, Image, Link,
  List, ListOrdered, Minus, Music, Quote, Redo2, RemoveFormatting, Sigma, Undo2, Video
} from 'lucide-react'
import { useInstance } from '@milkdown/react'
import {
  toggleStrongCommand, toggleInlineCodeCommand,
  toggleLinkCommand, wrapInHeadingCommand, wrapInBlockquoteCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, createCodeBlockCommand,
  insertHrCommand, insertImageCommand, turnIntoTextCommand
} from '@milkdown/kit/preset/commonmark'
import { editorViewCtx } from '@milkdown/kit/core'
import { undo, redo } from '@milkdown/kit/prose/history'
import { toggleKaitiCommand } from '../lib/kaitiMark'
import { insertMediaCommand, normalizeMediaInput } from '../lib/mediaNode'
import { useEditorStore } from '../stores/editor'

/**
 * 可视化模式的编辑工具栏（milkdown 命令驱动）。
 * 必须位于 MilkdownProvider 内（经 useInstance 获取编辑器实例）。
 * v0.0.6：取消斜体按钮 → 楷体按钮；新增插入媒体（图片上传 / 音乐 / 视频）。
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

  /** v0.0.6：插入图片——本地文件经主进程上传（upload/full）后插入地址 */
  const askImage = async (): Promise<void> => {
    const res = await window.hqsf.pickUploadImage()
    if (!res.ok) {
      if (res.error) window.alert(res.error)
      return
    }
    const url = res.data?.url
    if (!url) return // 用户取消选择
    run(() => insertImageCommand.run({ src: url }))  }

  /** v0.0.6：插入网易云音乐标签（荒启正文媒体语法，阅读端展开为 iframe） */
  const askMusic = (): void => {
    const input = window.prompt('插入网易云音乐\n请输入歌曲/歌单 ID（如 29764595）')
    const id = normalizeMediaInput('music 163', input ?? '')
    if (id) run(() => insertMediaCommand.run({ tag: 'music 163', id }))
  }

  /** v0.0.6：插入 B 站视频标签（荒启正文媒体语法，阅读端展开为 iframe） */
  const askVideo = (): void => {
    const input = window.prompt('插入 B 站视频\n请输入 BV 号（如 BV1xx411c7mD）')
    const id = normalizeMediaInput('video bilibili', input ?? '')
    if (id) run(() => insertMediaCommand.run({ tag: 'video bilibili', id }))
  }

  /** v0.0.6：插入公式——打开公式弹窗（插入模式，确认后由 MilkdownEditor 插入 math_block） */
  const askMath = (): void => {
    useEditorStore.getState().openMathModal('', null)
  }

  interface Btn {
    title: string
    icon: ReactNode
    action: () => void
  }

  const groups: Btn[][] = [
    [
      { title: '粗体', icon: <Bold size={14} />, action: () => run(() => toggleStrongCommand.run()) },
      // v0.0.6：取消斜体按钮，以楷体替代；按钮为「文」字（黑体字库渲染，双关文本/文章语义）
      { title: '楷体', icon: <span className="btn-glyph">文</span>, action: () => run(() => toggleKaitiCommand.run()) },
      { title: '行内代码', icon: <Code size={14} />, action: () => run(() => toggleInlineCodeCommand.run()) },
      { title: '链接', icon: <Link size={14} />, action: askLink }
    ],
    [
      { title: '标题 1', icon: <Heading1 size={14} />, action: () => run(() => wrapInHeadingCommand.run(1)) },
      { title: '标题 2', icon: <Heading2 size={14} />, action: () => run(() => wrapInHeadingCommand.run(2)) },
      { title: '标题 3', icon: <Heading3 size={14} />, action: () => run(() => wrapInHeadingCommand.run(3)) }
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
      // v0.0.6：插入媒体——图片/音乐/视频/公式归为一组（荒启标签语法；公式走 KaTeX）
      { title: '插入图片', icon: <Image size={14} />, action: () => void askImage() },
      { title: '插入音乐', icon: <Music size={14} />, action: askMusic },
      { title: '插入视频', icon: <Video size={14} />, action: askVideo },
      { title: '公式', icon: <Sigma size={14} />, action: askMath }
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
    <>
      {groups.map((group, gi) => (
        <div className="md-toolbar-group" key={gi}>
          {group.map((b) => (
            <button key={b.title} className="md-toolbar-btn" title={b.title} disabled={loading} onClick={b.action}>
              {b.icon}
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
