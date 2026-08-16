import { useEffect, useRef, useState } from 'react'
import { useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { ArticleCard } from './ArticleListView'
import { ErrorBanner } from './ErrorBanner'
import { SkeletonArticleCard, SkeletonFeedCard } from './Skeletons'
import { CommentFeedCard, ReviewFeedCard } from './FeedCards'
import { ACTIVITY_PHASE_LABEL, activityPhase, sortActivities } from '../lib/activity'
import type { ApiResult, CommentItem, MetaInfo, RemoteArticle, ReviewItem } from '../../../shared/types'

/**
 * 推荐栏目首页（v0.0.2）：点击左栏「推荐」顶层（未选中子项）时显示，
 * 类似荒启 h5 首页：置顶文章区 + 最新发布流。
 * v0.0.8：置顶文章与最新发布之间插入「最新评审」「最新讨论」信息流——
 * 卡片以用户为主体（头像+昵称+时间），评审卡片展示综合评价；
 * 卡片主体点击跳转到对应文章的评审 / 评论；卡片内评论/回复按钮就地展开编辑框快速回复。
 */

/**
 * v0.0.8：信息流卡片内的快速回复编辑框（样式对齐文章页评审卡片的回复框）。
 * 只提供编辑框本体，不展示他人回复；提交成功后短暂提示并自动收起，失败展示错误文案。
 */
function FeedReplyEditor({
  loggedIn,
  placeholder,
  loginHint,
  onCancel,
  onSubmit
}: {
  loggedIn: boolean
  placeholder: string
  loginHint: string
  onCancel: () => void
  onSubmit: (text: string) => Promise<{ ok: boolean; error?: string }>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const timerRef = useRef<number | null>(null)
  // v0.0.8.6：卸载时清理自动收起定时器，避免竞态关闭其他卡片已打开的编辑框
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    []
  )

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const text = draft.trim()
    if (text.length < 4) {
      setErr(`评论内容至少 4 个字（当前 ${text.length} 字）`)
      return
    }
    setErr(null)
    setSubmitting(true)
    const res = await onSubmit(text)
    setSubmitting(false)
    if (res.ok) {
      setDone(true)
      timerRef.current = window.setTimeout(onCancel, 1200)
    } else if (res.error) {
      setErr(res.error)
    }
  }

  if (!loggedIn) {
    return (
      <div className="home-feed-editor">
        <div className="home-feed-editor-login">{loginHint}</div>
      </div>
    )
  }
  return (
    <div className="home-feed-editor">
      <form className="comment-form" onSubmit={(e) => void handleSubmit(e)}>
        <textarea
          className="comment-input"
          rows={2}
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value)
            setErr(null)
          }}
        />
        <div className="comment-form-actions">
          {done && <span className="home-feed-editor-ok">评论已提交，感谢参与</span>}
          {err && <span className="comment-local-err">{err}</span>}
          <button type="submit" className="comment-submit" disabled={submitting}>
            {submitting ? '提交中 …' : '发表评论'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * 推荐首页轮播图：展示进行中/评审中的活动。
 * 简单实现：自动轮播 + 左右箭头 + 圆点；点击幻灯片进入对应活动列表。
 */
function ActivityCarousel({ items, onOpen }: { items: MetaInfo[]; onOpen: (m: MetaInfo) => void }): React.JSX.Element | null {
  const [index, setIndex] = useState(0)
  const timerRef = useRef<number | null>(null)
  const count = items.length

  useEffect(() => {
    if (count <= 1) return
    timerRef.current = window.setInterval(() => {
      setIndex((i) => (i + 1) % count)
    }, 4500)
    return () => {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [count])

  useEffect(() => {
    if (index >= count) setIndex(0)
  }, [index, count])

  const pause = (): void => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const resume = (): void => {
    if (count <= 1 || timerRef.current != null) return
    timerRef.current = window.setInterval(() => {
      setIndex((i) => (i + 1) % count)
    }, 4500)
  }

  if (count === 0) return null

  return (
    <section className="home-section activity-carousel-section">
      <div
        className="activity-carousel"
        onMouseEnter={pause}
        onMouseLeave={resume}
        onFocus={pause}
        onBlur={resume}
      >
        <div className="activity-carousel-track" style={{ transform: `translateX(-${index * 100}%)` }}>
          {items.map((m) => {
            const phase = activityPhase(m)
            return (
              <button
                key={String(m.mid)}
                type="button"
                className="activity-carousel-slide"
                onClick={() => onOpen(m)}
                style={{
                  backgroundImage: m.imgurl
                    ? `linear-gradient(90deg, rgba(15,23,42,0.76), rgba(15,23,42,0.18)), url("${m.imgurl}")`
                    : 'linear-gradient(120deg, #4A6CF7, #7C3AED)'
                }}
              >
                <span className="activity-carousel-content">
                  <span className={`activity-badge phase-${phase}`}>{ACTIVITY_PHASE_LABEL[phase]}</span>
                  <span className="activity-carousel-name">{m.name}</span>
                  {m.description ? <span className="activity-carousel-desc">{m.description}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
        {count > 1 && (
          <>
            <button
              type="button"
              className="activity-carousel-arrow prev"
              aria-label="上一个活动"
              onClick={() => setIndex((index - 1 + count) % count)}
            >
              ‹
            </button>
            <button
              type="button"
              className="activity-carousel-arrow next"
              aria-label="下一个活动"
              onClick={() => setIndex((index + 1) % count)}
            >
              ›
            </button>
            <div className="activity-carousel-dots">
              {items.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`activity-carousel-dot${i === index ? ' active' : ''}`}
                  aria-label={`第 ${i + 1} 个活动`}
                  onClick={() => setIndex(i)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}


export function RecommendHome(): React.JSX.Element {
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)
  const loadReviewTasks = useReaderStore((s) => s.loadReviewTasks)
  // v0.0.7：「已评审」徽章数据——本人评审过该文章（登录/挂载时一次拉全）
  const myReviewedCids = useReaderStore((s) => s.myReviewedCids)
  // v0.0.8：深链目标 + 右栏 tab 切换
  const setTarget = useReaderStore((s) => s.setTarget)
  const openPanelTab = useUiStore((s) => s.openPanelTab)
  const openUserPage = useUiStore((s) => s.openUserPage)
  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const [top, setTop] = useState<RemoteArticle[]>([])
  const [latest, setLatest] = useState<RemoteArticle[]>([])
  // v0.0.8：最新评审 / 最新讨论（全局信息流）
  const [recentReviews, setRecentReviews] = useState<ReviewItem[]>([])
  const [recentComments, setRecentComments] = useState<CommentItem[]>([])
  // 推荐首页轮播：进行中/评审中的活动
  const [activeMetas, setActiveMetas] = useState<MetaInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 登录后全局拉一次评审任务（红点/卡片标记共用）
  useEffect(() => {
    void loadReviewTasks()
  }, [loadReviewTasks])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      // 置顶文章：contentsList searchParams={istop:1,type:'post'}（v0.0.9 补 type 过滤草稿——
      // 服务端对草稿条目也返回 istop=1 且 status=publish，不按 type 过滤会把同名草稿一起置顶）
      window.hqsf.listRemoteArticles({ searchParams: { istop: 1, type: 'post' }, limit: 6, order: 'created' }),
      // 最新发布流
      window.hqsf.listRemoteArticles({ searchParams: { type: 'post' }, limit: 12, order: 'created' }),
      // v0.0.8：最新评审（全局 reviewList，按时间倒序）
      window.hqsf.listReviews({ limit: 8, order: 'created' }),
      // v0.0.8：最新讨论（全局 commentsList，按时间倒序）。
      // 主进程/preload 改动需重启应用才生效：新 preload 配旧主进程时 invoke 会 reject，
      // 由下方 .catch 降级为空数据；此处守卫只兜底 preload 本身未带该方法的情况
      ((): Promise<ApiResult<{ items: CommentItem[]; total: number }>> =>
        typeof window.hqsf.listRecentComments === 'function'
          ? window.hqsf.listRecentComments({ limit: 8 })
          : Promise.resolve({ ok: false as const, error: '接口未就绪' }))(),
      // 推荐首页轮播：进行中/评审中的活动（失败时降级为空轮播，不影响首页主体）
      window.hqsf.listMetas('active').catch(() => ({ ok: false as const, error: '活动加载失败' }))
    ])
      .then(([t, l, rv, cm, am]) => {
        if (!alive) return
        const topItems = t.ok ? t.data.items : []
        const latestItems = l.ok ? l.data.items : []
        setTop(topItems)
        setLatest(latestItems)
        setRecentReviews(rv.ok ? rv.data.items : [])
        setRecentComments(cm.ok ? cm.data.items : [])
        // 只保留进行中/评审中的活动作为轮播内容
        const carouselItems = am.ok
          ? sortActivities(am.data).filter((m) => {
              const p = activityPhase(m)
              return p === 'ongoing' || p === 'reviewing'
            })
          : []
        setActiveMetas(carouselItems.slice(0, 6))
        // v0.0.6+：上报首页文章合集供右栏搜索
        useReaderStore.getState().setHomeList([...topItems, ...latestItems])
        // v0.0.8.6：错误横幅只由主体请求（置顶/最新发布）触发；信息流失败静默降级为空栏目
        const errs = [t, l].filter((r) => !r.ok).map((r) => r.error)
        setError(errs[0] ?? null)
        setLoading(false)
      })
      .catch((err) => {
        if (!alive) return
        setError((err as Error).message)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * v0.0.8：信息流点击 → 打开对应文章 + 切到目标右栏 tab + 设置深链定位目标。
   * tab: 'review'（评审面板）/ 'comments'（评论面板）
   */
  function openFeedItem(
    cid: string,
    tab: 'review' | 'comments',
    target: { reviewId?: string; commentId?: string }
  ): void {
    setTarget({ cid, ...target })
    void openArticle(cid)
    openPanelTab(tab)
  }

  /** 轮播活动点击：切到「活动」栏目并打开对应活动列表 */
  function openActivity(m: MetaInfo): void {
    useReaderStore.getState().closeArticle()
    const ui = useUiStore.getState()
    ui.setSection('activity')
    ui.openList({ title: m.name, mid: m.mid, activityPhase: activityPhase(m), meta: m })
  }

  // v0.0.8：就地展开的回复编辑框目标（同一时间最多展开一个）
  const [editor, setEditor] = useState<{ kind: 'review' | 'comment'; id: string } | null>(null)

  /** 评论一条评审（就地编辑框提交；成功后本地评论数 +1） */
  async function submitReviewComment(r: ReviewItem, text: string): Promise<{ ok: boolean; error?: string }> {
    const res = await window.hqsf.addComment({ cid: String(r.cid ?? ''), text, reviewid: String(r.id) })
    if (res.ok && res.data.ok) {
      // v0.0.8.6：计数本地 +1 仅会话内展示；首次评论可能进审核，服务端为准
      setRecentReviews((list) =>
        list.map((item) =>
          String(item.id) === String(r.id) ? { ...item, replyNum: (Number(item.replyNum) || 0) + 1 } : item
        )
      )
      return { ok: true }
    }
    return { ok: false, error: res.ok ? res.data.error : res.error }
  }

  /** 回复一条评论（就地编辑框提交） */
  async function submitCommentReply(c: CommentItem, text: string): Promise<{ ok: boolean; error?: string }> {
    const reviewid =
      c.reviewid != null && String(c.reviewid) !== '' && String(c.reviewid) !== '0' ? String(c.reviewid) : undefined
    const res = await window.hqsf.addComment({ cid: String(c.cid ?? ''), text, parent: c.coid, reviewid })
    if (res.ok && res.data.ok) return { ok: true }
    return { ok: false, error: res.ok ? res.data.error : res.error }
  }

  return (
    <div className="home-view">
      {error && <ErrorBanner title="首页加载失败" message={error} />}

      {loading ? (
        // v0.0.7：预填充骨架——形状与加载完成后的页面同构（置顶 grid 卡 + 最新评审/讨论 feed 卡 + 最新列表卡）
        <>
          <span className="sr-only" role="status">加载中 …</span>
          {/* 活动轮播骨架：与真实轮播同高，减少加载后布局跳动 */}
          <section className="home-section activity-carousel-section">
            <div className="activity-carousel activity-carousel-skeleton" aria-hidden="true" />
          </section>
          <section className="home-section">
            <h2 className="home-section-title">置顶文章</h2>
            <div className="home-top-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonArticleCard key={i} />
              ))}
            </div>
          </section>
          {/* v0.0.9：最新评审 / 最新讨论骨架与真实结构同构（两栏网格，各 4 张，3 行内容高度） */}
          <section className="home-section home-feed-col">
            <h2 className="home-section-title">最新评审</h2>
            <div className="home-feed-list">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonFeedCard key={i} />
              ))}
            </div>
          </section>
          <section className="home-section home-feed-col">
            <h2 className="home-section-title">最新讨论</h2>
            <div className="home-feed-list">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonFeedCard key={i} />
              ))}
            </div>
          </section>
          <section className="home-section">
            <h2 className="home-section-title">最新发布</h2>
            <div className="home-list">
              {Array.from({ length: 12 }).map((_, i) => (
                <SkeletonArticleCard key={i} />
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          {activeMetas.length > 0 && <ActivityCarousel items={activeMetas} onOpen={openActivity} />}

          {top.length > 0 && (
            <section className="home-section">
              <h2 className="home-section-title">置顶文章</h2>
              <div className="home-top-grid">
                {top.map((a) => (
                  <ArticleCard
                    key={a.cid}
                    article={a}
                    active={readingCid === a.cid}
                    taskStatus={reviewTaskByCid[a.cid]}
                    reviewed={myReviewedCids[a.cid] === true}
                    onOpen={() => void openArticle(a.cid)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* v0.0.8：最新评审 / 最新讨论——两栏目上下堆叠，内部卡片两栏（前 4 条，等高截断） */}
          <div className="home-feed-columns">
            {/* 最新评审——用户为主体，内容展示综合评价（非设定评语） */}
            <section className="home-section home-feed-col">
              <h2 className="home-section-title">最新评审</h2>
              <div className="home-feed-list">
                {recentReviews.length === 0 && <div className="list-empty muted">（暂无评审）</div>}
                {recentReviews.slice(0, 4).map((r) => {
                  const editorOpen = editor?.kind === 'review' && editor.id === String(r.id)
                  return (
                    <ReviewFeedCard
                      key={String(r.id)}
                      review={r}
                      editing={editorOpen}
                      onOpen={() => openFeedItem(String(r.cid ?? ''), 'review', { reviewId: String(r.id) })}
                      onOpenUser={() => {
                        const uid = String(r.uid ?? (r.userJson as Record<string, unknown> | undefined)?.uid ?? '')
                        if (uid !== '' && uid !== '0') openUserPage(uid)
                      }}
                      onComment={() => setEditor(editorOpen ? null : { kind: 'review', id: String(r.id) })}
                      footer={
                        editorOpen ? (
                          <FeedReplyEditor
                            loggedIn={loggedIn}
                            placeholder="评论这条评审…（≥4 字）"
                            loginHint="登录后可评论这条评审"
                            onCancel={() => setEditor(null)}
                            onSubmit={(text) => submitReviewComment(r, text)}
                          />
                        ) : undefined
                      }
                    />
                  )
                })}
              </div>
            </section>

            {/* 最新讨论——用户为主体；普通评论跳文章评论区，评审讨论跳该评审的评论并展开 */}
            <section className="home-section home-feed-col">
              <h2 className="home-section-title">最新讨论</h2>
              <div className="home-feed-list">
                {recentComments.length === 0 && <div className="list-empty muted">（暂无讨论）</div>}
                {recentComments.slice(0, 4).map((c) => {
                  const rid =
                    c.reviewid != null && String(c.reviewid) !== '' && String(c.reviewid) !== '0'
                      ? String(c.reviewid)
                      : null
                  const editorOpen = editor?.kind === 'comment' && editor.id === String(c.coid)
                  return (
                    <CommentFeedCard
                      key={String(c.coid)}
                      comment={c}
                      editing={editorOpen}
                      onOpen={() =>
                        openFeedItem(
                          String(c.cid ?? ''),
                          rid ? 'review' : 'comments',
                          rid ? { reviewId: rid, commentId: String(c.coid) } : { commentId: String(c.coid) }
                        )
                      }
                      onOpenUser={() => {
                        const uid = String(c.authorId ?? '')
                        if (uid !== '' && uid !== '0') openUserPage(uid)
                      }}
                      onReply={() => setEditor(editorOpen ? null : { kind: 'comment', id: String(c.coid) })}
                      footer={
                        editorOpen ? (
                          <FeedReplyEditor
                            loggedIn={loggedIn}
                            placeholder={`回复 @${c.author || '匿名'}（≥4 字）`}
                            loginHint={rid ? '登录后可回复这条评审讨论' : '登录后可回复这条评论'}
                            onCancel={() => setEditor(null)}
                            onSubmit={(text) => submitCommentReply(c, text)}
                          />
                        ) : undefined
                      }
                    />
                  )
                })}
              </div>
            </section>
          </div>

          <section className="home-section">
            <h2 className="home-section-title">最新发布</h2>
            <div className="home-list">
              {latest.length === 0 && <div className="list-empty muted">（暂无文章）</div>}
              {latest.map((a) => (
                <ArticleCard
                  key={a.cid}
                  article={a}
                  active={readingCid === a.cid}
                  taskStatus={reviewTaskByCid[a.cid]}
                  reviewed={myReviewedCids[a.cid] === true}
                  onOpen={() => void openArticle(a.cid)}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
