/**
 * v0.0.6+：搜索匹配工具（SearchPanel 与各视图跳转共用同一套正则逻辑）。
 */

/** 搜索参数（SearchPanel 与编辑器装饰共用：词/正则开关/活动序号） */
export interface SearchParams {
  query: string
  regex: boolean
  /** 活动匹配序号（0-based，越界回绕） */
  active: number
}

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

/**
 * 文本全文匹配（防零宽死循环；排除零宽匹配——`^`/`$`/`\b`/`a*` 等可空模式
 * 不产生可见高亮，若计入会导致面板计数与高亮数量不一致）。
 */
export function findMatches(text: string, re: RegExp): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0].length > 0) out.push({ start: m.index, end: m.index + m[0].length })
    else re.lastIndex++
  }
  return out
}

/** 匹配前后截取上下文（结果列表预览） */
export function contextOf(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 14)
  const to = Math.min(text.length, end + 22)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`
}

/** 序号取模回绕（上一处/下一处越界时循环；total 为 0 时返回 0） */
export function wrapIndex(i: number, total: number): number {
  return total === 0 ? 0 : ((i % total) + total) % total
}
