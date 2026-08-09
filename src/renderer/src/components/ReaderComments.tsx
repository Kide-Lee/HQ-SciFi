import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { useReaderStore } from '../stores/reader'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { cachedImageUrl, formatTs } from '../lib/sanitize'
import type { CommentItem, ReviewItem } from '../../../shared/types'

/**
 * 评论区（v0.0.3 移入右栏「评论」tab）：
 * 普通评论平铺 + 楼中楼回复 + 发表框 + 加载更多；
 * 关联评审的评论（reviewid>0）按评审聚合分组，组头标明该评审的评判者/评分/综合评价，
 * 可「跳转到对应评审」（切评审 tab 并滚动定位）。
 * 数据走 store（loadComments/submitComment），发表经 hqComments/commentsAdd（text ≥4 字）。
 */

/** 评论关联的评审 id（0/空 = 普通评论） */
function ridOf(c: CommentItem): string {
  const v = c.reviewid
  if (v == null || String(v) === '0' || String(v) === '') return ''
  return String(v)
}

/** 评审的评判者展示名（与评审卡片同容错） */
function reviewAuthorName(r: ReviewItem): string {
  const u = r.userJson ?? {}
  const name = String(u.nickname ?? u.nick ?? u.nickName ?? u.name ?? (u.uid != null ? `UID ${String(u.uid)}` : ''))
  return name || '匿名'
}

export function CommentSection({ cid }: { cid: string }): React.JSX.Element {
  const comments = useReaderStore((s) => s.comments)
  const commentsTotal = useReaderStore((s) => s.commentsTotal)
  const commentsLoading = useReaderStore((s) => s.commentsLoading)
  const commentsHasMore = useReaderStore((s) => s.commentsHasMore)
  const commentSubmitting = useReaderStore((s) => s.commentSubmitting)
  const commentMessage = useReaderStore((s) => s.commentMessage)
  const loadComments = useReaderStore((s) => s.loadComments)
  const submitComment = useReaderStore((s) => s.submitComment)
  const clearCommentMessage = useReaderStore((s) => s.clearCommentMessage)
  const reviews = useReaderStore((s) => s.reviews)

  // v0.0.3：右栏 tab 联动状态
  const replyReview = useUiStore((s) => s.readerReplyReview)
  const setReplyReview = useUiStore((s) => s.setReaderReplyReview)
  const jumpCommentGroup = useUiStore((s) => s.readerJumpCommentGroup)
  const setJumpCommentGroup = useUiStore((s) => s.setReaderJumpCommentGroup)
  const setPanelTab = useUiStore((s) => s.setReaderPanelTab)
  const setJumpReviewId = useUiStore((s) => s.setReaderJumpReviewId)

  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)

  // 评审 id → ReviewItem 映射（组头展示评判者/评分/综合评价）
  const reviewById = useMemo(() => {
    const m = new Map<string, ReviewItem>()
    for (const r of reviews) m.set(String(r.id), r)
    return m
  }, [reviews])

  // 顶层评论（parent 为 0/空）；其余为楼中楼子评论
  const top = useMemo(() => comments.filter((c) => String(c.parent) === '0' || c.parent == null), [comments])
  const childrenOf = (coid: number | string): CommentItem[] =>
    comments.filter((c) => String(c.parent) === String(coid))

  // v0.0.3：按 reviewid 分组——关联同一评审的顶层评论聚合；普通评论保持平铺
  const { normalTop, reviewGroups } = useMemo(() => {
    const normal: CommentItem[] = []
    const groups = new Map<string, CommentItem[]>()
    for (const c of top) {
      const rid = ridOf(c)
      if (rid) {
        const arr = groups.get(rid) ?? []
        arr.push(c)
        groups.set(rid, arr)
      } else {
        normal.push(c)
      }
    }
    return { normalTop: normal, reviewGroups: [...groups.entries()] }
  }, [top])

  // 消费「回复评审」目标：评论表单进入回复评审模式（reviewid 预置，提交时透传）
  useEffect(() => {
    if (replyReview == null) return
    setReplyTo(null)
    setLocalErr(null)
    // 打开文章时残留目标已由 clearReaderPanelTargets 清理；此处无需额外动作
  }, [replyReview])

  // 消费「评审→评论 分组定位」：滚动到对应评审的评论分组
  useEffect(() => {
    if (jumpCommentGroup == null) return
    const el = document.querySelector(`[data-review-group="${CSS.escape(jumpCommentGroup)}"]`)
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setJumpCommentGroup(null)
  }, [jumpCommentGroup, comments, setJumpCommentGroup])

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const text = draft.trim()
    if (text.length < 4) {
      setLocalErr(`评论内容至少 4 个字（当前 ${text.length} 字）`)
      return
    }
    setLocalErr(null)
    const ok = await submitComment({ cid, text, parent: replyTo?.coid, reviewid: replyReview ?? undefined })
    if (ok) {
      setDraft('')
      setReplyTo(null)
      if (replyReview != null) setReplyReview(null)
    }
  }

  function cancelReplyReview(): void {
    setReplyReview(null)
    setLocalErr(null)
  }

  const replyReviewReview = replyReview != null ? reviewById.get(replyReview) : undefined

  return (
    <section className="reader-comments">
      <div className="reader-comments-head">
        <h3>评论区</h3>
        <span className="reader-comments-count">{commentsTotal > 0 ? `${commentsTotal} 条` : ''}</span>
      </div>

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
          {/* v0.0.3：回复评审模式提示条（评审卡片「回复评审」进入） */}
          {replyReview != null && (
            <div className="comment-reply-review-bar">
              正在回复评审
              {replyReviewReview ? `（${reviewAuthorName(replyReviewReview)}` : ''}
              {replyReviewReview?.actualscore && replyReviewReview.actualscore !== '-.-'
                ? ` · ${replyReviewReview.actualscore} 分）`
                : '）'}
              <button type="button" className="comment-cancel-reply" onClick={cancelReplyReview}>
                取消
              </button>
            </div>
          )}
          <textarea
            className="comment-input"
            rows={2}
            value={draft}
            placeholder={
              replyReview != null
                ? '回复这条评审…（≥4 字）'
                : replyTo
                  ? `回复 @${replyTo.author}（≥4 字）`
                  : '写下你的评论…（≥4 字）'
            }
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
        <div className="comment-login-hint">登录后可发表评论</div>
      )}

      <div className="comment-list">
        {commentsLoading && <div className="muted comment-loading">加载评论中 …</div>}
        {!commentsLoading && top.length === 0 && (
          <div className="muted comment-empty">还没有评论，来抢沙发吧</div>
        )}

        {/* 普通评论（未关联评审） */}
        {normalTop.map((c) => (
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

        {/* v0.0.3：评审评论分组——同一评审的评论聚合，组头标明评判者/评分/综合评价 */}
        {reviewGroups.map(([rid, items]) => {
          const review = reviewById.get(rid)
          return (
            <div className="review-comment-group" data-review-group={rid} key={rid}>
              <div className="review-comment-group-head">
                <div className="review-comment-group-info">
                  <span className="review-comment-group-label">
                    针对评审
                    {review ? `（${reviewAuthorName(review)}${review.actualscore && review.actualscore !== '-.-' ? ` · ${review.actualscore} 分` : ''}）` : ` #${rid}`}
                  </span>
                  {review?.zonghe && (
                    <span className="review-comment-group-zonghe" title={review.zonghe}>
                      综合评价：{review.zonghe}
                    </span>
                  )}
                </div>
                <button
                  className="comment-jump-review"
                  onClick={() => {
                    setPanelTab('review')
                    setJumpReviewId(rid)
                  }}
                  title="在评审栏定位这条评审"
                >
                  <ArrowRight size={12} /> 跳转到对应评审
                </button>
              </div>
              {items.map((c) => (
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
          )
        })}

        {commentsHasMore && (
          <button className="comment-more" onClick={() => void loadComments(cid, { append: true })}>
            加载更多评论
          </button>
        )}
      </div>
    </section>
  )
}

/** 单条评论（头像 + 昵称 + 时间 + 内容 + 回复按钮）；父评论摘要（parentComments）一并展示（v0.0.3：引用单行省略） */
function CommentCard({
  comment,
  onReply
}: {
  comment: CommentItem
  onReply: () => void
}): React.JSX.Element {
  const avatar = comment.avatar && /^https?:\/\//i.test(comment.avatar) ? cachedImageUrl(comment.avatar) : undefined
  const pc = comment.parentComments
  return (
    <div className="comment-card">
      <div className="comment-card-head">
        {avatar ? (
          <img className="comment-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="comment-avatar comment-avatar-placeholder" />
        )}
        <span className="comment-author">{comment.author || '匿名'}</span>
        {comment.created ? <span className="comment-time">· {formatTs(comment.created)}</span> : null}
        <button className="comment-reply-btn" onClick={onReply}>
          回复
        </button>
      </div>
      {/* 楼中楼：展示被回复的父评论摘要（服务端返回 parentComments；单行省略） */}
      {pc && pc.text ? (
        <div className="comment-parent-quote" title={pc.text}>
          <span className="comment-parent-author">{pc.author ? `@${pc.author}：` : ''}</span>
          {pc.text}
        </div>
      ) : null}
      <div className="comment-text">{comment.text}</div>
    </div>
  )
}
