import { useEffect, useMemo, useRef, useState } from 'react'
import { REVIEW_ORDERS, useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { activityPhase, type ActivityPhase } from '../lib/activity'
import { cachedImageUrl, formatSize, formatTs, expandMediaTags, sanitizeHtml, scoreColor } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import { CommentSection } from './ReaderComments'
import { ReaderInteractions } from './ReaderInteractions'
import type { ArticleDetail, MetaRef, ReviewItem, ReviewPayload } from '../../../shared/types'

/** 活动状态缓存（mid → phase；从文章跳转活动列表时用，避免重复请求） */
let activePhaseCache: Record<string, ActivityPhase> | null = null

/** 从详情/用户信息里提取作者展示名（与侧栏同样的多字段容错） */
function authorName(detail: ArticleDetail): string {
  const u = detail.userJson ?? {}
  const name =
    u.nickname ?? u.nick ?? u.nickName ?? u.userName ?? u.name ?? (u.uid != null ? `UID ${String(u.uid)}` : '')
  return String(name || '佚名')
}

/** 从详情/用户信息里提取作者头像 URL（http(s) 走缓存协议） */
function authorAvatar(detail: ArticleDetail): string | undefined {
  const u = detail.userJson ?? {}
  const raw = String(u.avatar ?? u.headImg ?? u.headImgUrl ?? u.avatarUrl ?? '')
  return raw && /^https?:\/\//i.test(raw) ? cachedImageUrl(raw) : undefined
}

/**
 * v0.0.2：文章归属标签——标记它属于什么活动/分类/合集，点击跳转到对应栏目列表。
 * 详情/列表条目的 active/category/collection 数组含 name+mid（2026-08-08 实测）。
 */
function BelongTags({ detail }: { detail: ArticleDetail }): React.JSX.Element | null {
  const openList = useUiStore((s) => s.openList)
  const setSection = useUiStore((s) => s.setSection)
  const setRevealTarget = useUiStore((s) => s.setRevealTarget)
  const closeArticle = useReaderStore((s) => s.closeArticle)

  const items = useMemo(() => {
    const out: Array<{ kind: 'active' | 'category' | 'collection'; label: string; ref: MetaRef }> = []
    const act = detail.active?.[0]
    if (act && act.mid !== '' && act.name) out.push({ kind: 'active', label: '活动', ref: act })
    const cat = detail.category?.[0]
    if (cat && cat.mid !== '' && cat.name) out.push({ kind: 'category', label: '分类', ref: cat })
    const col = detail.collection?.[0]
    if (col && col.mid !== '' && col.name) out.push({ kind: 'collection', label: '合集', ref: col })
    return out
  }, [detail])

  if (items.length === 0) return null

  function openBelong(item: { kind: string; label: string; ref: MetaRef }): void {
    // 退出阅读态，否则 MainArea 会继续渲染 ReaderView（readingCid 优先于 listContext）
    closeArticle()
    // v0.0.2：左栏同步切换到对应栏目（活动/作品库/连载），并高亮目标节点
    const sectionMap: Record<string, 'activity' | 'library' | 'serial'> = {
      active: 'activity',
      category: 'library',
      collection: 'serial'
    }
    setSection(sectionMap[item.kind] ?? 'library')
    if (item.kind === 'active') {
      // v0.0.2：左栏定位到该文章标题（展开活动树 + 高亮文章节点）
      setRevealTarget({ section: 'activity', mid: item.ref.mid, cid: detail.cid })
      // 活动列表需要 phase 决定评分榜隔离；先查一次 activeStatus（缓存）
      const midKey = String(item.ref.mid)
      if (activePhaseCache) {
        openList({ title: item.ref.name!, mid: item.ref.mid, activityPhase: activePhaseCache[midKey] })
        return
      }
      void window.hqsf.listMetas('active').then((res) => {
        if (!res.ok) {
          openList({ title: item.ref.name!, mid: item.ref.mid })
          return
        }
        const cache: Record<string, ActivityPhase> = {}
        for (const m of res.data) cache[String(m.mid)] = activityPhase(m)
        activePhaseCache = cache
        openList({ title: item.ref.name!, mid: item.ref.mid, activityPhase: cache[midKey] })
      })
      return
    }
    openList({ title: item.ref.name!, mid: item.ref.mid })
  }

  return (
    <div className="reader-belong">
      {items.map((it) => (
        <button key={it.kind + String(it.ref.mid)} className="belong-tag" onClick={() => openBelong(it)} title={`打开「${it.ref.name}」`}>
          {it.label} · {it.ref.name}
        </button>
      ))}
    </div>
  )
}

/** 阅读视图：远端文章 HTML 正文 + 元信息；评审面板挂在右侧（v0.0.2 可拖动分栏，默认评审:正文 ≈ 1:2） */
export function ReaderView(): React.JSX.Element {
  const detail = useReaderStore((s) => s.detail)
  const detailLoading = useReaderStore((s) => s.detailLoading)
  const detailError = useReaderStore((s) => s.detailError)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const session = useAuthStore((s) => s.session)

  const [showReview, setShowReview] = useState(false)

  // v0.0.2：评审栏宽度比例（评审:总宽），默认 1/3（正文:评审 = 2:1），localStorage 持久化
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem('reader-split-ratio'))
    return v >= 0.2 && v <= 0.6 ? v : 1 / 3
  })
  const layoutRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    localStorage.setItem('reader-split-ratio', String(splitRatio))
  }, [splitRatio])

  // 拖动分栏
  function onDividerDown(e: React.MouseEvent): void {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => {
      const layout = layoutRef.current
      if (!layout) return
      const rect = layout.getBoundingClientRect()
      if (rect.width <= 0) return
      setSplitRatio(Math.min(0.6, Math.max(0.2, (rect.right - ev.clientX) / rect.width)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 打开新文章时默认收起评审面板
  useEffect(() => {
    setShowReview(false)
  }, [detail?.cid])

  const safeHtml = useMemo(() => (detail ? expandMediaTags(sanitizeHtml(detail.text)) : ''), [detail])
  const bodyRef = useRef<HTMLElement | null>(null)

  /** 导言：详情 introduction 优先；缺省时从当前列表缓存匹配同 cid 条目（列表接口实测含 introduction） */
  const intro = useMemo(() => {
    if (!detail) return ''
    const own = detail.introduction?.trim()
    if (own) return own
    const cached = useReaderStore.getState().list.find((it) => it.cid === detail.cid)
    return cached?.introduction?.trim() ?? ''
  }, [detail])

  /** 目录：正文注入后提取 h1-h6 标题（≥2 个才显示）。
   *  注意：React 对 dangerouslySetInnerHTML 每次提交都会重写 innerHTML，effect 捕获的节点会被
   *  detached，因此跳转时实时查询标题元素（索引与 toc 生成时一致，正文会话内稳定）。 */
  const [toc, setToc] = useState<Array<{ idx: number; level: number; text: string }>>([])
  useEffect(() => {
    const body = bodyRef.current
    if (!body) {
      setToc([])
      return
    }
    const items: Array<{ idx: number; level: number; text: string }> = []
    Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6')).forEach((h, i) => {
      const text = (h.textContent ?? '').trim()
      if (!text) return
      items.push({ idx: i, level: Number(h.tagName.slice(1)), text })
    })
    setToc(items)
  }, [safeHtml, detail?.cid])

  function jumpTo(idx: number): void {
    const body = bodyRef.current
    const scroller = body?.closest('.reader-main')
    if (!body || !scroller) return
    const el = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'))[idx]
    if (!el) return
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTo({ top, behavior: 'smooth' })
  }

  // 横长图处理：宽/高比 ≥ 2 的图放大高度、宽度溢出裁掉（object-fit: cover 由 CSS 实现）
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const imgs = Array.from(body.querySelectorAll('img'))
    if (imgs.length === 0) return
    const markWide = (img: HTMLImageElement): void => {
      if (img.naturalWidth > 0 && img.naturalWidth / img.naturalHeight >= 2) {
        img.classList.add('reader-img-wide')
      }
    }
    for (const img of imgs) {
      if (img.complete) markWide(img)
      else img.addEventListener('load', () => markWide(img), { once: true })
    }
  }, [safeHtml, detail?.cid])

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
      <div className="reader-layout" ref={layoutRef}>
        <div className="reader-main">
          <header className="reader-header">
            {/* v0.0.2：左侧内容区（标题 + meta + 归属标签） */}
            <div className="reader-header-left">
              <div className="reader-header-top">
                <h1 className="reader-title">{detail.title}</h1>
              </div>
              <div className="reader-meta">
                <span className="reader-author">
                  {authorAvatar(detail) ? (
                    <img className="reader-author-avatar" src={authorAvatar(detail)} alt="" referrerPolicy="no-referrer" />
                  ) : null}
                  {authorName(detail)}
                </span>
                {detail.size ? <span>· {formatSize(detail.size)} 字</span> : null}
                {detail.views ? <span>· {detail.views} 阅读</span> : null}
                {detail.likes ? <span>· {detail.likes} 赞</span> : null}
                {detail.created ? <span>· {formatTs(detail.created)}</span> : null}
              </div>
              {/* v0.0.2：文章归属（活动/分类/合集），点击跳转 */}
              <BelongTags detail={detail} />
            </div>
            {/* v0.0.2：右侧操作区——上下排布（大号评分在上、评审按钮在下），与左侧整体等高 */}
            <div className="reader-header-actions">
              {detail.score && detail.score !== '-.-' ? (
                <span
                  className="reader-score-big"
                  style={{ color: scoreColor(detail.score) ?? undefined }}
                  title="评分"
                >
                  评分 <b>{detail.score}</b>
                </span>
              ) : null}
              {!isMine && (
                <button className="review-toggle" onClick={() => setShowReview((v) => !v)}>
                  {showReview ? '收起评审' : '✎ 评审这篇文章'}
                </button>
              )}
              {/* v0.0.3：互动操作条（投币/点赞/收藏/分享） */}
              <ReaderInteractions detail={detail} />
            </div>
          </header>
          {intro && <div className="reader-intro">{intro}</div>}
          {toc.length >= 2 && (
            <details className="reader-toc">
              <summary>目录</summary>
              <ul className="reader-toc-list">
                {toc.map((t) => (
                  <li key={t.idx} className={`reader-toc-item lv-${Math.min(6, Math.max(1, t.level))}`}>
                    <a
                      href={`#toc-${t.idx + 1}`}
                      onClick={(e) => {
                        e.preventDefault()
                        jumpTo(t.idx)
                      }}
                    >
                      {t.text}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <article
            ref={bodyRef}
            className="reader-body"
            // 正文已经 sanitizeHtml 白名单净化，无脚本/事件/危险协议
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
          {/* v0.0.3：评论区（正文下方） */}
          <CommentSection cid={detail.cid} />
          <div className="reader-footer">
            <button className="toolbar-btn" onClick={closeArticle}>
              ← 返回列表
            </button>
          </div>
        </div>
        {!isMine && showReview && (
          <>
            {/* v0.0.2：可拖动分栏分隔条 */}
            <div className="reader-divider" onMouseDown={onDividerDown} title="拖动调整正文与评审栏比例" />
            <ReviewPanel splitRatio={splitRatio} />
          </>
        )}
      </div>
    </main>
  )
}

/** 五维表单默认值 */
function emptyForm() {
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

/** 解析逗号分隔五维分数串（顺序 dianzi,wenbi,jiezou,renwu,liyi）；非法返回 null */
function parseScoreParts(score?: string): number[] | null {
  if (!score) return null
  const parts = score.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return null
  return parts
}

/** 评审表单：五维 + auto-grow 编辑框 + 实时平均分预示（v0.0.2） */
function ReviewForm({
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
            placeholder={`${d.hint}（≥10 字）`}
            value={String(form[d.key])}
            onChange={(v) => setDim(d.key, v)}
          />
        </div>
      ))}
      <div className="review-form-dim">
        <div className="review-form-row">
          <span className="review-form-label">综合评价</span>
        </div>
        <AutoGrowTextarea
          placeholder="对作品的整体评价（选填）"
          value={form.zonghe}
          onChange={(v) => setDim('zonghe', v)}
        />
      </div>
      {/* v0.0.2：实时平均分预示 */}
      <div className="review-avg-preview">
        预计评分：<span className="review-avg-value">{avgPreview.toFixed(1)}</span>
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

/** auto-grow 编辑框：随内容自动变高、不显示滚动条、不可手动调整高度（v0.0.2） */
function AutoGrowTextarea({
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
    el.style.height = `${el.scrollHeight}px`
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

/** 评审条目（评者头像 + 五维 + 态度计数 + 评分着色；我的评审含编辑按钮） */
function ReviewItemCard({
  review,
  isMine,
  onEdit
}: {
  review: ReviewItem
  isMine: boolean
  onEdit?: () => void
}): React.JSX.Element {
  const setAttitude = useReaderStore((s) => s.setAttitude)
  const u = review.userJson ?? {}
  const rName = String(u.nickname ?? u.nick ?? u.nickName ?? u.name ?? `UID ${String(u.uid ?? review.uid ?? '')}`)
  const avatarRaw = String(u.avatar ?? u.headImg ?? u.headImgUrl ?? u.avatarUrl ?? '')
  const avatar = avatarRaw && /^https?:\/\//i.test(avatarRaw) ? cachedImageUrl(avatarRaw) : undefined
  const scoreColorValue = review.actualscore && review.actualscore !== '-.-' ? scoreColor(review.actualscore) : undefined
  return (
    <div className={`review-item ${isMine ? 'mine' : ''}`}>
      <div className="review-item-head">
        {avatar ? (
          <img className="review-item-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
        ) : null}
        <span className="review-item-author">{rName}</span>
        {review.isAi ? <span className="review-ai-tag">AI</span> : null}
        <span
          className="review-item-score"
          style={scoreColorValue ? { color: scoreColorValue } : undefined}
          title="评分（与文章评分同色规则）"
        >
          {review.actualscore && review.actualscore !== '-.-' ? `${review.actualscore} 分` : ''}
        </span>
      </div>
      <div className="review-dims">
        {[
          ['设定', review.dianzi],
          ['文笔', review.wenbi],
          ['人物', review.renwu],
          ['情节', review.jiezou],
          ['思想性', review.liyi]
        ].map(
          ([label, text]) =>
            text && (
              <div key={String(label)} className="review-dim">
                <span className="review-dim-label">{label}</span>
                <span className="review-dim-text">{text}</span>
              </div>
            )
        )}
        {review.zonghe && <div className="review-dim review-zonghe">综合：{review.zonghe}</div>}
      </div>
      <div className="review-item-actions">
        {[
          ['joy', '开心', 0],
          ['helpful', '有用', 1],
          ['earnest', '认真', 2]
        ].map(([key, label, type]) => (
          <button
            key={String(key)}
            className={`attitude-btn ${Number(review.attitudeType) === Number(type) ? 'active' : ''}`}
            onClick={() => void setAttitude(review.id, Number(type))}
            title={`表态：${String(label)}`}
          >
            {String(label)} {Number(review[key as 'joy']) > 0 ? Number(review[key as 'joy']) : ''}
          </button>
        ))}
        {isMine && onEdit && (
          <button className="attitude-btn review-edit-btn" onClick={onEdit} title="编辑我的评审">
            ✎ 编辑
          </button>
        )}
      </div>
    </div>
  )
}

/** 评审面板（v0.0.2）：「我的评审」/「所有评审」两个 tab + 排序 + 编辑模式 */
function ReviewPanel({ splitRatio }: { splitRatio: number }): React.JSX.Element {
  const reviews = useReaderStore((s) => s.reviews)
  const reviewsLoading = useReaderStore((s) => s.reviewsLoading)
  const submitting = useReaderStore((s) => s.submitting)
  const submitMessage = useReaderStore((s) => s.submitMessage)
  const clearSubmitMessage = useReaderStore((s) => s.clearSubmitMessage)
  const submit = useReaderStore((s) => s.submit)
  const reviewOrder = useReaderStore((s) => s.reviewOrder)
  const reviewOrderAsc = useReaderStore((s) => s.reviewOrderAsc)
  const setReviewOrder = useReaderStore((s) => s.setReviewOrder)
  const toggleReviewOrderAsc = useReaderStore((s) => s.toggleReviewOrderAsc)
  const detail = useReaderStore((s) => s.detail)
  const loadReviews = useReaderStore((s) => s.loadReviews)

  const [tab, setTab] = useState<'mine' | 'all'>('mine')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    clearSubmitMessage()
    setEditing(false)
    if (detail?.cid) void loadReviews(detail.cid)
  }, [detail?.cid, loadReviews, clearSubmitMessage])

  const myUid = String(useAuthStore.getState().session?.userinfo?.uid ?? '')
  const mine = reviews.filter((r) => myUid !== '' && String(r.uid ?? (r.userJson as Record<string, unknown> | undefined)?.uid ?? '') === myUid)
  const myReview = mine[0]
  const others = reviews.filter((r) => !mine.includes(r))

  return (
    <aside className="review-panel" style={{ width: `${splitRatio * 100}%` }}>
      <div className="review-panel-head">
        <h3>作品评审</h3>
        <span className="review-count">{reviews.length} 条</span>
      </div>

      {/* v0.0.2：「我的评审」/「所有评审」tab */}
      <div className="review-tabs">
        <button className={`review-tab ${tab === 'mine' ? 'active' : ''}`} onClick={() => setTab('mine')}>
          我的评审
        </button>
        <button className={`review-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
          所有评审
        </button>
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

      {tab === 'mine' ? (
        /* v0.0.2：已评审 → 展示与编辑二选一（不再同时显示表单）；
           未评审 → 显示新评审表单 */
        myReview ? (
          editing ? (
            <ReviewForm
              key={String(myReview.id)}
              cid={detail?.cid ?? ''}
              initial={myReview}
              submitting={submitting}
              onSubmit={async (payload) => {
                const activeid = detail?.active && detail.active.length > 0 ? detail.active[0].mid : 0
                const ok = await submit({ ...payload, activeid })
                if (ok) setEditing(false)
                return ok
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="review-list">
              <ReviewItemCard
                review={myReview}
                isMine
                onEdit={() => {
                  setEditing(true)
                  clearSubmitMessage()
                }}
              />
            </div>
          )
        ) : (
          <ReviewForm
            key="new"
            cid={detail?.cid ?? ''}
            submitting={submitting}
            onSubmit={async (payload) => {
              const activeid = detail?.active && detail.active.length > 0 ? detail.active[0].mid : 0
              return submit({ ...payload, activeid })
            }}
          />
        )
      ) : (
        <>
          {/* 所有评审：排序控件 + 其他用户评审 */}
          <div className="review-toolbar">
            <div className="review-orders">
              {REVIEW_ORDERS.map((o) => (
                <button
                  key={o.key}
                  className={`review-order-btn ${reviewOrder === o.key ? 'active' : ''}`}
                  onClick={() => setReviewOrder(o.key)}
                >
                  {o.label}
                </button>
              ))}
              <button
                className={`review-order-btn review-dir-btn ${reviewOrderAsc ? 'asc' : ''}`}
                onClick={toggleReviewOrderAsc}
                title={reviewOrderAsc ? '当前升序（小→大），点击切回降序' : '当前降序（大→小），点击切换为升序'}
              >
                {reviewOrderAsc ? '↑' : '↓'}
              </button>
            </div>
          </div>
          <div className="review-list">
            {reviewsLoading && <div className="muted review-loading">加载评审中 …</div>}
            {!reviewsLoading && others.length === 0 && (
              <div className="muted review-empty">{reviews.length === 0 ? '还没有人评审，来抢沙发吧' : '（暂无其他用户评审）'}</div>
            )}
            {others.map((r) => (
              <ReviewItemCard key={String(r.id)} review={r} isMine={false} />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
