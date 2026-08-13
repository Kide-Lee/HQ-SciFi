import MarkdownIt from 'markdown-it'

/**
 * md → HTML 转换（design.md 风险 1：荒启正文为 Quill HTML，isMd:0，本地 md 需在同步/发布时转换）。
 * 输出标准语义标签（p/h1-h6/blockquote/ul/ol/pre/code/img/a/strong/em），Quill 编辑器可解析。
 *
 * v0.0.6：受控 HTML 白名单——楷体（<font face="楷体">，替代斜体按钮）、图片/音频/视频
 * （插入媒体产物）需要透传原始标签；其余原始 HTML 仍转义为文本，防止任意标签注入。
 */

/** 白名单标签（含属性与自闭合）：font / img / audio / video / source */
const ALLOWED_HTML_TAG_RE = /^<\/?(?:font|img|audio|video|source)(?:\s[^>]*)?\/?>$/i

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const md = new MarkdownIt({
  // 生成 html_inline/html_block token，由下方 renderer 规则做白名单过滤（非白名单标签转义，防注入）
  html: true,
  linkify: true,
  breaks: true, // 段落内换行 → <br>，对齐 Quill 换行语义
  typographer: false
})

/** 白名单 HTML 放行；其余转义为文本 */
function renderAllowedHtml(html: string): string {
  return ALLOWED_HTML_TAG_RE.test(html.trim()) ? html : escapeHtml(html)
}

// 覆盖默认 html_inline/html_block 渲染（默认 html:true 时原样输出全部 HTML）
md.renderer.rules.html_inline = (tokens, idx) => renderAllowedHtml(tokens[idx].content)
md.renderer.rules.html_block = (tokens, idx) => renderAllowedHtml(tokens[idx].content)

export function mdToHtml(markdown: string): string {
  return md.render(markdown)
}
