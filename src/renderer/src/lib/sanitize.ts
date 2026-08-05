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

/** 标签 → 允许属性（src/href/srcset 另做协议校验）；未列出的标签不保留任何属性 */
const ALLOWED_ATTR: Record<string, Set<string>> = {
  IMG: new Set(['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading']),
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

/** data: 内嵌图最大字节数（base64 解码后），防超大字符串塞爆 DOM */
const MAX_DATA_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * data:image 内嵌图是否放行（仅用于 src，禁止 href）。
 * 只允许常见位图（png/jpeg/gif/webp/avif/bmp）；svg+xml 可能含脚本，一律拒绝。
 */
/**
 * data:image 内嵌图是否放行（仅用于 src，禁止 href）。
 * 只允许常见位图（png/jpeg/gif/webp/avif/bmp）；svg+xml 可能含脚本，一律拒绝。
 * 注意：base64 内容区分大小写，本函数必须接收未做 toLowerCase 的原始值。
 */
function isSafeDataImage(raw: string): boolean {
  const m = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,([a-z0-9+/=\s]+)$/i.exec(raw)
  if (!m) return false
  try {
    // 渲染层无 Buffer：用 atob 解码统计字节数（Latin1 每字符 1 字节）
    const b64 = m[2].replace(/\s/g, '')
    const decoded = atob(b64)
    return decoded.length <= MAX_DATA_IMAGE_BYTES
  } catch {
    return false
  }
}

function isSafeUrl(raw: string): boolean {
  // 先剔除 ASCII 控制字符（tab/换行/回车/NUL 等），防止 javascript:\t 之类绕过协议校验。
  // 注意：不能 toLowerCase 整串 —— data: 内嵌图的 base64 内容区分大小写。
  const url = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!url) return false
  // data:image 内嵌图（仅位图；svg 拒绝）
  if (/^data:/i.test(url)) return isSafeDataImage(url)
  // 允许 http(s) 与相对路径/站内资源（CDN 图片为 https://cdn.huangqisf.com/…）
  if (/^https?:\/\//i.test(url)) return true
  if (url.startsWith('/')) return true
  if (url.startsWith('./') || url.startsWith('../')) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false // 拦截 javascript: 等其它协议
  return true
}

/** srcset 校验：逗号分隔的候选列表，逐项校验 URL（形如 "https://… 1x, https://… 2x"） */
function sanitizeSrcset(raw: string): string | null {
  const parts: string[] = []
  for (const cand of raw.split(',')) {
    const piece = cand.trim()
    if (!piece) continue
    const urlPart = piece.split(/\s+/)[0]
    if (!urlPart || !isSafeUrl(urlPart)) return null
    parts.push(piece)
  }
  return parts.length > 0 ? parts.join(', ') : null
}

/** 渲染层调用：把远端图片 URL 转成 hqsf-img:// 协议 URL（走主进程磁盘缓存；非 http(s) 原样返回） */
export function cachedImageUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url
  return `hqsf-img://fetch?url=${encodeURIComponent(url)}`
}

/**
 * 净化 HTML 字符串，返回安全 HTML。
 * 不可信的 iframe/video 保留占位但剥除交互（iframe 直接移除，video 保留 controls 但 src 经协议校验）。
 * 正文里的 http(s) 图片 src 会自动改写为 hqsf-img://（本地缓存协议）。
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
            // 正文图片（http/s）改写为本地缓存协议；data: 内嵌图保持原样
            if (tag === 'IMG' && /^https?:\/\//i.test(attr.value)) {
              attr.value = cachedImageUrl(attr.value)
            }
          } else if (name === 'srcset') {
            const safe = sanitizeSrcset(attr.value)
            if (!safe) continue
            // 响应式候选图同样改写为本地缓存协议
            if (tag === 'IMG') {
              attr.value = safe
                .split(',')
                .map((cand) => {
                  const piece = cand.trim()
                  const urlPart = piece.split(/\s+/)[0]
                  if (!/^https?:\/\//i.test(urlPart)) return piece
                  return `${cachedImageUrl(urlPart)} ${piece.slice(urlPart.length).trim()}`.trim()
                })
                .join(', ')
            } else {
              attr.value = safe
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

/**
 * 展开荒启正文的媒体标签（官方 markExpand 逻辑，api-research.md 实测）：
 *   [music 163]id[/music 163]      → 网易云 iframe 播放器（id 仅数字）
 *   [music qq]id[/music qq]        → QQ 音乐 iframe 播放器（id 仅数字）
 *   [video bilibili]BVxx[/video bilibili] → B 站 iframe（仅 BV 号）
 * 必须在 sanitizeHtml 之后调用（文本已在白名单内）；这里只生成受控 iframe：
 * src 域名/路径固定、id 经严格校验，杜绝注入任意 URL。
 */
const MUSIC_163_IFRAME =
  '<iframe class="hqsf-media" frameborder="no" border="0" marginwidth="0" marginheight="0" ' +
  'width="330" height="86" src="https://music.163.com/outchain/player?type=2&id=$1&auto=0&height=66"></iframe>'
const MUSIC_QQ_IFRAME =
  '<iframe class="hqsf-media" frameborder="no" border="0" marginwidth="0" marginheight="0" ' +
  'width="330" height="66" src="https://i.y.qq.com/n2/m/outchain/player/index.html?songid=$1"></iframe>'
const BILI_IFRAME =
  '<iframe class="hqsf-media hqsf-video" src="https://player.bilibili.com/player.html?bvid=$1" ' +
  'scrolling="no" border="0" frameborder="no" width="100%" height="420" allowfullscreen="true"></iframe>'

export function expandMediaTags(html: string): string {
  if (!html) return ''
  return html
    .replace(/\[music\s+163\]\s*(\d{3,20})\s*\[\/music\s+163\]/g, MUSIC_163_IFRAME)
    .replace(/\[music\s+qq\]\s*(\d{3,20})\s*\[\/music\s+qq\]/g, MUSIC_QQ_IFRAME)
    .replace(/\[video\s+bilibili\]\s*(BV[0-9A-Za-z]{6,20})\s*\[\/video\s+bilibili\]/g, BILI_IFRAME)
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
