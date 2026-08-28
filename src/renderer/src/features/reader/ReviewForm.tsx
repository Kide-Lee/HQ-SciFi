import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, FileDown, MessageCircle, PenLine, X } from 'lucide-react'
import { anonymousAuthorDisplayName, cachedImageUrl, formatSize, formatTs, scoreColor, userAvatarUrl, userDisplayName } from '../../lib/sanitize'
import { REVIEW_ORDERS, useReaderStore } from '../../stores/reader'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import type { CommentItem, ReviewItem, ReviewPayload } from '../../../../shared/types'

export function emptyForm() {
  return {
    dianzi: '',
    wenbi: '',
    renwu: '',
    jiezou: '',
    liyi: '',
    zonghe: '',
    dianziScore: 5,
    wenbiScore: 5,
    renwuScore: 5,
    jiezouScore: 5,
    liyiScore: 5
  }
}

export function parseScoreParts(score?: string): number[] | null {
  if (!score) return null
  const parts = score.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return null
  return parts
}

export function ReviewForm({
  cid,
  initial,
  submitting,
  onSubmit,
  onCancel
}: {
  /** 被评审文章 cid */
  cid: string
  /** 编辑模式：预填已有评审 */
  initial?: ReviewItem
  submitting: boolean
  onSubmit: (payload: ReviewPayload) => Promise<boolean>
  /** 编辑模式下的「退回评审展示」按钮（v0.0.2） */
  onCancel?: () => void
}): React.JSX.Element {
  const [form, setForm] = useState(() => {
    const base = emptyForm()
    if (!initial) return base
    const parts = parseScoreParts(initial.score)
    return {
      dianzi: initial.dianzi ?? '',
      wenbi: initial.wenbi ?? '',
      renwu: initial.renwu ?? '',
      jiezou: initial.jiezou ?? '',
      liyi: initial.liyi ?? '',
      zonghe: initial.zonghe ?? '',
      dianziScore: parts ? parts[0] : 5,
      wenbiScore: parts ? parts[1] : 5,
      renwuScore: parts ? parts[3] : 5,
      jiezouScore: parts ? parts[2] : 5,
      liyiScore: parts ? parts[4] : 5
    }
  })
  const [formError, setFormError] = useState<string | null>(null)

  const dims: Array<{ key: keyof typeof form; scoreKey: keyof typeof form; label: string; hint: string }> = [
    { key: 'dianzi', scoreKey: 'dianziScore', label: '设定', hint: '世界观与设定是否自洽、有想象力' },
    { key: 'wenbi', scoreKey: 'wenbiScore', label: '文笔', hint: '语言表达是否流畅、有感染力' },
    { key: 'renwu', scoreKey: 'renwuScore', label: '人物', hint: '人物形象是否立体、动机可信' },
    { key: 'jiezou', scoreKey: 'jiezouScore', label: '情节', hint: '节奏与剧情推进是否抓人' },
    { key: 'liyi', scoreKey: 'liyiScore', label: '思想性', hint: '主题深度与思想内涵' }
  ]

  function setDim(key: keyof typeof form, value: string | number): void {
    setForm((f) => ({ ...f, [key]: value }))
    setFormError(null)
  }

  // v0.0.2：实时平均分预示（五维评分均值）
  const avgPreview =
    (Number(form.dianziScore) +
      Number(form.wenbiScore) +
      Number(form.renwuScore) +
      Number(form.jiezouScore) +
      Number(form.liyiScore)) /
    5

  async function handleSubmit(): Promise<void> {
    setFormError(null)
    for (const d of dims) {
      const text = String(form[d.key] ?? '').trim()
      if (text.length < 10) {
        setFormError(`「${d.label}」评语需至少 10 字（当前 ${text.length} 字）`)
        return
      }
    }
    const ok = await onSubmit({
      cid,
      dianzi: String(form.dianzi).trim(),
      wenbi: String(form.wenbi).trim(),
      renwu: String(form.renwu).trim(),
      jiezou: String(form.jiezou).trim(),
      liyi: String(form.liyi).trim(),
      zonghe: String(form.zonghe).trim() || undefined,
      dianziScore: Number(form.dianziScore),
      wenbiScore: Number(form.wenbiScore),
      renwuScore: Number(form.renwuScore),
      jiezouScore: Number(form.jiezouScore),
      liyiScore: Number(form.liyiScore),
      id: initial?.id
    })
    if (ok && initial) {
      // 编辑保存成功后退出编辑态由父组件处理（父组件持有编辑态）
    }
  }

  return (
    <div className="review-form">
      <h4>{initial ? '编辑你的评审' : '发表你的评审'}</h4>
      {dims.map((d) => (
        <div key={d.key} className="review-form-dim">
          <div className="review-form-row">
            <span className="review-form-label">{d.label}</span>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={Number(form[d.scoreKey])}
              onChange={(e) => setDim(d.scoreKey, Number(e.target.value))}
            />
            <span className="review-form-score">{Number(form[d.scoreKey])}</span>
          </div>
          <AutoGrowTextarea
            placeholder={d.hint}
            value={String(form[d.key])}
            onChange={(v) => setDim(d.key, v)}
          />
        </div>
      ))}
      <div className="review-form-dim">
        <div className="review-form-row">
          <span className="review-form-label">综合评价</span>
          {/* v0.0.2：实时平均分预示（与「综合评价」同行、右对齐） */}
          <div className="review-avg-preview">
            预计评分：<span className="review-avg-value">{avgPreview.toFixed(1)}</span>
          </div>
        </div>
        <AutoGrowTextarea
          placeholder="对作品的整体评价（选填）"
          value={form.zonghe}
          onChange={(v) => setDim('zonghe', v)}
        />
      </div>
      {formError && <div className="review-form-error">{formError}</div>}
      <div className="review-form-actions">
        <button className="review-submit" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? '提交中 …' : initial ? '保存修改' : '提交评审'}
        </button>
        {/* v0.0.2：编辑模式下退回评审展示（不保存） */}
        {initial && onCancel && (
          <button className="review-cancel" onClick={onCancel} disabled={submitting}>
            退回展示
          </button>
        )}
      </div>
    </div>
  )
}

export function AutoGrowTextarea({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    // 占位符换行也会撑大 scrollHeight（窄栏下尤其明显），测量前临时清掉，
    // 只按真实内容生长，保证各编辑框高度一致（v0.0.8）
    const ph = el.placeholder
    el.placeholder = ''
    const h = el.scrollHeight
    el.placeholder = ph
    el.style.height = `${h}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      className="review-grow-textarea"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

