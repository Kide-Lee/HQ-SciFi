/**
 * v0.0.6+：搜索「跳转到第 index 个匹配」的 DOM 定位工具。
 * 原理：容器 textContent（文本节点按文档顺序拼接）与 SearchPanel 的全文匹配
 * 使用同一正则；跳转时把匹配起点 offset 映射回所在文本节点，滚动其块级父元素并临时高亮。
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
  const totalText = container.textContent ?? ''
  re.lastIndex = 0
  let m: RegExpExecArray | null
  let cur = 0
  while ((m = re.exec(totalText))) {
    if (cur === index) {
      const target = charNodeAt(container, m.index)
      const el = (target?.parentElement ?? container) as HTMLElement
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flash(el)
      return true
    }
    cur++
    if (m[0].length === 0) re.lastIndex++
  }
  return false
}
