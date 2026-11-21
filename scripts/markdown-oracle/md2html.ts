/**
 * markdown 金标准「预言机」：**1.x 发布链路的原实现副本**（Electron 时代 src/main/infra/media/md2html.ts）。
 *
 * 为什么留在这里：`scripts/gen-markdown-corpus.mjs` 要 import **真实现**生成 `testdata/markdown/corpus.jsonl`，
 * 而不是手写期望值。1.x 主进程已删除（v2.0.14 起），所以把这份实现冻结在 scripts/ 下作为可复跑的对照物。
 * 它只被语料生成器使用，不参与任何运行时（Tauri 侧是 `crates/hqsf-core/src/infra/markdown`）。
 *
 * 规则：**不要修改**这个文件。它是历史行为快照；改了就等于把金标准挪到新实现上，对拍会失去意义。
 * 依赖（shared/kaiti、shared/markdownItMath、node_modules/markdown-it）都还在——它们同时被渲染层预览使用。
 */
import MarkdownIt from 'markdown-it'
import { KAITI_OPEN, KAITI_CLOSE } from '../../src/shared/kaiti'
import { mathPlugin } from '../../src/shared/markdownItMath'

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
