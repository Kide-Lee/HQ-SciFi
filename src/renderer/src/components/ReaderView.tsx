import { useEffect, useMemo, useState } from 'react'
import { useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { formatSize, formatTs, sanitizeHtml } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import type { ArticleDetail } from '../../../shared/types'

/** 从详情/用户信息里提取作者展示名（与侧栏同样的多字段容错） */
function authorName(detail: ArticleDetail): string {
  const u = detail.userJson ?? {}
  const name =
    u.nickname ?? u.nick ?? u.nickName ?? u.userName ?? u.name ?? (u.uid != null ? `UID ${String(u.uid)}` : '')
  return String(name || '佚名')
}

/** 阅读视图：远端文章 HTML 正文 + 元信息；评审面板挂在右侧 */
export function ReaderView(): React.JSX.Element {
  const detail = useReaderStore((s) => s.detail)
  const detailLoading = useReaderStore((s) => s.detailLoading)
  const detailError = useReaderStore((s) => s.detailError)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const session = useAuthStore((s) => s.session)

  const [showReview, setShowReview] = useState(false)

  // 打开新文章时默认收起评审面板
  useEffect(() => {
    setShowReview(false)
  }, [detail?.cid])

  const safeHtml = useMemo(() => (detail ? sanitizeHtml(detail.text) : ''), [detail])

  const myUid = String(session?.userinfo?.uid ?? session?.userinfo?.id ?? '')
  const isMine = !!detail && myUid !== '' && String(detail.authorId) === myUid

  if (detailLoading) {
    return (
      <main className="main-area">
        <div className="reader-loading">正在加载文章 …</div>
      </main>
    )
  }

  if (detailError || !detail) {
    return (
      <main className="main-area">
        <div className="reader-error">
          <ErrorBanner title="阅读失败" message={detailError ?? '未找到文章'} />
          <button className="toolbar-btn" onClick={closeArticle}>
            返回
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="main-area">
      <div className="reader-layout">
        <div className="reader-main">
          <header className="reader-header">
            <h1 className="reader-title">{detail.title}</h1>
            <div className="reader-meta">
              <span className="reader-author">{authorName(detail)}</span>
              {detail.size ? <span>· {formatSize(detail.size)} 字</span> : null}
              {detail.views ? <span>· {detail.views} 阅读</span> : null}
              {detail.likes ? <span>· {detail.likes} 赞</span> : null}
              {detail.score && detail.score !== '-.-' ? <span className="reader-score">评分 {detail.score}</span> : null}
              {detail.created ? <span>· {formatTs(detail.created)}</span> : null}
            </div>
            {!isMine && (
              <button className="review-toggle" onClick={() => setShowReview((v) => !v)}>
                {showReview ? '收起评审' : '✎ 评审这篇文章'}
              </button>
            )}
          </header>
          <article
            className="reader-body"
            // 正文已经 sanitizeHtml 白名单净化，无脚本/事件/危险协议
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
          <div className="reader-footer">
            <button className="toolbar-btn" onClick={closeArticle}>
              ← 返回列表
            </button>
          </div>
        </div>
        {!isMine && showReview && <ReviewPanel />}
      </div>
    </main>
  )
}

/** 评审面板：已有评审列表 + 五维表单（懒加载：面板打开时才拉评审） */
function ReviewPanel(): React.JSX.Element {
  const reviews = useReaderStore((s) => s.reviews)
  const reviewsLoading = useReaderStore((s) => s.reviewsLoading)
  const submitting = useReaderStore((s) => s.submitting)
  const submitMessage = useReaderStore((s) => s.submitMessage)
  const clearSubmitMessage = useReaderStore((s) => s.clearSubmitMessage)
  const submit = useReaderStore((s) => s.submit)
  const setAttitude = useReaderStore((s) => s.setAttitude)
  const detail = useReaderStore((s) => s.detail)
  const loadReviews = useReaderStore((s) => s.loadReviews)

  const [form, setForm] = useState({
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
  })
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    clearSubmitMessage()
    setFormError(null)
    if (detail?.cid) void loadReviews(detail.cid)
  }, [detail?.cid, loadReviews, clearSubmitMessage])

  const dims: Array<{ key: keyof typeof form; scoreKey: keyof typeof form; label: string; hint: string }> = [
    { key: 'dianzi', scoreKey: 'dianziScore', label: '设定', hint: '世界观与设定是否自洽、有想象力' },
    { key: 'wenbi', scoreKey: 'wenbiScore', label: '文笔', hint: '语言表达是否流畅、有感染力' },
    { key: 'renwu', scoreKey: 'renwuScore', label: '人物', hint: '人物形象是否立体、动机可信' },
    { key: 'jiezou', scoreKey: 'jiezouScore', label: '情节', hint: '节奏与剧情推进是否抓人' },
    { key: 'liyi', scoreKey: 'liyiScore', label: '思想性', hint: '主题深度与思想内涵' }
  ]

  function setDim(key: keyof typeof form, value: string | number): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSubmit(): Promise<void> {
    if (!detail) return
    setFormError(null)
    for (const d of dims) {
      const text = String(form[d.key] ?? '').trim()
      if (text.length < 10) {
        setFormError(`「${d.label}」评语需至少 10 字（当前 ${text.length} 字）`)
        return
      }
    }
    const payload = {
      dianzi: form.dianzi.trim(),
      wenbi: form.wenbi.trim(),
      renwu: form.renwu.trim(),
      jiezou: form.jiezou.trim(),
      liyi: form.liyi.trim(),
      zonghe: form.zonghe.trim() || undefined,
      dianziScore: Number(form.dianziScore),
      wenbiScore: Number(form.wenbiScore),
      renwuScore: Number(form.renwuScore),
      jiezouScore: Number(form.jiezouScore),
      liyiScore: Number(form.liyiScore),
      cid: detail.cid,
      activeid: detail.active && detail.active.length > 0 ? detail.active[0].mid : 0
    }
    const ok = await submit(payload)
    if (ok) {
      // 清空表单，鼓励继续参与
      setForm({
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
      })
    }
  }

  const myUid = String(useAuthStore.getState().session?.userinfo?.uid ?? '')

  return (
    <aside className="review-panel">
      <div className="review-panel-head">
        <h3>作品评审</h3>
        <span className="review-count">{reviews.length} 条</span>
      </div>

      {submitMessage && !submitMessage.startsWith('提交失败') && (
        <div className="review-msg">
          {submitMessage}
          <button className="dismiss" onClick={clearSubmitMessage}>
            ✕
          </button>
        </div>
      )}
      {submitMessage && submitMessage.startsWith('提交失败') && (
        <ErrorBanner
          title="评审提交失败"
          message={submitMessage.replace(/^提交失败:\s*/, '')}
          onDismiss={clearSubmitMessage}
        />
      )}

      {/* 已有评审 */}
      <div className="review-list">
        {reviewsLoading && <div className="muted review-loading">加载评审中 …</div>}
        {!reviewsLoading && reviews.length === 0 && (
          <div className="muted review-empty">还没有人评审，来抢沙发吧</div>
        )}
        {reviews.map((r) => {
          const u = r.userJson ?? {}
          const rName = String(u.nickname ?? u.nick ?? u.nickName ?? u.name ?? `UID ${String(u.uid ?? '')}`)
          const isMine = myUid !== '' && String(u.uid ?? u.id ?? '') === myUid
          return (
            <div key={String(r.id)} className={`review-item ${isMine ? 'mine' : ''}`}>
              <div className="review-item-head">
                <span className="review-item-author">{rName}</span>
                {r.isAi ? <span className="review-ai-tag">AI</span> : null}
                {isMine ? <span className="review-mine-tag">我</span> : null}
                <span className="review-item-score">{r.actualscore && r.actualscore !== '-.-' ? `${r.actualscore} 分` : ''}</span>
              </div>
              <div className="review-dims">
                {[
                  ['设定', r.dianzi],
                  ['文笔', r.wenbi],
                  ['人物', r.renwu],
                  ['情节', r.jiezou],
                  ['思想性', r.liyi]
                ].map(
                  ([label, text]) =>
                    text && (
                      <div key={String(label)} className="review-dim">
                        <span className="review-dim-label">{label}</span>
                        <span className="review-dim-text">{text}</span>
                      </div>
                    )
                )}
                {r.zonghe && <div className="review-dim review-zonghe">综合：{r.zonghe}</div>}
              </div>
              <div className="review-item-actions">
                {[
                  ['joy', '开心', 0],
                  ['helpful', '有用', 1],
                  ['earnest', '认真', 2]
                ].map(([key, label, type]) => (
                  <button
                    key={String(key)}
                    className={`attitude-btn ${Number(r.attitudeType) === Number(type) ? 'active' : ''}`}
                    onClick={() => void setAttitude(r.id, Number(type))}
                    title={`表态：${String(label)}`}
                  >
                    {String(label)} {Number(r[key as 'joy']) > 0 ? Number(r[key as 'joy']) : ''}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 提交表单 */}
      <div className="review-form">
        <h4>发表你的评审</h4>
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
            <textarea
              placeholder={`${d.hint}（≥10 字）`}
              value={String(form[d.key])}
              onChange={(e) => setDim(d.key, e.target.value)}
              rows={2}
            />
          </div>
        ))}
        <div className="review-form-dim">
          <div className="review-form-row">
            <span className="review-form-label">综合评价</span>
          </div>
          <textarea
            placeholder="对作品的整体评价（选填）"
            value={form.zonghe}
            onChange={(e) => setDim('zonghe', e.target.value)}
            rows={2}
          />
        </div>
        {formError && <div className="review-form-error">{formError}</div>}
        <button className="review-submit" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? '提交中 …' : '提交评审'}
        </button>
      </div>
    </aside>
  )
}
