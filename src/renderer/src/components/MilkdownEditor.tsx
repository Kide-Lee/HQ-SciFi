import { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, parserCtx, editorViewCtx } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/prose/view'
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
import { mediaParsePlugin } from '../lib/mediaParse'
import { mathClickPlugin } from '../lib/mathClick'
import { mediaClickPlugin } from '../lib/mediaClick'
import { editorSearchPlugin } from '../lib/editorSearch'
import { useEditorStore } from '../stores/editor'
import { MathModal } from './MathModal'
import { MusicModal } from './MusicModal'
import { VideoModal } from './VideoModal'
import type { MediaTag } from '../lib/mediaNode'
import '@milkdown/theme-nord/style.css'
import 'katex/dist/katex.min.css'

interface MilkdownEditorProps {
  /** 文档标识：变化时用最新 content 重建编辑器（切换文档） */
  docKey: string
  /** 初始内容（仅创建时使用一次；之后编辑器为内容唯一来源，经 onChange 回流） */
  content: string
  /** markdown 内容变化回调（输入即触发，由上层落盘/同步） */
  onChange: (md: string) => void
  /** v0.0.7+：编辑器视图就绪回调（搜索高亮装饰刷新/滚动用） */
  onViewReady?: (view: EditorView) => void
}

/**
 * 可视化（WYSIWYG）编辑模式：milkdown v7（ProseMirror 内核），
 * 输入 Markdown 语法即时渲染为富文本。内容变化经 listener 同步为 md 字符串。
 */
export function MilkdownEditor({ docKey, content, onChange, onViewReady }: MilkdownEditorProps): React.JSX.Element {
  return (
    <MilkdownProvider>
      <Inner docKey={docKey} content={content} onChange={onChange} onViewReady={onViewReady} />
    </MilkdownProvider>
  )
}

function Inner({ docKey, content, onChange, onViewReady }: MilkdownEditorProps): React.JSX.Element {
  // 用 ref 持有最新值：编辑器仅在 docKey 变化时重建，输入期间 content 更新不触发重建（避免丢光标）
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onViewReadyRef = useRef(onViewReady)
  onViewReadyRef.current = onViewReady

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
        .use(mediaParsePlugin)
        .use(mediaClickPlugin)
        .use(history)
        .use(listener)
        // v0.0.7+：搜索高亮装饰（正文全部匹配 + 活动匹配/段落强调）
        .use(editorSearchPlugin),
    [docKey]
  )

  // v0.0.7+：实例就绪后把 EditorView 交给上层（搜索高亮装饰刷新/滚动）
  const [instLoading, getInstance] = useInstance()
  useEffect(() => {
    if (instLoading) return
    const editor = getInstance()
    if (!editor) return
    editor.action((ctx) => onViewReadyRef.current?.(ctx.get(editorViewCtx)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instLoading, getInstance])

  // v0.0.6+：搜索替换注入——订阅 externalContent（seq 变化）替换整个 doc；
  // 替换经 listener 回流 onChange → store.content 与编辑器保持一致并防抖落盘
  const externalContent = useEditorStore((s) => s.externalContent)
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

  // v0.0.8：媒体（音乐/视频）弹窗状态 + 确认处理（插入 / 重编辑 attrs / 删除）
  const mediaModal = useEditorStore((s) => s.mediaModal)
  const closeMediaModal = useEditorStore((s) => s.closeMediaModal)

  function handleMediaConfirm(payload: { tag: MediaTag; id: string } | null): void {
    if (instLoading) return
    const editor = getInstance()
    if (!editor) return
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      if (mediaModal.pos == null) {
        // 插入新媒体：独占一行（包裹为独立段落，与前后正文分离；清空残留 storedMarks）
        const nodeType = view.state.schema.nodes.mediaTag
        const paraType = view.state.schema.nodes.paragraph
        if (nodeType && payload) {
          const media = nodeType.create({ tag: payload.tag, id: payload.id })
          const tr = view.state.tr
          const $from = tr.selection.$from
          const parent = $from.parent
          if (parent.type.isTextblock && parent.childCount === 0) {
            // 空文本块：媒体直接放入（该块即独占行）
            tr.replaceSelectionWith(media).setStoredMarks([])
          } else if (parent.type.isTextblock && $from.parentOffset > 0 && $from.parentOffset < parent.content.size) {
            // 段中：拆分当前文本块，中间插入只含媒体的独立段落
            tr.split($from.pos)
            tr.insert($from.pos + 1, paraType.create(null, media))
          } else if (parent.type.isTextblock && $from.parentOffset === 0) {
            // 块首：在当前块之前插入独立段落
            tr.insert($from.before(), paraType.create(null, media))
          } else if (parent.type.isTextblock) {
            // 块尾：在当前块之后插入独立段落
            tr.insert($from.after(), paraType.create(null, media))
          } else {
            // 非文本块选区（如 NodeSelection）：替换为独立段落
            tr.replaceSelectionWith(paraType.create(null, media)).setStoredMarks([])
          }
          view.dispatch(tr)
        }
      } else if (payload) {
        // 重编辑：更新节点 attrs.tag/id，toDOM 重绘播放器（校验节点仍为 mediaTag，
        // 防弹窗期间文档被替换导致陈旧 pos 误操作）
        const pos = mediaModal.pos
        const node = view.state.doc.nodeAt(pos)
        if (node && node.type.name === 'mediaTag') {
          view.dispatch(
            view.state.tr
              .setNodeAttribute(pos, 'tag', payload.tag)
              .setNodeAttribute(pos, 'id', payload.id)
          )
        }
      } else {
        // 删除媒体节点：若其所在段落仅含该媒体（独占行），连同空段落删除并合并相邻文本块，
        // 恢复插入前的段落结构——否则留下空段落，markdown 序列化为 <br /> 残留；
        // 混排于正文中的节点只删节点本身
        const pos = mediaModal.pos
        const node = view.state.doc.nodeAt(pos)
        if (node && node.type.name === 'mediaTag') {
          const tr = view.state.tr
          const $pos = tr.doc.resolve(pos)
          const parent = $pos.parent
          if (parent.type.isTextblock && parent.childCount === 1 && parent.firstChild === node) {
            const from = $pos.before()
            const to = $pos.after()
            tr.delete(from, to)
            // 合并相邻同类文本块（不可合并时 join 为 no-op）
            try {
              tr.join(from)
            } catch {
              // 位置非法等情况保留两个段落
            }
            // 列表项清理：段落删除后所在列表项若只剩空段落/已无内容则逐级移除
            // （join 在列表内会抛 Inconsistent open depths；PM 会拒绝删除"唯一列表项"，
            //  此时改为删除整个列表；变化检测防结构性拒绝导致死循环）
            for (let guard = 0; guard < 5; guard++) {
              const docBefore = tr.doc
              let changed = false
              const $at = tr.doc.resolve(Math.min(from, tr.doc.content.size))
              for (let d = $at.depth; d > 0; d--) {
                const n = $at.node(d)
                const isEmptyLi =
                  n.type.name === 'listItem' &&
                  (n.content.size === 0 ||
                    (n.content.childCount === 1 &&
                      n.content.child(0).isTextblock &&
                      n.content.child(0).content.size === 0))
                if (isEmptyLi) {
                  const list = d > 1 ? $at.node(d - 1) : null
                  const listOnly =
                    !!list &&
                    (list.type.name === 'orderedList' || list.type.name === 'bulletList') &&
                    list.childCount === 1
                  const start = listOnly && list ? $at.before(d - 1) : $at.before(d)
                  const end = listOnly && list ? $at.after(d - 1) : $at.after(d)
                  tr.delete(start, end)
                  changed = !tr.doc.eq(docBefore)
                  break
                }
                if (
                  (n.type.name === 'orderedList' || n.type.name === 'bulletList') &&
                  n.content.size === 0
                ) {
                  tr.delete($at.before(d), $at.after(d))
                  changed = !tr.doc.eq(docBefore)
                  break
                }
              }
              if (!changed) break
            }
          } else {
            tr.delete(pos, pos + node.nodeSize)
          }
          view.dispatch(tr)
        }
      }
      view.focus()
    })
    closeMediaModal()
  }

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
      {/* v0.0.8：媒体插入/编辑弹窗——音乐与视频各自独立（由节点 tag 决定打开哪个） */}
      {mediaModal.tag.startsWith('music') ? (
        <MusicModal
          open={mediaModal.open}
          tag={mediaModal.tag as 'music 163' | 'music qq'}
          id={mediaModal.id}
          pos={mediaModal.pos}
          onClose={closeMediaModal}
          onConfirm={handleMediaConfirm}
        />
      ) : (
        <VideoModal
          open={mediaModal.open}
          id={mediaModal.id}
          pos={mediaModal.pos}
          onClose={closeMediaModal}
          onConfirm={handleMediaConfirm}
        />
      )}
    </div>
  )
}
