import { useEffect, useMemo, useRef, useState } from 'react'
import { REVIEW_ORDERS, useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { activityPhase, type ActivityPhase } from '../lib/activity'
import { cachedImageUrl, formatSize, formatTs, expandMediaTags, sanitizeHtml, scoreColor } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import { CommentSection, CommentCard, ridOf } from './ReaderComments'
import { ReaderInteractions } from './ReaderInteractions'
import { ArrowDown, ArrowUp, MessageCircle, PenLine, X } from 'lucide-react'
import type { ArticleDetail, CommentItem, MetaRef, ReviewItem, ReviewPayload } from '../../../shared/types'

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

  // v0.0.3：右栏（目录/评论/评审）展开与 tab 由 ui store 管理（顶栏「展开右栏」按钮切换）
  const panelOpen = useUiStore((s) => s.readerPanelOpen)

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
                <button
                  className="review-toggle"
                  onClick={() => {
                    if (!panelOpen) useUiStore.getState().toggleReaderPanel()
                    useUiStore.getState().setReaderPanelTab('review')
                  }}
                  title="在右栏查看与撰写评审"
                >
                  <PenLine size={14} /> 评审
                </button>
              )}
            </div>
          </header>
          {intro && <div className="reader-intro">{intro}</div>}
          {/* v0.0.3：目录已移入右栏 tab；正文下方评论区已移入右栏 tab */}
          <article
            ref={bodyRef}
            className="reader-body"
            // 正文已经 sanitizeHtml 白名单净化，无脚本/事件/危险协议
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
          {/* v0.0.3：互动悬浮按钮组（投币/点赞/收藏/分享 + 置顶，右下角）；返回列表已移到顶栏 */}
          <ReaderInteractions detail={detail} />
        </div>
        {panelOpen && (
          <>
            {/* v0.0.2：可拖动分栏分隔条（正文:右栏比例，默认 1:2） */}
            <div className="reader-divider" onMouseDown={onDividerDown} title="拖动调整正文与右栏比例" />
            {/* v0.0.3：右栏 tab 容器（目录 / 评论 / 评审） */}
            <ReaderPanel splitRatio={splitRatio} toc={toc} jumpTo={jumpTo} isMine={isMine} />
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

/** 评审条目（评者头像 + 五维 + 态度计数 + 评分着色；v0.0.3 加「回复评审/查看评审评论」；我的评审含编辑按钮） */
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
  // v0.0.5：评审评论内嵌于卡片，默认收起（点击「评论 N」展开/收起；「回复评审」展开并聚焦回复框）
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [replyIntent, setReplyIntent] = useState(false)
  const u = review.userJson ?? {}
  const rName = String(u.nickname ?? u.nick ?? u.nickName ?? u.name ?? `UID ${String(u.uid ?? review.uid ?? '')}`)
  const avatarRaw = String(u.avatar ?? u.headImg ?? u.headImgUrl ?? u.avatarUrl ?? '')
  const avatar = avatarRaw && /^https?:\/\//i.test(avatarRaw) ? cachedImageUrl(avatarRaw) : undefined
  const scoreColorValue = review.actualscore && review.actualscore !== '-.-' ? scoreColor(review.actualscore) : undefined
  // v0.0.5：review.score 为五维分数逗号分隔（如 "9,9,8,8,6"），顺序对应
  // 设定/文笔/人物/情节/思想性；无评分（"-.-" 或位数不足）时整体不展示分数
  const dimScores = useMemo(() => {
    const raw = String(review.score ?? '').trim()
    if (!raw || raw.includes('-.-')) return null
    const parts = raw.split(',').map((s) => Number(s.trim()))
    return parts.length === 5 && parts.every((n) => Number.isFinite(n)) ? parts : null
  }, [review.score])
  // v0.0.5：关联该评审的评论数（0 时隐藏「查看评审评论」按钮）
  const commentCount = Number(review.replyNum) || 0
  return (
    <div className={`review-item ${isMine ? 'mine' : ''}`} data-review-id={String(review.id)}>
      <div className="review-item-head">
        {avatar ? (
          <img className="review-item-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
        ) : null}
        {/* v0.0.5：头像右侧 meta 分组——评审者名字一行，下方一行评审发布时间 */}
        <div className="review-item-meta">
          <div className="review-item-meta-top">
            <span className="review-item-author">{rName}</span>
            {review.isAi ? <span className="review-ai-tag">AI</span> : null}
          </div>
          {review.created ? <span className="review-item-time">{formatTs(Number(review.created))}</span> : null}
        </div>
        <span
          className="review-item-score"
          style={scoreColorValue ? { color: scoreColorValue } : undefined}
          title="评分（与文章评分同色规则）"
        >
          {review.actualscore && review.actualscore !== '-.-' ? `${review.actualscore} 分` : ''}
        </span>
      </div>
      <div className="review-dims">
        {(
          [
            ['设定', review.dianzi, 0],
            ['文笔', review.wenbi, 1],
            ['人物', review.renwu, 2],
            ['情节', review.jiezou, 3],
            ['思想性', review.liyi, 4]
          ] as Array<[string, string, number]>
        ).map(
          ([label, text, idx]) =>
            text && (
              <div key={String(label)} className="review-dim">
                <span className="review-dim-label">
                  {label}
                  {/* v0.0.5：维度名后跟此项分数（取自 review.score，无评分不显示） */}
                  {dimScores && <span className="review-dim-score"> {dimScores[idx]}</span>}
                </span>
                <span className="review-dim-text">{text}</span>
              </div>
            )
        )}
        {review.zonghe && (
          <div className="review-dim review-zonghe">
            <span className="review-dim-label">综合</span>
            <span className="review-dim-text">{review.zonghe}</span>
          </div>
        )}
      </div>
      <div className="review-item-actions">
        {/* v0.0.5：态度按钮 emoji 化（Discord「添加反应」风格：emoji + 计数） */}
        {[
          ['joy', '😄', '开心', 0],
          ['helpful', '👍', '有用', 1],
          ['earnest', '🧐', '认真', 2]
        ].map(([key, emoji, label, type]) => {
          const count = Number(review[key as 'joy']) || 0
          return (
            <button
              key={String(key)}
              className={`attitude-btn attitude-emoji ${Number(review.attitudeType) === Number(type) ? 'active' : ''}`}
              onClick={() => void setAttitude(review.id, Number(type))}
              title={`表态：${String(label)}${count > 0 ? `（${count}）` : ''}`}
            >
              <span className="attitude-emoji-glyph">{emoji}</span>
              {count > 0 ? <span className="attitude-count">{count}</span> : null}
            </button>
          )
        })}
        {isMine && onEdit && (
          <button className="attitude-btn review-edit-btn" onClick={onEdit} title="编辑我的评审">
            <PenLine size={12} /> 编辑
          </button>
        )}
        {/* v0.0.6：评论评审（合并原「回复评审」+「查看评审评论」）——
            展开/收起卡片内评论区并聚焦回复框，显示评论数量 */}
        <button
          className={`attitude-btn review-comments-btn ${commentsOpen ? 'active' : ''}`}
          onClick={() =>
            setCommentsOpen((v) => {
              const next = !v
              if (next) setReplyIntent(true)
              return next
            })
          }
          title={
            commentsOpen
              ? '收起评审评论'
              : commentCount > 0
                ? `查看/回复这条评审的评论（${commentCount} 条）`
                : '评论这条评审'
          }
        >
          <MessageCircle size={13} />
          {commentCount > 0 ? <span className="review-comments-count">{commentCount}</span> : null}
        </button>
      </div>
      {/* v0.0.5：评审评论内嵌区（默认收起；包含回复框与评论列表） */}
      {commentsOpen && (
        <ReviewInlineComments
          review={review}
          autoFocusReply={replyIntent}
          onReplyFocused={() => setReplyIntent(false)}
        />
      )}
    </div>
  )
}

/**
 * v0.0.5：评审卡片内嵌评论（展开/收起由 ReviewItemCard 控制）：
 * 该评审的评论列表（含楼中楼）+ 回复框（提交带 reviewid）；
 * 评论数据来自 store.comments（按 cid 全局加载，此处按 reviewid 过滤）。
 */
function ReviewInlineComments({
  review,
  autoFocusReply,
  onReplyFocused
}: {
  review: ReviewItem
  autoFocusReply?: boolean
  onReplyFocused?: () => void
}): React.JSX.Element {
  const comments = useReaderStore((s) => s.comments)
  const commentSubmitting = useReaderStore((s) => s.commentSubmitting)
  const commentMessage = useReaderStore((s) => s.commentMessage)
  const clearCommentMessage = useReaderStore((s) => s.clearCommentMessage)
  const submitComment = useReaderStore((s) => s.submitComment)
  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session
  const cid = useReaderStore((s) => s.detail)?.cid ?? ''
  const rid = String(review.id)

  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const replyBoxRef = useRef<HTMLTextAreaElement | null>(null)

  // 该评审的顶层评论（子评论按 parent 归属，不依赖子评论自身的 reviewid）
  const reviewTop = useMemo(
    () => comments.filter((c) => ridOf(c) === rid && (String(c.parent) === '0' || c.parent == null)),
    [comments, rid]
  )
  const childrenOf = (coid: number | string): CommentItem[] =>
    comments.filter((c) => String(c.parent) === String(coid))

  // 通过「回复评审」按钮进入时聚焦回复框
  useEffect(() => {
    if (autoFocusReply) {
      replyBoxRef.current?.focus()
      onReplyFocused?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const text = draft.trim()
    if (text.length < 4) {
      setLocalErr(`评论内容至少 4 个字（当前 ${text.length} 字）`)
      return
    }
    setLocalErr(null)
    const ok = await submitComment({ cid, text, parent: replyTo?.coid, reviewid: rid })
    if (ok) {
      setDraft('')
      setReplyTo(null)
    }
  }

  return (
    <div className="review-inline-comments">
      {commentMessage && (
        <div className={commentMessage.startsWith('评论发布失败') ? 'reader-comments-err' : 'reader-comments-msg'}>
          {commentMessage}
          <button className="dismiss" onClick={clearCommentMessage} title="关闭">
            <X size={12} />
          </button>
        </div>
      )}
      {loggedIn ? (
        <form className="comment-form" onSubmit={(e) => void handleSubmit(e)}>
          <textarea
            ref={replyBoxRef}
            className="comment-input"
            rows={2}
            value={draft}
            placeholder={replyTo ? `回复 @${replyTo.author}（≥4 字）` : '评论这条评审…（≥4 字）'}
            onChange={(e) => {
              setDraft(e.target.value)
              setLocalErr(null)
            }}
          />
          <div className="comment-form-actions">
            {replyTo && (
              <button type="button" className="comment-cancel-reply" onClick={() => setReplyTo(null)}>
                取消回复
              </button>
            )}
            {localErr && <span className="comment-local-err">{localErr}</span>}
            <button type="submit" className="comment-submit" disabled={commentSubmitting}>
              {commentSubmitting ? '提交中 …' : '发表评论'}
            </button>
          </div>
        </form>
      ) : (
        <div className="comment-login-hint">登录后可评论这条评审</div>
      )}
      <div className="comment-list">
        {reviewTop.length === 0 && <div className="muted comment-empty">还没有评论这条评审的评论</div>}
        {reviewTop.map((c) => (
          <div key={String(c.coid)} className="comment-item">
            <CommentCard comment={c} onReply={() => setReplyTo(c)} />
            {childrenOf(c.coid).length > 0 && (
              <div className="comment-sub-list">
                {childrenOf(c.coid).map((sub) => (
                  <div key={String(sub.coid)} className="comment-item comment-sub">
                    <CommentCard comment={sub} onReply={() => setReplyTo(sub)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 评审面板（v0.0.2）：「我的评审」/「所有评审」两个 tab + 排序 + 编辑模式（v0.0.3 移入右栏 tab 容器） */
function ReviewPanel(): React.JSX.Element {
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
    <aside className="review-panel">
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
            <X size={12} />
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
                {reviewOrderAsc ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
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

/**
 * v0.0.3：阅读页右栏 tab 容器（目录 / 评论 / 评审）。
 * 宽度由拖动分栏比例控制（ReaderView splitRatio）；评审 tab 对本人文章隐藏。
 */
function ReaderPanel({
  splitRatio,
  toc,
  jumpTo,
  isMine
}: {
  splitRatio: number
  toc: Array<{ idx: number; level: number; text: string }>
  jumpTo: (idx: number) => void
  isMine: boolean
}): React.JSX.Element {
  const tab = useUiStore((s) => s.readerPanelTab)
  const setTab = useUiStore((s) => s.setReaderPanelTab)
  const cid = useReaderStore((s) => s.detail)?.cid ?? ''

  return (
    <aside className="reader-panel" style={{ width: `${splitRatio * 100}%` }}>
      <div className="reader-panel-tabs">
        <button className={`reader-panel-tab ${tab === 'toc' ? 'active' : ''}`} onClick={() => setTab('toc')}>
          目录
        </button>
        <button
          className={`reader-panel-tab ${tab === 'comments' ? 'active' : ''}`}
          onClick={() => setTab('comments')}
        >
          评论
        </button>
        {!isMine && (
          <button className={`reader-panel-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
            评审
          </button>
        )}
      </div>

      {tab === 'toc' && (
        <div className="reader-panel-scroll">
          {toc.length === 0 ? (
            <div className="muted reader-toc-empty">（本文没有目录）</div>
          ) : (
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
          )}
        </div>
      )}

      {tab === 'comments' && (
        <div className="reader-panel-scroll">
          <CommentSection cid={cid} />
        </div>
      )}

      {tab === 'review' &&
        (isMine ? (
          <div className="reader-panel-scroll">
            <div className="muted review-empty">这是你自己的文章，无需评审。</div>
          </div>
        ) : (
          <ReviewPanel />
        ))}
    </aside>
  )
}
