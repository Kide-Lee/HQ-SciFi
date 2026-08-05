import MarkdownIt from 'markdown-it'

/**
 * md → HTML 转换（design.md 风险 1：荒启正文为 Quill HTML，isMd:0，本地 md 需在同步/发布时转换）。
 * 输出标准语义标签（p/h1-h6/blockquote/ul/ol/pre/code/img/a/strong/em），Quill 编辑器可解析。
 */

const md = new MarkdownIt({
  html: false, // 不渲染原始 HTML，防注入
  linkify: true,
  breaks: true, // 段落内换行 → <br>，对齐 Quill 换行语义
  typographer: false
})

export function mdToHtml(markdown: string): string {
  return md.render(markdown)
}
