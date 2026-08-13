import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view'
import type { Node as ProseMirrorNode } from '@milkdown/prose/model'
import { buildRegex, wrapIndex } from './searchText'

/**
 * v0.0.7+：WYSIWYG（milkdown/ProseMirror）搜索高亮装饰插件。
 * milkdown 的 DOM 归 ProseMirror 管理，不能像文章页那样直接包裹文本节点，
 * 因此用装饰（Decoration）实现：只影响渲染，不进文档、不影响 md 序列化。
 * 搜索参数由 React 写入 editorSearchParams，再派发空事务（meta）触发重算；
 * 文档变化（输入/替换）时插件随事务自动重算。
 */

export interface EditorSearchParams {
  query: string
  regex: boolean
  /** 活动匹配序号（0-based，越界回绕） */
  active: number
}

/** 当前搜索参数（模块级单例——React 写入，插件在事务时读取） */
export const editorSearchParams: EditorSearchParams = { query: '', regex: false, active: 0 }

/** 外部触发装饰重算的事务 meta 键 */
const REFRESH_META = 'hqsf-editor-search-refresh'

const editorSearchPluginKey = new PluginKey<DecorationSet>('hqsf-editor-search')

/** 文本偏移 → 文档位置（匹配起点所在文本段） */
function docPosOf(segs: Array<{ from: number; text: string }>, offset: number, docSize: number): number {
  let acc = 0
  for (const seg of segs) {
    if (offset < acc + seg.text.length) return seg.from + (offset - acc)
    acc += seg.text.length
  }
  return Math.max(0, docSize - 1)
}

/** 按当前参数计算全部匹配装饰（活动匹配 + 所在段落强调） */
function computeDecorations(doc: ProseMirrorNode, params: EditorSearchParams): DecorationSet {
  if (!params.query) return DecorationSet.empty
  const re = buildRegex(params.query, params.regex)
  if (!re) return DecorationSet.empty

  // 收集文本段（文档顺序，拼接结果与 textContent 一致）
  const segs: Array<{ from: number; text: string }> = []
  doc.descendants((node, pos) => {
    if (node.isText) segs.push({ from: pos, text: node.text ?? '' })
    return true
  })
  const full = segs.map((s) => s.text).join('')
  const matches: Array<{ start: number; end: number }> = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(full))) {
    matches.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) re.lastIndex++
  }
  if (matches.length === 0) return DecorationSet.empty

  const decos: Decoration[] = []
  const act = wrapIndex(params.active, matches.length)
  // 逐文本段切分：跨段匹配拆分为段内装饰（inline 装饰不能跨块级节点）
  let segStart = 0
  for (const seg of segs) {
    const segEnd = segStart + seg.text.length
    for (let i = 0; i < matches.length; i++) {
      const mm = matches[i]
      const from = Math.max(mm.start, segStart)
      const to = Math.min(mm.end, segEnd)
      if (to <= from) continue
      const cls = i === act ? 'search-highlight search-highlight-active' : 'search-highlight'
      decos.push(Decoration.inline(seg.from + (from - segStart), seg.from + (to - segStart), { class: cls }))
    }
    segStart = segEnd
  }
  // 活动匹配所在块级段落高亮（节点装饰；零宽匹配无可见标记，跳过）
  const am = matches[act]
  if (am.end > am.start) {
    const $pos = doc.resolve(docPosOf(segs, am.start, doc.content.size))
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).isTextblock) {
        decos.push(Decoration.node($pos.before(d), $pos.after(d), { class: 'search-paragraph-active' }))
        break
      }
    }
  }
  return DecorationSet.create(doc, decos)
}

export const editorSearchPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: editorSearchPluginKey,
      state: {
        init: (_config, instance) => computeDecorations(instance.doc, editorSearchParams),
        apply: (tr, old, _oldState, newState) => {
          // 文档变化（输入/替换）或外部显式刷新（查询词/活动序号变化）时重算
          if (tr.docChanged || tr.getMeta(REFRESH_META)) return computeDecorations(newState.doc, editorSearchParams)
          return old
        }
      },
      props: {
        decorations(state) {
          return editorSearchPluginKey.getState(state) ?? DecorationSet.empty
        }
      }
    })
)

/** 派发空事务触发装饰重算（React 侧更新 editorSearchParams 后调用） */
export function refreshEditorSearch(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(REFRESH_META, true))
}

/** 滚动到当前活动匹配（装饰渲染为 .search-highlight-active 元素） */
export function scrollToActiveSearch(view: EditorView): void {
  const el = view.dom.querySelector<HTMLElement>('.search-highlight-active')
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
