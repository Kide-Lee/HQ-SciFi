import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { ArticleCard } from './ArticleListView'
import { ErrorBanner } from './ErrorBanner'
import { SkeletonArticleCard, SkeletonFeedCard } from './Skeletons'
import { UserLevelBadge } from './UserLevelBadge'
import { anonymousAuthorDisplayName, cachedImageUrl, formatTs, userAvatarUrl, userDisplayName } from '../lib/sanitize'
import type { ApiResult, CommentItem, RemoteArticle, ReviewItem } from '../../../shared/types'

/**
 * 推荐栏目首页（v0.0.2）：点击左栏「推荐」顶层（未选中子项）时显示，
 * 类似荒启 h5 首页：置顶文章区 + 最新发布流。
 * v0.0.8：置顶文章与最新发布之间插入「最新评审」「最新讨论」信息流——
 * 卡片以用户为主体（头像+昵称+时间），评审卡片展示综合评价；
 * 卡片主体点击跳转到对应文章的评审 / 评论；卡片内评论/回复按钮就地展开编辑框快速回复。
 */

/** 从评审的 userJson 提取评者展示名（多字段容错，与评审卡片一致）。
 *  v0.0.9：匿名作者的文章下，评审者就是作者本人时统一显示「匿名用户」。
 *  优先用主进程为全局评审流补全的 articleAuthorId/articleIsAnonymous；
 *  其次用评审流自带的 articleInfo（contentJson）；最后回退首页已加载的文章条目。 */
function reviewerName(r: ReviewItem, homeArticle?: RemoteArticle): string {
  const raw = userDisplayName(r.userJson, `UID ${String(r.uid ?? '')}`)
  if (r.articleAuthorId != null || r.articleIsAnonymous != null) {
    return anonymousAuthorDisplayName(
      { authorId: r.articleAuthorId, isAnonymous: r.articleIsAnonymous },
      r.uid,
      raw
    )
  }
  if (homeArticle) {
    return anonymousAuthorDisplayName(homeArticle, r.uid, raw)
  }
  const info = r.articleInfo as Record<string, unknown> | undefined
  return anonymousAuthorDisplayName(
    info
      ? {
          authorId: typeof info.authorId === 'string' || typeof info.authorId === 'number' ? info.authorId : undefined,
          isAnonymous: info.isAnonymous as boolean | number | string | undefined
        }
      : null,
    r.uid,
    raw
  )
}

/** 从评审的 userJson 提取评者头像（仅 http(s) 走缓存协议） */
function reviewerAvatar(r: ReviewItem): string | undefined {
  const url = userAvatarUrl(r.userJson)
  return url ? cachedImageUrl(url) : undefined
}

/** 从评审的 articleInfo（contentJson）提取文章标题 */
function reviewArticleTitle(r: ReviewItem): string {
  const info = r.articleInfo as Record<string, unknown> | undefined
  return String(info?.title ?? info?.contenTitle ?? '')
}

/** 头像或昵称首字占位（用户为主体，无头像也要有归属感） */
function Avatar({ src, name }: { src?: string; name: string }): React.JSX.Element {
  if (src) {
    return <img className="home-feed-avatar" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
  }
  return <span className="home-feed-avatar home-feed-avatar-fallback">{[...name][0] || '?'}</span>
}

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
  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const [top, setTop] = useState<RemoteArticle[]>([])
  const [latest, setLatest] = useState<RemoteArticle[]>([])
  // v0.0.8：最新评审 / 最新讨论（全局信息流）
  const [recentReviews, setRecentReviews] = useState<ReviewItem[]>([])
  const [recentComments, setRecentComments] = useState<CommentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // v0.0.9：首页已加载文章（置顶+最新发布）按 cid 索引，供最新讨论/评审卡片
  // 在全局流未携带所属文章匿名/作者信息时兜底判断「匿名作者本人评论/评审」
  const homeArticleById = useMemo(() => {
    const m = new Map<string, RemoteArticle>()
    for (const a of [...top, ...latest]) m.set(String(a.cid), a)
    return m
  }, [top, latest])

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
          : Promise.resolve({ ok: false as const, error: '接口未就绪' }))()
    ])
      .then(([t, l, rv, cm]) => {
        if (!alive) return
        const topItems = t.ok ? t.data.items : []
        const latestItems = l.ok ? l.data.items : []
        setTop(topItems)
        setLatest(latestItems)
        setRecentReviews(rv.ok ? rv.data.items : [])
        setRecentComments(cm.ok ? cm.data.items : [])
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
                  const name = reviewerName(r, homeArticleById.get(String(r.cid ?? '')))
                  // v0.0.9：无综合评价时回退展示设定评价（dianzi）
                  const content = String(r.zonghe ?? '').trim() || String(r.dianzi ?? '').trim()
                  const title = reviewArticleTitle(r)
                  const editorOpen = editor?.kind === 'review' && editor.id === String(r.id)
                  return (
                    <div key={String(r.id)} className={`home-feed-card${editorOpen ? ' editing' : ''}`}>
                      {/* 卡片主体：点击跳转到对应文章评审 */}
                      <button
                        className="home-feed-main"
                        onClick={() => openFeedItem(String(r.cid ?? ''), 'review', { reviewId: String(r.id) })}
                        title={`查看《${title || String(r.cid ?? '')}》的评审`}
                      >
                        <span className="home-feed-user">
                          <Avatar src={reviewerAvatar(r)} name={name} />
                          <span className="home-feed-user-meta">
                            <span className="home-feed-name-row">
                              <span className="home-feed-username">{name}</span>
                              <UserLevelBadge experience={r.userJson?.experience} />
                            </span>
                            <span className="home-feed-time">{r.created ? formatTs(r.created) : ''}</span>
                          </span>
                          {r.actualscore && r.actualscore !== '-.-' && (
                            <span className="home-feed-score">{r.actualscore} 分</span>
                          )}
                        </span>
                        {content ? (
                          <span className="home-feed-content">
                            <span className="home-feed-content-text">{content}</span>
                          </span>
                        ) : (
                          <span className="home-feed-content home-feed-content-empty">
                            <span className="home-feed-content-text">（无评价内容）</span>
                          </span>
                        )}
                      </button>
                      {/* 文章归属与评论按钮同行——评《xxx》靠左，评论按钮靠右 */}
                      <span className="home-feed-actions">
                        <span className="home-feed-article">评《{title || `文章 ${String(r.cid ?? '')}`}》</span>
                        <button
                          className="attitude-btn review-comments-btn home-feed-comment-btn"
                          onClick={() => setEditor(editorOpen ? null : { kind: 'review', id: String(r.id) })}
                          title={
                            Number(r.replyNum) > 0
                              ? `评论这条评审（${Number(r.replyNum)} 条）`
                              : '评论这条评审'
                          }
                        >
                          <MessageCircle size={13} />
                          {Number(r.replyNum) > 0 ? (
                            <span className="review-comments-count">{Number(r.replyNum)}</span>
                          ) : null}
                        </button>
                      </span>
                      {/* 就地展开的快速回复编辑框（样式对齐文章页评审卡片回复框） */}
                      {editorOpen && (
                        <FeedReplyEditor
                          loggedIn={loggedIn}
                          placeholder="评论这条评审…（≥4 字）"
                          loginHint="登录后可评论这条评审"
                          onCancel={() => setEditor(null)}
                          onSubmit={(text) => submitReviewComment(r, text)}
                        />
                      )}
                    </div>
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
                  const avatarRaw = String(c.avatar ?? '')
                  const avatar = avatarRaw && /^https?:\/\//i.test(avatarRaw) ? cachedImageUrl(avatarRaw) : undefined
                  // v0.0.9：匿名作者的文章下，评论者就是作者本人时统一显示「匿名用户」。
                  // 优先用首页已加载文章条目（authorId/isAnonymous 完整）；否则用评论流自带的文章信息
                  const homeArticle = homeArticleById.get(String(c.cid ?? ''))
                  const author = anonymousAuthorDisplayName(
                    homeArticle ?? { authorId: c.articleAuthorId, isAnonymous: c.articleIsAnonymous },
                    c.authorId,
                    c.author || '匿名'
                  )
                  const editorOpen = editor?.kind === 'comment' && editor.id === String(c.coid)
                  return (
                    <div key={String(c.coid)} className={`home-feed-card${editorOpen ? ' editing' : ''}`}>
                      {/* 卡片主体：点击跳转到对应文章评论区 / 评审评论区 */}
                      <button
                        className="home-feed-main"
                        onClick={() =>
                          openFeedItem(
                            String(c.cid ?? ''),
                            rid ? 'review' : 'comments',
                            rid ? { reviewId: rid, commentId: String(c.coid) } : { commentId: String(c.coid) }
                          )
                        }
                        title={rid ? `查看《${c.articleTitle ?? ''}》的评审讨论` : `查看《${c.articleTitle ?? ''}》的评论`}
                      >
                        <span className="home-feed-user">
                          <Avatar src={avatar} name={author} />
                          <span className="home-feed-user-meta">
                            <span className="home-feed-name-row">
                              <span className="home-feed-username">{author}</span>
                              <UserLevelBadge experience={c.experience} />
                            </span>
                            <span className="home-feed-time">{c.created ? formatTs(c.created) : ''}</span>
                          </span>
                        </span>
                        <span className="home-feed-content">
                          <span className="home-feed-content-text">{c.text}</span>
                        </span>
                      </button>
                      {/* 文章归属与回复按钮同行，回复按钮与评论按钮同款（纯图标、靠右） */}
                      <span className="home-feed-actions">
                        <span className="home-feed-article">
                          {rid
                            ? `讨论于《${c.articleTitle || `文章 ${String(c.cid ?? '')}`}》${
                                c.reviewAuthor ? `中${c.reviewAuthor}的评审` : '中的评审'
                              }`
                            : `讨论于《${c.articleTitle || `文章 ${String(c.cid ?? '')}`}》`}
                        </span>
                        <button
                          className="attitude-btn review-comments-btn home-feed-reply-btn"
                          onClick={() => setEditor(editorOpen ? null : { kind: 'comment', id: String(c.coid) })}
                          title={rid ? '回复这条评审讨论' : '回复这条评论'}
                        >
                          <MessageCircle size={13} />
                        </button>
                      </span>
                      {editorOpen && (
                        <FeedReplyEditor
                          loggedIn={loggedIn}
                          placeholder={`回复 @${author}（≥4 字）`}
                          loginHint={rid ? '登录后可回复这条评审讨论' : '登录后可回复这条评论'}
                          onCancel={() => setEditor(null)}
                          onSubmit={(text) => submitCommentReply(c, text)}
                        />
                      )}
                    </div>
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
