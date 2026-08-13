import { findMatches, wrapIndex } from './searchText'

/**
 * v0.0.6+：搜索「跳转到第 index 个匹配」的 DOM 定位工具。
 * 原理：容器 textContent（文本节点按文档顺序拼接）与 SearchPanel 的全文匹配
 * 使用同一正则；跳转时把匹配起点 offset 映射回所在文本节点，滚动其块级父元素并临时高亮。
 * v0.0.7+：增加正文「全部匹配高亮」工具——按字符偏移把匹配文本包裹为
 * <mark class="search-highlight">，并支持当前匹配（search-highlight-active）
 * 与所在段落（search-paragraph-active）的强调。
 * v0.0.8：活动/跳转定位改回「文本偏移」口径——跨内联元素边界的匹配会生成多个
 * <mark>（mark 数 ≠ 匹配数），按 mark 序号定位会与结果列表错位；mark 不改变
 * textContent，偏移映射仍精确。
 */

/** offset 落在哪个文本节点 */
function charNodeAt(root: Element, offset: number): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  let acc = 0
  while ((node = walker.nextNode())) {
    const len = (node.textContent ?? '').length
    if (acc + len > offset) return node as Text
    acc += len
  }
  return null
}

/** 文本偏移落在哪个已包裹的 <mark class="search-highlight">（无则 null） */
function markAtOffset(root: Element, offset: number): HTMLElement | null {
  const target = charNodeAt(root, offset)
  return target?.parentElement?.closest<HTMLElement>('.search-highlight') ?? null
}

/** 临时高亮（1.2s 后移除） */
function flash(el: HTMLElement): void {
  el.classList.add('search-jump-flash')
  setTimeout(() => el.classList.remove('search-jump-flash'), 1200)
}

/**
 * 在容器内定位第 index 个匹配并滚动高亮。
 * 返回是否定位成功。
 */
export function jumpToMatchIn(container: Element | null, re: RegExp | null, index: number): boolean {
  if (!container || !re) return false
  const offsets = findMatches(container.textContent ?? '', re).map((m) => m.start)
  const act = wrapIndex(index, offsets.length)
  if (offsets.length === 0) return false
  const target = charNodeAt(container, offsets[act])
  const el = (target?.parentElement ?? container) as HTMLElement
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flash(el)
  return true
}

/** v0.0.7+：移除容器内全部搜索高亮标记（还原为纯文本）与段落高亮类 */
export function clearSearchMarks(root: Element): void {
  for (const mark of Array.from(root.querySelectorAll('.search-highlight'))) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
  }
  root.querySelectorAll('.search-paragraph-active').forEach((el) => el.classList.remove('search-paragraph-active'))
}

/**
 * v0.0.7+：把容器 textContent 中全部正则匹配包裹为 <mark class="search-highlight">。
 * 文本节点按文档顺序切分（跨节点匹配逐段包裹），调用前应先 clearSearchMarks。
 */
export function wrapSearchMatches(root: Element, re: RegExp): void {
  // 先收集全部文本节点（后续替换不影响已收集的节点列表）
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) nodes.push(n as Text)

  const full = root.textContent ?? ''
  re.lastIndex = 0
  const spans: Array<{ start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(full))) {
    // 排除零宽匹配（^/$/\b 等无可包裹文本）
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    spans.push({ start: m.index, end: m.index + m[0].length })
  }
  if (spans.length === 0) return

  let nodeStart = 0
  for (const node of nodes) {
    const len = (node.textContent ?? '').length
    const nodeEnd = nodeStart + len
    const hits = spans.filter((s) => s.start < nodeEnd && s.end > nodeStart)
    if (hits.length > 0 && node.parentNode) {
      const text = node.textContent ?? ''
      const frag = document.createDocumentFragment()
      let cursor = 0 // 节点内偏移
      for (const h of hits) {
        const from = Math.max(h.start - nodeStart, 0)
        const to = Math.min(h.end - nodeStart, len)
        if (from > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, from)))
        if (to > from) {
          const mark = document.createElement('mark')
          mark.className = 'search-highlight'
          mark.textContent = text.slice(from, to)
          frag.appendChild(mark)
        }
        cursor = Math.max(cursor, to)
      }
      if (cursor < len) frag.appendChild(document.createTextNode(text.slice(cursor)))
      node.parentNode.replaceChild(frag, node)
    }
    nodeStart = nodeEnd
  }
}

/**
 * v0.0.8：设置当前（第 index 个，越界回绕）活动匹配——
 * 按 textContent 匹配偏移定位（mark 不改变 textContent，跨节点匹配也精确），
 * 标记加 search-highlight-active，其所在块级段落加 search-paragraph-active。
 */
export function setActiveSearchMark(root: Element, index: number, re: RegExp | null): void {
  root.querySelectorAll('.search-paragraph-active').forEach((el) => el.classList.remove('search-paragraph-active'))
  root.querySelectorAll('.search-highlight-active').forEach((el) => el.classList.remove('search-highlight-active'))
  const offsets = re ? findMatches(root.textContent ?? '', re).map((m) => m.start) : []
  if (offsets.length === 0) return
  const act = wrapIndex(index, offsets.length)
  const mark = markAtOffset(root, offsets[act])
  mark?.classList.add('search-highlight-active')
  const block = mark?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, pre, td')
  block?.classList.add('search-paragraph-active')
}

/**
 * v0.0.8：定位第 index 个匹配并滚动——按文本偏移找到对应 <mark>（与结果列表同序，
 * 跨节点匹配取起点所在 mark），无标记时回退到文本偏移映射。
 */
export function jumpToSearchMark(root: Element | null, index: number, re: RegExp | null): boolean {
  if (!root) return false
  const offsets = re ? findMatches(root.textContent ?? '', re).map((m) => m.start) : []
  if (offsets.length > 0) {
    const mark = markAtOffset(root, offsets[wrapIndex(index, offsets.length)])
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return true
    }
  }
  return jumpToMatchIn(root, re, index)
}
