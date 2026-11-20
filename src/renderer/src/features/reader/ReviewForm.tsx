import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, FileDown, MessageCircle, PenLine, X } from 'lucide-react'
import { anonymousAuthorDisplayName, cachedImageUrl, formatSize, formatTs, scoreColor, userAvatarUrl, userDisplayName } from '../../lib/sanitize'
import { toQuoteLine } from '../../lib/selection'
import { REVIEW_ORDERS, useReaderStore } from '../../stores/reader'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import {
  DEFAULT_REVIEW_SCORE,
  emptyReviewDraft,
  isEmptyReviewDraft,
  readReviewDraft,
  sameReviewDraft,
  type ReviewDraft
} from '../../lib/draftCache'
import { DraftRestoredHint } from './DraftRestoredHint'
import { useDraftSync } from './useDraftSync'
import type { CommentItem, ReviewItem, ReviewPayload } from '../../../../shared/types'

export function emptyForm(): ReviewDraft {
  return emptyReviewDraft()
}

/**
 * v1.1.12：编辑模式——已有评审 → 表单值。
 * 同时充当草稿「基线」：表单与它一致即视为「没有未提交的修改」，不写草稿。
 */
export function formFromReview(initial: ReviewItem): ReviewDraft {
  const parts = parseScoreParts(initial.score)
  return {
    dianzi: initial.dianzi ?? '',
    wenbi: initial.wenbi ?? '',
    renwu: initial.renwu ?? '',
    jiezou: initial.jiezou ?? '',
    liyi: initial.liyi ?? '',
    zonghe: initial.zonghe ?? '',
    dianziScore: parts ? parts[0] : DEFAULT_REVIEW_SCORE,
    wenbiScore: parts ? parts[1] : DEFAULT_REVIEW_SCORE,
    renwuScore: parts ? parts[3] : DEFAULT_REVIEW_SCORE,
    jiezouScore: parts ? parts[2] : DEFAULT_REVIEW_SCORE,
    liyiScore: parts ? parts[4] : DEFAULT_REVIEW_SCORE
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
  const uid = String(useAuthStore((s) => s.session?.userinfo?.uid ?? ''))
  // v1.1.12：草稿定位——新评审用 new、编辑用 edit:<评审 id>，两者互不覆盖
  const draftRef = { kind: 'review' as const, uid, cid, sub: initial ? `edit:${initial.id}` : 'new' }
  /** 草稿基线：与它一致即视为「没有未提交的修改」（编辑态=已有评审原文） */
  const baseline = useMemo(() => (initial ? formFromReview(initial) : emptyForm()), [initial])
  /** 挂载时恢复的未提交草稿（提示条只在内容保持原样时展示） */
  const [restored] = useState<ReviewDraft | null>(() => readReviewDraft(draftRef))
  const [form, setForm] = useState<ReviewDraft>(() => restored ?? baseline)
  const [formError, setFormError] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState(false)

  // v1.1.12：未提交的评审即时写入草稿缓存；提交成功后 forgetDraft 清除
  const forgetDraft = useDraftSync({
    ref: draftRef,
    value: form,
    isEmpty: (f) => (initial ? sameReviewDraft(f, baseline) : isEmptyReviewDraft(f)),
    enabled: cid !== ''
  })
  const showRestoredHint =
    restored !== null && !hintDismissed && JSON.stringify(form) === JSON.stringify(restored)

  /** 丢弃恢复出来的草稿，回到空白/已有评审原文 */
  function discardDraft(): void {
    forgetDraft()
    setForm(baseline)
    setHintDismissed(true)
  }

  // v1.1.12：正文「引用到评审」——把选中文字（单行引用）追加到「综合评价」，消费后清空
  const pendingQuote = useReaderStore((s) => s.pendingReviewQuote)
  const consumedQuoteSeq = useRef(0)
  useEffect(() => {
    if (!pendingQuote || consumedQuoteSeq.current === pendingQuote.seq) return
    consumedQuoteSeq.current = pendingQuote.seq
    const line = toQuoteLine(pendingQuote.text)
    setForm((f) => ({ ...f, zonghe: f.zonghe ? `${f.zonghe}\n${line}` : line }))
    useReaderStore.getState().consumeReviewQuote()
  }, [pendingQuote])

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
    // 提交成功后立刻清掉草稿：父组件可能在同一批次里卸载本表单（如保存后退出编辑态），
    // 不能依赖 effect 收尾，否则下次进来会把刚提交的内容当成「未提交草稿」恢复
    if (ok) forgetDraft()
  }

  return (
    <div className="review-form">
      <h4>{initial ? '编辑你的评审' : '发表你的评审'}</h4>
      {showRestoredHint && <DraftRestoredHint onDiscard={discardDraft} />}
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

