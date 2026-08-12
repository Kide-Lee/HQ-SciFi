import MarkdownIt from 'markdown-it'
import { cachedImageUrl } from './sanitize'
import { KAITI_OPEN, KAITI_CLOSE } from '../../../shared/kaiti'

/**
 * 分屏预览等模式的 md → HTML 渲染（渲染层本地预览）。
 * 配置与主进程 md2html.ts 保持一致（linkify、段落内换行 → <br>）；
 * 远端图片 src 改写为 hqsf-img:// 本地缓存协议（与阅读视图一致）。
 * v0.0.6：楷体 span 白名单放行（milkdown 楷体 mark 的 md 序列化），其余 HTML 一律转义。
 */

const md = new MarkdownIt({
  html: true, // 白名单放行 kaiti span，其余 HTML 由下方规则转义（防注入）
  linkify: true,
  breaks: true, // 段落内换行 → <br>，与同步/发布转换对齐
  typographer: false
})

/** 仅放行楷体 span（开/闭标签），其余 HTML 转义 */
const KAITI_RE = /^<\/?span class="kaiti">$/i
md.renderer.rules.html_inline = (tokens, idx) => {
  const content = tokens[idx].content
  return KAITI_RE.test(content.trim()) ? content : md.utils.escapeHtml(content)
}
// 行首 HTML（script/div 等块级）一律转义，防止注入
md.renderer.rules.html_block = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content)

/** md → 预览 HTML（图片走本地缓存协议） */
export function renderMdPreview(markdown: string): string {
  if (!markdown) return ''
  const html = md.render(markdown)
  return html.replace(
    /(<img[^>]*\ssrc=")(https?:\/\/[^"]+)(")/g,
    (_, pre: string, url: string, post: string) => `${pre}${cachedImageUrl(url)}${post}`
  )
}
