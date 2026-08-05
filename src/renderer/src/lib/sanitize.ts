/**
 * 远端 HTML 净化（design.md 安全章节：外部内容按降级渲染处理，防 XSS）。
 * 荒启正文是 Quill HTML（含 <p>/<h1-h6>/<blockquote>/<ul>/<li>/<img>/<a> 等），
 * 白名单标签 + 白名单属性 + 剥除事件属性与 javascript: 协议。
 */

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY',
  'TR', 'TH', 'TD', 'IMG', 'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE',
  'SUB', 'SUP', 'HR', 'CITE', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION',
  'VIDEO', 'SOURCE' // iframe/script/style/object/embed 一律移除（见 walk）
])

/** 标签 → 允许属性（src/href 另做协议校验）；未列出的标签不保留任何属性 */
const ALLOWED_ATTR: Record<string, Set<string>> = {
  IMG: new Set(['src', 'alt', 'title', 'width', 'height']),
  A: new Set(['href', 'title', 'target', 'rel']),
  VIDEO: new Set(['src', 'controls', 'poster']),
  SOURCE: new Set(['src', 'type']),
  IFRAME: new Set(['src', 'width', 'height', 'frameborder', 'allowfullscreen']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan', 'scope']),
  TABLE: new Set(['border', 'cellpadding', 'cellspacing', 'width']),
  OL: new Set(['start']),
  LI: new Set(['value'])
}

function isSafeUrl(raw: string): boolean {
  // 先剔除 ASCII 控制字符（tab/换行/回车/NUL 等），防止 javascript:\t 之类绕过协议校验
  const url = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase()
  if (!url) return false
  // 允许 http(s) 与相对路径/站内资源（CDN 图片为 https://cdn.huangqisf.com/…）
  if (url.startsWith('http://') || url.startsWith('https://')) return true
  if (url.startsWith('/')) return true
  if (url.startsWith('./') || url.startsWith('../')) return true
  if (/^[a-z0-9-]+:/i.test(url) && !url.startsWith('http')) return false // 拦截 javascript:/data: 等
  return true
}

/**
 * 净化 HTML 字符串，返回安全 HTML。
 * 不可信的 iframe/video 保留占位但剥除交互（iframe 直接移除，video 保留 controls 但 src 经协议校验）。
 */
export function sanitizeHtml(raw: string): string {
  if (!raw) return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(raw, 'text/html')
  } catch {
    return ''
  }

  const walk = (node: Node): void => {
    const children = Array.from(node.childNodes)
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement
        const tag = el.tagName.toUpperCase()
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') {
          // iframe 是远端视频占位，直接移除（不做嵌入）；其余危险标签移除
          el.remove()
          continue
        }
        if (!ALLOWED_TAGS.has(tag)) {
          // 未知标签：降级为保留其文本内容
          el.replaceWith(document.createTextNode(el.textContent ?? ''))
          continue
        }
        // 属性白名单：默认拒绝，仅 ALLOWED_ATTR 列出者保留（同时剥除 on* 事件属性）
        const attrs = ALLOWED_ATTR[tag]
        const kept: string[] = []
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase()
          if (name.startsWith('on')) continue // 事件属性一律剥除
          if (!attrs || !attrs.has(attr.name)) continue // 未列出的标签/属性不保留
          if (name === 'src' || name === 'href') {
            if (!isSafeUrl(attr.value)) continue
            if (tag === 'A') {
              el.setAttribute('target', '_blank')
              el.setAttribute('rel', 'noopener noreferrer')
            }
          }
          kept.push(attr.name)
        }
        for (const attr of Array.from(el.attributes)) {
          if (!kept.includes(attr.name)) el.removeAttribute(attr.name)
        }
        walk(el)
      } else if (child.nodeType === Node.TEXT_NODE) {
        // 文本节点保持原样
      }
    }
  }

  const body = doc.body
  walk(body)
  return body.innerHTML
}

/** HTML → 纯文本（统计字数/摘要用）；用 DOMParser 解析避免 innerHTML 触发 img onerror 等 */
export function htmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/** 秒级时间戳 → 本地日期串（YYYY-MM-DD HH:mm） */
export function formatTs(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 字数格式化：12345 → 1.2 万 */
export function formatSize(n: number): string {
  if (!n) return ''
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return String(n)
}
