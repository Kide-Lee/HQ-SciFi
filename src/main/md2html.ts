import MarkdownIt from 'markdown-it'
import { KAITI_OPEN, KAITI_CLOSE } from '../shared/kaiti'
import { mathPlugin } from '../shared/markdownItMath'

/**
 * md → HTML 转换（design.md 风险 1：荒启正文为 Quill HTML，isMd:0，本地 md 需在同步/发布时转换）。
 * 输出标准语义标签（p/h1-h6/blockquote/ul/ol/pre/code/img/a/strong/em），Quill 编辑器可解析。
 * v0.0.6：楷体 span 白名单放行（milkdown 楷体 mark），其余 HTML 一律转义防注入。
 */

const md = new MarkdownIt({
  html: true, // 白名单放行 kaiti span，其余 HTML 由下方规则转义（防注入）
  linkify: true,
  breaks: true, // 段落内换行 → <br>，对齐 Quill 换行语义
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

// v0.0.6：数学公式（KaTeX 渲染，$...$ / $$...$$）
mathPlugin(md)

export function mdToHtml(markdown: string): string {
  return md.render(markdown)
}
