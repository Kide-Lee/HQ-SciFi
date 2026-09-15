/**
 * v1.1.12：右键菜单用的「当前选区」快照。
 * 必须在 contextmenu 触发时立即取好——点击菜单项会让浏览器选区失效。
 */
export interface SelectionSnapshot {
  /** 纯文本（保留段落换行） */
  text: string
}

/**
 * 读取当前选区；选区为空、或不在给定容器内（例如右栏面板里的操作）时返回 null。
 * @param container 只认这个容器内的选区（评论卡片/正文/消息气泡各管各的）
 */
export function readSelection(container: HTMLElement | null): SelectionSnapshot | null {
  if (!container) return null
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null

  const text = sel.toString().replace(/\u00a0/g, ' ').trim()
  if (!text) return null
  return { text }
}

/** 引用到评审/回复时的单行引用格式（评审与评论字段按纯文本渲染，多行会被折叠，故压成一行） */
export function toQuoteLine(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return `「${one.length > max ? `${one.slice(0, max)}…` : one}」`
}
