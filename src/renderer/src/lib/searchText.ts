/**
 * v0.0.6+：搜索匹配工具（SearchPanel 与各视图跳转共用同一套正则逻辑）。
 */

/** 转义正则特殊字符（普通查找用） */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 构建查找正则（regex 开关；非法正则返回 null） */
export function buildRegex(query: string, regex: boolean): RegExp | null {
  if (!query) return null
  try {
    return new RegExp(regex ? query : escapeRegExp(query), 'gi')
  } catch {
    return null
  }
}

/** 文本全文匹配（防零宽死循环） */
export function findMatches(text: string, re: RegExp): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length })
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

/** 匹配前后截取上下文（结果列表预览） */
export function contextOf(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 14)
  const to = Math.min(text.length, end + 22)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`
}
