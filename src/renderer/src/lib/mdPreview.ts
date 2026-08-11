import MarkdownIt from 'markdown-it'
import { cachedImageUrl } from './sanitize'

/**
 * 即时预览模式的 md → HTML 渲染（渲染层本地预览）。
 * 配置与主进程 md2html.ts 保持一致（html:false 防注入、linkify、段落内换行 → <br>）；
 * 远端图片 src 改写为 hqsf-img:// 本地缓存协议（与阅读视图一致）。
 */

const md = new MarkdownIt({
  html: false, // 不渲染原始 HTML，防注入
  linkify: true,
  breaks: true, // 段落内换行 → <br>，与同步/发布转换对齐
  typographer: false
})

/** md → 预览 HTML（图片走本地缓存协议） */
export function renderMdPreview(markdown: string): string {
  if (!markdown) return ''
  const html = md.render(markdown)
  return html.replace(
    /(<img[^>]*\ssrc=")(https?:\/\/[^"]+)(")/g,
    (_, pre: string, url: string, post: string) => `${pre}${cachedImageUrl(url)}${post}`
  )
}
