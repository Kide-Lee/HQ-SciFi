import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { RegExpCursor } from '@codemirror/search'
import { escapeRegExp, wrapIndex, type SearchParams } from './searchText'
/**
 * v0.0.7+：源码模式（SV，CodeMirror 6）搜索高亮。
 * 与 SearchPanel 的匹配一致（同词/正则、忽略大小写）：全部匹配黄底、
 * 活动匹配橙底；跳转滚动源码本身（不再切到预览）。参数由 React 写入
 * sourceSearchParams，再派发带 refreshEffect 的事务触发重算；
 * 输入（docChanged）时随事务自动重算。
 * v0.0.8：排除零宽匹配——CM6 的 MarkDecoration.range 对空区间抛 RangeError，
 * `^`/`$`/`\b`/`a*` 等可空正则模式此前会令 split 编辑器崩溃。
 */

/** 当前搜索参数（模块级单例——React 写入，装饰字段在事务时读取） */
export const sourceSearchParams: SearchParams = { query: '', regex: false, active: 0 }

/** 外部触发装饰重算的事务 effect */
const refreshEffect = StateEffect.define<void>()

/** 构造 RegExpCursor 的模式（正则非法返回 null）；忽略大小写与 SearchPanel 一致 */
function patternOf(params: SearchParams): { pattern: string; ignoreCase: boolean } | null {
  if (!params.query) return null
  if (params.regex) {
    try {
      new RegExp(params.query)
    } catch {
      return null
    }
    return { pattern: params.query, ignoreCase: true }
  }
  return { pattern: escapeRegExp(params.query), ignoreCase: true }
}

/** 文档中全部匹配区间（文档顺序，与 SearchPanel 同序；排除零宽匹配） */
function rangesOf(state: EditorState): Array<{ from: number; to: number }> {
  const p = patternOf(sourceSearchParams)
  if (!p) return []
  const out: Array<{ from: number; to: number }> = []
  const cursor = new RegExpCursor(state.doc, p.pattern, { ignoreCase: p.ignoreCase })
  for (;;) {
    const it = cursor.next()
    if (it.done) break
    // 零宽匹配（^/$/\b 等）不产生可见高亮，且 CM 的 MarkDecoration 不允许空区间
    if (it.value.from < it.value.to) out.push({ from: it.value.from, to: it.value.to })
  }
  return out
}

/** 按当前参数计算全部匹配装饰（活动匹配加强调类） */
function computeMatches(state: EditorState): DecorationSet {
  const ranges = rangesOf(state)
  if (ranges.length === 0) return Decoration.none
  const act = wrapIndex(sourceSearchParams.active, ranges.length)
  const decos: Range<Decoration>[] = ranges.map((r, i) =>
    Decoration.mark({
      class: i === act ? 'search-highlight search-highlight-active' : 'search-highlight'
    }).range(r.from, r.to)
  )
  return Decoration.set(decos, true)
}

/** 源码搜索装饰字段（docChanged 或外部刷新时重算） */
export const sourceSearchField = StateField.define<DecorationSet>({
  create: (state) => computeMatches(state),
  update: (decos, tr) => {
    if (tr.docChanged || tr.effects.some((e) => e.is(refreshEffect))) return computeMatches(tr.state)
    return decos
  },
  provide: (f) => EditorView.decorations.from(f)
})

/** 派发空事务触发装饰重算（React 侧更新 sourceSearchParams 后调用） */
export function refreshSourceSearch(view: EditorView): void {
  view.dispatch({ effects: refreshEffect.of(undefined) })
}

/** 滚动到当前活动匹配（越界回绕；无匹配时不做任何事） */
export function scrollToSourceMatch(view: EditorView): void {
  const ranges = rangesOf(view.state)
  if (ranges.length === 0) return
  const act = wrapIndex(sourceSearchParams.active, ranges.length)
  view.dispatch({ effects: EditorView.scrollIntoView(ranges[act].from, { y: 'center' }) })
}
