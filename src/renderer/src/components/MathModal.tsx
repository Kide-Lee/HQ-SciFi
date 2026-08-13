import { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'

interface MathModalProps {
  open: boolean
  /** 初始 LaTeX（编辑已有公式时预填；插入时为空） */
  value: string
  /** 是否编辑模式（已有公式）：编辑区清空后点「确定」= 删除该公式（插入模式空内容禁止确定） */
  editable?: boolean
  onClose: () => void
  onConfirm: (latex: string) => void
}

/** 常见语法结构 + 特殊符号（点击插入到光标处） */
const SYMBOL_GROUPS: Array<{ label: string; items: Array<{ label: string; insert: string }> }> = [
  {
    label: '结构',
    items: [
      { label: '分数', insert: '\\frac{}{}' },
      { label: '根号', insert: '\\sqrt{}' },
      { label: '上标', insert: '^{}' },
      { label: '下标', insert: '_{}' },
      { label: '求和', insert: '\\sum_{}^{}' },
      { label: '积分', insert: '\\int_{}^{}' },
      { label: '括号', insert: '\\left( \\right)' }
    ]
  },
  {
    label: '希腊字母',
    items: [
      { label: 'α', insert: '\\alpha' },
      { label: 'β', insert: '\\beta' },
      { label: 'γ', insert: '\\gamma' },
      { label: 'δ', insert: '\\delta' },
      { label: 'θ', insert: '\\theta' },
      { label: 'λ', insert: '\\lambda' },
      { label: 'μ', insert: '\\mu' },
      { label: 'π', insert: '\\pi' },
      { label: 'σ', insert: '\\sigma' },
      { label: 'ω', insert: '\\omega' }
    ]
  },
  {
    label: '运算符',
    items: [
      { label: '×', insert: '\\times' },
      { label: '÷', insert: '\\div' },
      { label: '±', insert: '\\pm' },
      { label: '·', insert: '\\cdot' },
      { label: '≤', insert: '\\leq' },
      { label: '≥', insert: '\\geq' },
      { label: '≠', insert: '\\neq' },
      { label: '∞', insert: '\\infty' },
      { label: '→', insert: '\\rightarrow' },
      { label: '⇒', insert: '\\Rightarrow' }
    ]
  }
]

/**
 * v0.0.6：公式编辑弹窗（LaTeX 输入 + KaTeX 实时预览 + 常见语法/符号辅助按钮）。
 * v0.0.7：取消「删除」按钮——编辑已有公式时清空编辑区后点「确定」即删除。
 * 替代 window.prompt（Electron 渲染进程不支持 prompt），用于插入 / 重编辑公式。
 */
export function MathModal({ open, value, editable, onClose, onConfirm }: MathModalProps): React.JSX.Element | null {
  const [latex, setLatex] = useState(value)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) setLatex(value)
  }, [open, value])

  const previewHtml = useMemo(() => {
    if (!latex.trim()) return ''
    try {
      return katex.renderToString(latex, { throwOnError: false, displayMode: true })
    } catch {
      return '<span class="katex-error">公式语法有误</span>'
    }
  }, [latex])

  if (!open) return null

  /** 在输入框光标处插入 LaTeX 片段 */
  function insertAtCursor(insert: string): void {
    const ta = taRef.current
    if (!ta) {
      setLatex((cur) => cur + insert)
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    setLatex((cur) => cur.slice(0, start) + insert + cur.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = start + insert.length
    })
  }

  return (
    <div className="publish-modal-backdrop" onClick={onClose}>
      <div className="publish-modal math-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="publish-modal-title">公式（LaTeX）</h3>
        {/* v0.0.6：辅助按钮区（顶部）——常见语法结构 + 特殊符号 */}
        <div className="math-symbols">
          {SYMBOL_GROUPS.map((g) => (
            <div className="math-symbol-group" key={g.label}>
              <span className="math-symbol-label">{g.label}</span>
              {g.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  className="math-symbol-btn"
                  title={it.insert}
                  onClick={() => insertAtCursor(it.insert)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        {/* v0.0.6：编辑区（左）+ 预览区（右）左右并排 */}
        <div className="math-body">
          <textarea
            ref={taRef}
            className="math-input"
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            placeholder="如 E=mc^2、\\frac{a}{b}"
            rows={4}
            autoFocus
          />
          <div className="math-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
        <div className="publish-modal-actions">
          <button className="toolbar-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="toolbar-btn primary"
            disabled={!editable && !latex.trim()}
            onClick={() => onConfirm(latex.trim())}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
