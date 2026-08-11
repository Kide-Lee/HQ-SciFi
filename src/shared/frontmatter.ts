/**
 * 文章头部元数据（YAML frontmatter）：类型/标签/活动/是否公开。
 * 存于 md 文件首部 `---` 块内（人类可读的名称，提交时由主进程映射为 mid）；
 * 三端（主进程/preload/渲染层）共用。
 *
 * 示例：
 * ```
 * ---
 * category: 原创作品
 * tags:
 *   - 科幻
 *   - 悬疑
 * active: 荒启科幻练笔第二十四期
 * isopen: true
 * ---
 * ```
 */

export interface ArticleMeta {
  /** 文章类型（category 名称，如「原创作品」） */
  category?: string
  /** 标签（tag 名称列表） */
  tags?: string[]
  /** 参加的活动（active 名称；缺省 = 不参加） */
  active?: string
  /** 是否公开阅读（缺省 true，与荒启默认一致） */
  isopen?: boolean
}

const FM_START = '---'
const FM_END = '---'

/** 解析 md 全文 → { meta, body }；无 frontmatter 时 meta 为空对象、body 原样返回 */
export function parseFrontmatter(md: string): { meta: ArticleMeta; body: string } {
  const lines = md.split('\n')
  if (lines.length === 0 || lines[0].trim() !== FM_START) {
    return { meta: {}, body: md }
  }
  const raw: Record<string, string | string[] | boolean> = {}
  let listKey: string | null = null
  let i = 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === FM_END) break
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // 列表项（缩进的 - 或 键: 后的 - 行）归入当前列表键
    if (listKey && /^-\s+/.test(t)) {
      const arr = (raw[listKey] as string[]) || []
      arr.push(unquote(t.replace(/^-\s+/, '')))
      raw[listKey] = arr
      continue
    }
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(t)
    if (!m) continue
    const key = m[1]
    const val = m[2].trim()
    if (val === '') {
      raw[key] = []
      listKey = key
    } else if (val.startsWith('[') && val.endsWith(']')) {
      raw[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
      listKey = null
    } else {
      raw[key] = unquote(val)
      listKey = null
    }
  }
  // i 停在 FM_END 行：body 从其后一行开始（跳过多余空行）
  let body = lines.slice(i + 1).join('\n')
  body = body.replace(/^\n+/, '')

  const meta: ArticleMeta = {}
  if (typeof raw.category === 'string' && raw.category) meta.category = raw.category
  if (Array.isArray(raw.tags) && raw.tags.length) meta.tags = raw.tags as string[]
  if (typeof raw.active === 'string' && raw.active) meta.active = raw.active
  if (typeof raw.isopen === 'boolean') meta.isopen = raw.isopen
  else if (raw.isopen === 'true') meta.isopen = true
  else if (raw.isopen === 'false') meta.isopen = false
  return { meta, body }
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '')
}

/** 依据 meta 生成 frontmatter 块 + 正文（不含末尾空行处理，调用方负责） */
export function withFrontmatter(meta: ArticleMeta, body: string): string {
  const lines = [FM_START]
  if (meta.category) lines.push(`category: ${meta.category}`)
  if (meta.tags && meta.tags.length > 0) {
    lines.push('tags:')
    for (const t of meta.tags) lines.push(`  - ${t}`)
  }
  if (meta.active) lines.push(`active: ${meta.active}`)
  if (meta.isopen !== undefined) lines.push(`isopen: ${meta.isopen}`)
  lines.push(FM_END, '')
  return lines.join('\n') + (body || '')
}

/** 剥离 frontmatter，仅返回正文 */
export function stripFrontmatter(md: string): string {
  return parseFrontmatter(md).body
}
