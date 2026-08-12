import katex from 'katex'

/**
 * markdown-it 数学公式渲染插件（KaTeX）。
 * 与 milkdown 官方 @milkdown/plugin-math 的序列化语法一致：
 *   - 行内公式 `$...$`
 *   - 块级公式 `$$...$$`（单行）或 `$$\n...\n$$`（多行）
 * 渲染为 KaTeX HTML；语法错误时回退为转义原文（throwOnError:false）。
 */

function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, { throwOnError: false, displayMode })
  } catch {
    const escaped = latex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return displayMode
      ? `<div class="katex-error">${escaped}</div>`
      : `<span class="katex-error">${escaped}</span>`
  }
}

export function mathPlugin(md: any): void {
  // 行内公式 $...$（排除 $$）
  md.inline.ruler.after('escape', 'math_inline', (state: any, silent: boolean): boolean => {
    const pos = state.pos
    if (state.src.charCodeAt(pos) !== 0x24) return false
    if (state.src.charCodeAt(pos + 1) === 0x24) return false // $$ 块公式交给 block rule
    const start = pos + 1
    let end = -1
    for (let i = start; i < state.posMax; i++) {
      if (state.src.charCodeAt(i) === 0x24 && state.src.charCodeAt(i + 1) !== 0x24) {
        end = i
        break
      }
    }
    if (end < 0) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = state.src.slice(start, end)
    }
    state.pos = end + 1
    return true
  })

  // 块级公式 $$...$$（单行）或 $$\n...\n$$（多行）
  md.block.ruler.after('blockquote', 'math_block', (state: any, startLine: number, endLine: number, silent: boolean): boolean => {
    let pos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    const firstLine = state.src.slice(pos, max).trim()
    if (!firstLine.startsWith('$$')) return false

    let nextLine = startLine
    let content = firstLine.slice(2).trim()
    let endFound = false

    const single = content.indexOf('$$')
    if (single >= 0) {
      // 单行 $$latex$$
      content = content.slice(0, single).trim()
      endFound = true
    } else {
      // 多行：逐行收集，直到以 $$ 结尾的行
      nextLine++
      const parts: string[] = [content]
      for (; nextLine < endLine; nextLine++) {
        pos = state.bMarks[nextLine] + state.tShift[nextLine]
        const m = state.eMarks[nextLine]
        const line = state.src.slice(pos, m).trim()
        if (line.endsWith('$$')) {
          parts.push(line.slice(0, -2).trim())
          endFound = true
          break
        }
        parts.push(line)
      }
      content = parts.join('\n')
    }

    if (!endFound) return false

    if (!silent) {
      const token = state.push('math_block', 'math_block', 0)
      token.block = true
      token.content = content
      token.map = [startLine, nextLine + 1]
    }
    state.line = nextLine + 1
    return true
  })

  md.renderer.rules.math_inline = (tokens: any[], idx: number) => renderMath(tokens[idx].content, false)
  md.renderer.rules.math_block = (tokens: any[], idx: number) => `<div class="math-block">${renderMath(tokens[idx].content, true)}</div>\n`
}
