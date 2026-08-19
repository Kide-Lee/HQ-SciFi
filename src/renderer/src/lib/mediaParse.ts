import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/prose/state'
import type { Node as PMNode, Schema } from '@milkdown/prose/model'
import { parseMediaId } from './sanitize'

/**
 * v0.0.8：解析阶段把正文中的媒体标签文本转换为 mediaTag 节点。
 *
 * 为什么不能走 schema 的 parseMarkdown：milkdown 的 parser 对每个 mdast 节点用
 * `Object.values(schema.nodes).find(spec => spec.parseMarkdown.match(node))` 找处理者，
 * commonmark 的 text 节点 match 恒真且注册在先，任何文本节点都会被 text 节点抢走，
 * mediaTag 按文本匹配的 parseMarkdown 永远不会被调用（2026-08-14 CDP 实测）。
 * 因此改在 ProseMirror 视图创建时（view 钩子，覆盖初始解析与每次重挂载）把
 * 含 `[music 163]…[/music 163]` 等标签的文本拆成 text + mediaTag 原子节点。
 */

const MEDIA_TEXT_RE = /\[(music 163|music qq|video bilibili)\]([\s\S]*?)\[\/(?:music 163|music qq|video bilibili)\]/g

/**
 * 递归转换：文本节点含媒体标签时拆成多个行内节点；块节点递归子节点并重建。
 * 返回 null 表示该子树无需变化。
 */
function transformInline(node: PMNode, schema: Schema): PMNode[] | null {
  if (node.isText) {
    const text = node.text ?? ''
    MEDIA_TEXT_RE.lastIndex = 0
    if (!MEDIA_TEXT_RE.test(text)) return null
    // 行内代码（inlineCode mark）内的媒体标签保持原文：转换会改写代码语义且保存后不可往返
    if (node.marks.some((m) => m.type.name === 'inlineCode')) return null
    MEDIA_TEXT_RE.lastIndex = 0
    const mediaType = schema.nodes.mediaTag
    const parts: PMNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = MEDIA_TEXT_RE.exec(text))) {
      const id = parseMediaId(m[1], m[2])
      // 无法解析的媒体标签保持原文，不拆成节点
      if (!id) continue
      if (m.index > last) parts.push(schema.text(text.slice(last, m.index), node.marks))
      // 媒体节点不带 marks：toMarkdown 输出的 html 节点不携带 marks，继承 marks 会在保存后丢格式
      parts.push(mediaType.create({ tag: m[1], id }))
      last = m.index + m[0].length
    }
    if (last < text.length) parts.push(schema.text(text.slice(last), node.marks))
    return parts
  }
  // 代码块（spec.code，如 code_block）：内容为纯文本，保持原文不做媒体转换
  if (node.type.spec.code) return null
  if (!node.content || node.content.size === 0) return null
  let changed = false
  const out: PMNode[] = []
  for (let i = 0; i < node.content.childCount; i++) {
    const child = node.content.child(i)
    const sub = transformInline(child, schema)
    if (sub) {
      changed = true
      out.push(...sub)
    } else {
      out.push(child)
    }
  }
  if (!changed) return null
  return [node.type.create(node.attrs, out, node.marks)]
}

/** 转换整个文档，返回新文档或 null（无变化） */
function transformDoc(doc: PMNode, schema: Schema): PMNode | null {
  if (!doc.content || doc.content.size === 0) return null
  let changed = false
  const out: PMNode[] = []
  for (let i = 0; i < doc.content.childCount; i++) {
    const child = doc.content.child(i)
    const sub = transformInline(child, schema)
    if (sub) {
      changed = true
      out.push(...sub)
    } else {
      out.push(child)
    }
  }
  if (!changed) return null
  return doc.type.create(doc.attrs, out, doc.marks)
}

/**
 * 视图创建后立即把媒体标签文本转成节点（幂等：转换后无剩余标签文本，不再触发）。
 * 转换事务不入历史（addToHistory:false）——避免打开文档后一次 Ctrl+Z 把标签退回纯文本
 * （view 钩子不会重跑，保存时方括号会被转义破坏标签）。
 * 不监听 appendTransaction：输入过程中的标签文本保持原样（插入请用工具栏媒体弹窗）。
 */
export const mediaParsePlugin = $prose(
  () =>
    new Plugin({
      view: (view) => {
        const tr = transformDoc(view.state.doc, view.state.schema)
        if (tr) {
          view.dispatch(
            view.state.tr
              .replaceWith(0, view.state.doc.content.size, tr.content)
              .setMeta('addToHistory', false)
          )
        }
        return {}
      }
    })
)
