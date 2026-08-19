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
  UL: new Set(['class']), // 荒启协议条目列表（hq-list）
  LI: new Set(['value', 'class']), // 协议条目层级缩进类（lv-N）
  SPAN: new Set(['class']) // 协议条目 marker/内容容器（.m/.t）
}

/** data: 内嵌图最大字节数（base64 解码后），防超大字符串塞爆 DOM */
const MAX_DATA_IMAGE_BYTES = 2 * 1024 * 1024

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
 * 也兼容标签内直接贴完整分享链接的情况，例如：
 *   [music 163]https://y.music.163.com/m/song?id=123[/music 163]
 * 必须在 sanitizeHtml 之后调用（文本已在白名单内）；这里只生成受控 iframe：
 * src 域名/路径固定、id 经严格校验，杜绝注入任意 URL。
 */

/** 从媒体标签原文中解析出真正用于播放器的 ID；解析失败返回 null（保持原文）。 */
export function parseMediaId(tag: string, raw: string): string | null {
  const v = raw.trim()
  if (tag === 'music 163') {
    if (/^\d{3,20}$/.test(v)) return v
    const url = v.replace(/&amp;/g, '&')
    const m = /[?&]id=(\d{3,20})/.exec(url)
    return m ? m[1] : null
  }
  if (tag === 'music qq') {
    if (/^\d{3,20}$/.test(v)) return v
    const url = v.replace(/&amp;/g, '&')
    const m = /(?:[?&]songid=|[?&]id=)(\d{3,20})/.exec(url)
    return m ? m[1] : null
  }
  if (tag === 'video bilibili') {
    if (/^BV[0-9A-Za-z]{6,20}$/.test(v)) return v
    const m = /(BV[0-9A-Za-z]{6,20})/.exec(v)
    return m ? m[1] : null
  }
  return null
}

const MUSIC_163_RE = /\[music\s+163\]\s*([\s\S]*?)\s*\[\/music\s+163\]/g
const MUSIC_QQ_RE = /\[music\s+qq\]\s*([\s\S]*?)\s*\[\/music\s+qq\]/g
const BILI_RE = /\[video\s+bilibili\]\s*([\s\S]*?)\s*\[\/video\s+bilibili\]/g

/**
 * 媒体标签 → 播放器 iframe src（编辑器内嵌播放器与阅读/预览展开共用同一 URL 来源）。
 * 域名/路径固定、id 经严格校验（音乐纯数字、B 站仅大写 BV 号——与阅读端正则一致，
 * 小写 bv 前缀不认，避免编辑器预览正常但阅读端不展开），非法返回 null。
 */
export function mediaPlayerUrl(tag: string, id: string): string | null {
  if (tag === 'music 163' && /^\d{3,20}$/.test(id)) {
    return `https://music.163.com/outchain/player?type=2&id=${id}&auto=0&height=66`
  }
  if (tag === 'music qq' && /^\d{3,20}$/.test(id)) {
    return `https://i.y.qq.com/n2/m/outchain/player/index.html?songid=${id}`
  }
  if (tag === 'video bilibili' && /^BV[0-9A-Za-z]{6,20}$/.test(id)) {
    return `https://player.bilibili.com/player.html?bvid=${id}`
  }
  return null
}

const MUSIC_163_IFRAME = (id: string): string =>
  `<iframe class="hqsf-media" frameborder="no" border="0" marginwidth="0" marginheight="0" ` +
  `width="330" height="86" src="${mediaPlayerUrl('music 163', id)}"></iframe>`
const MUSIC_QQ_IFRAME = (id: string): string =>
  `<iframe class="hqsf-media" frameborder="no" border="0" marginwidth="0" marginheight="0" ` +
  `width="330" height="66" src="${mediaPlayerUrl('music qq', id)}"></iframe>`
const BILI_IFRAME = (id: string): string =>
  `<iframe class="hqsf-media hqsf-video" src="${mediaPlayerUrl('video bilibili', id)}" ` +
  `scrolling="no" border="0" frameborder="no" width="100%" height="420" allowfullscreen="true"></iframe>`

export function expandMediaTags(html: string): string {
  if (!html) return ''
  return html
    .replace(MUSIC_163_RE, (m, raw: string) => {
      const id = parseMediaId('music 163', raw)
      return id ? MUSIC_163_IFRAME(id) : m
    })
    .replace(MUSIC_QQ_RE, (m, raw: string) => {
      const id = parseMediaId('music qq', raw)
      return id ? MUSIC_QQ_IFRAME(id) : m
    })
    .replace(BILI_RE, (m, raw: string) => {
      const id = parseMediaId('video bilibili', raw)
      return id ? BILI_IFRAME(id) : m
    })
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

/**
 * 评分 → 颜色（红 → 紫 色相渐变）：0 分红 (0°)、10 分紫 (300°)，中间平滑过渡。
 * 仅当评分无效（-.- / 空 / NaN）返回 null（调用方用灰色占位）；0.0 是真实评分，给红色。
 */
export function scoreColor(score: string | number | undefined): string | null {
  const n = Number(score)
  if (!Number.isFinite(n)) return null
  // 0-10 映射到 0°-300°；0 分即 0° 纯红
  const hue = Math.min(300, Math.max(0, (n / 10) * 300))
  return `hsl(${hue}, 62%, 42%)`
}

/** 从 userJson 提取用户展示名（多字段容错；无昵称回退 UID，再回退 fallback）。v0.0.8.6 抽取共用 */
export function userDisplayName(u: Record<string, unknown> | undefined, fallback = '匿名'): string {
  const name = String(u?.nickname ?? u?.nick ?? u?.nickName ?? u?.userName ?? u?.name ?? '').trim()
  if (name) return name
  if (u?.uid != null && String(u.uid) !== '') return `UID ${String(u.uid)}`
  return fallback
}

/** 用户经验等级（v0.0.10：对齐官网 getLever——Lv0~Lv7，含徽章底色） */
export interface UserLevelInfo {
  label: string
  color: string
}

/** 用户等级配色（Lv0 → Lv7）：灰 → 灰蓝 → 蓝 → 主题蓝 → 深蓝 → 紫 → 红 → 金 */
const USER_LEVEL_COLORS = ['#6B7280', '#5F7396', '#5A6ECC', '#4A6CF7', '#2E46A6', '#7C3AED', '#D64545', '#A67C00']

/** 经验值 → 等级（官网阈值：0/10/50/200/500/1000/2000/5000） */
export function userLevelInfo(experience: unknown): UserLevelInfo | null {
  if (experience == null || experience === '') return null
  const exp = Number(experience)
  if (!Number.isFinite(exp)) return null
  const idx = exp < 10 ? 0 : exp < 50 ? 1 : exp < 200 ? 2 : exp < 500 ? 3 : exp < 1000 ? 4 : exp < 2000 ? 5 : exp < 5000 ? 6 : 7
  return { label: `Lv${idx}`, color: USER_LEVEL_COLORS[idx] }
}

/** 是否为「匿名 uid」（0 / 空 / 未提供；荒启以 0 表示匿名访客） */
function isAnonUid(v: string | number | null | undefined): boolean {
  if (v == null) return true
  const s = String(v)
  return s === '' || s === '0'
}

/**
 * v0.0.9：匿名作者的文章下，若评论/评审者就是作者本人，显示名统一为「匿名用户」。
 * @param article 文章侧信息（authorId + isAnonymous；来自 detail / 列表条目 / 评论流的 articleInfo）
 * @param itemAuthorId 评论的 authorId 或评审的 uid
 * @param fallbackName 未命中规则时使用的原始显示名
 */
export function anonymousAuthorDisplayName(
  article: { authorId?: string | number; isAnonymous?: boolean | number | string } | null | undefined,
  itemAuthorId: string | number | null | undefined,
  fallbackName: string
): string {
  if (!article) return fallbackName
  const anon = article.isAnonymous
  if (anon !== true && anon !== 1 && anon !== '1' && anon !== 'true') return fallbackName
  const aStr = article.authorId == null ? '' : String(article.authorId)
  const bStr = itemAuthorId == null ? '' : String(itemAuthorId)
  // 文章与评论/评审同为匿名身份时，视为作者本人（匿名文章下无法区分匿名作者与匿名访客，统一显示为匿名用户）
  if (isAnonUid(aStr) && isAnonUid(bStr)) return '匿名用户'
  // 双方都是真实 uid 且相等 → 作者本人
  if (!isAnonUid(aStr) && !isAnonUid(bStr) && aStr === bStr) return '匿名用户'
  return fallbackName
}

/** 从 userJson 提取头像 URL（仅 http(s)；返回原始 URL，由调用方走 cachedImageUrl） */
export function userAvatarUrl(u: Record<string, unknown> | undefined): string | undefined {
  const raw = String(u?.avatar ?? u?.headImg ?? u?.headImgUrl ?? u?.avatarUrl ?? '')
  return raw && /^https?:\/\//i.test(raw) ? raw : undefined
}
