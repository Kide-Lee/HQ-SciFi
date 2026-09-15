import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, FileDown, MessageCircle, PenLine, X } from 'lucide-react'
import { anonymousAuthorDisplayName, cachedImageUrl, formatSize, formatTs, scoreColor, userAvatarUrl, userDisplayName } from '../../lib/sanitize'
import { REVIEW_ORDERS, useReaderStore } from '../../stores/reader'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { ErrorBanner } from '../../components/ErrorBanner'
import { CommentSection, CommentCard, ridOf, flatSubs } from './ReaderComments'
import { toQuoteLine } from '../../lib/selection'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import type { CommentItem, ReviewItem, ReviewPayload } from '../../../../shared/types'

export function ReviewInlineComments({
  review,
  autoFocusReply,
  onReplyFocused,
  initialQuote
}: {
  review: ReviewItem
  autoFocusReply?: boolean
  onReplyFocused?: () => void
  /** v1.1.12：右键评审卡片「引用到回复框」带入的引用文字（{seq} 单调递增，用于判重） */
  initialQuote?: { seq: number; text: string } | null
}): React.JSX.Element {
  const comments = useReaderStore((s) => s.comments)
  const commentSubmitting = useReaderStore((s) => s.commentSubmitting)
  const commentMessage = useReaderStore((s) => s.commentMessage)
  const clearCommentMessage = useReaderStore((s) => s.clearCommentMessage)
  const submitComment = useReaderStore((s) => s.submitComment)
  const detail = useReaderStore((s) => s.detail)
  const target = useReaderStore((s) => s.target)
  const clearTarget = useReaderStore((s) => s.clearTarget)
  const cid = detail?.cid ?? ''
  const rid = String(review.id)
  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const replyBoxRef = useRef<HTMLTextAreaElement | null>(null)

  // v0.0.8.7：首页「最新讨论」点回复评审讨论 → 打开对应评审评论后，自动选中目标评论并聚焦回复框
  useEffect(() => {
    if (!target?.replyCommentId || String(target.reviewId ?? '') !== rid) return
    const c = comments.find((item) => String(item.coid) === String(target.replyCommentId))
    if (!c) return
    setReplyTo(c)
    // preventScroll：聚焦不抢滚动；这里自己负责定位到目标评论，避免与父级深链 effect 的执行顺序耦合
    replyBoxRef.current?.focus({ preventScroll: true })
    const el = document.querySelector(`.review-panel [data-coid="${CSS.escape(String(target.replyCommentId))}"]`)
    el?.scrollIntoView({ block: 'center' })
    clearTarget()
  }, [target, comments, rid, clearTarget])
  // v0.0.8.5：已收起深层评审评论的第一层评论 coid 集合
  const [collapsedSubs, setCollapsedSubs] = useState<Set<string>>(new Set())

  function toggleCollapsed(coid: number | string): void {
    setCollapsedSubs((prev) => {
      const next = new Set(prev)
      const key = String(coid)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 该评审的顶层评论（子评论按 parent 归属，不依赖子评论自身的 reviewid）
  const reviewTop = useMemo(
    () => comments.filter((c) => ridOf(c) === rid && (String(c.parent) === '0' || c.parent == null)),
    [comments, rid]
  )

  // v1.1.12：评审卡片「引用到回复框」——把引用文字补进草稿（消费后不再重复；StrictMode 下 effect 会跑两次）
  const consumedQuoteSeq = useRef(0)
  useEffect(() => {
    if (!initialQuote || consumedQuoteSeq.current === initialQuote.seq) return
    consumedQuoteSeq.current = initialQuote.seq
    const line = toQuoteLine(initialQuote.text)
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${line}` : line))
    // 引用的是整条评审（不是某条评论）→ 作为顶层评论
    setReplyTo(null)
    requestAnimationFrame(() => replyBoxRef.current?.focus())
  }, [initialQuote])

  /** v1.1.12：右键某条评审评论「引用到回复框」 */
  function quoteIntoReply(comment: CommentItem): void {
    setReplyTo(comment)
    const line = toQuoteLine(comment.text ?? '')
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${line}` : line))
    requestAnimationFrame(() => replyBoxRef.current?.focus())
  }

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
      {/* v0.0.6：未登录不显示回复框，改为登录提示 */}
      {loggedIn ? (
        <form className="comment-form" onSubmit={(e) => void handleSubmit(e)}>
          <textarea
            ref={replyBoxRef}
            className="comment-input"
            rows={2}
            value={draft}
            placeholder={
              replyTo
                ? `回复 @${anonymousAuthorDisplayName(detail, replyTo.authorId, replyTo.author || '匿名')}（≥4 字）`
                : '评论这条评审…（≥4 字）'
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
        <div className="comment-login-hint">登录后可评论这条评审</div>
      )}
      {/* v0.0.8：无评审评论时不渲染评论列表（空态提示一并去掉） */}
      {reviewTop.length > 0 && (
        <div className="comment-list">
          {reviewTop.map((c) => {
            // v0.0.8.4：二层及更深的评审评论全部扁平化到第二层（按对话顺序）
            const subs = flatSubs(comments, c.coid)
            const isCollapsed = collapsedSubs.has(String(c.coid))
            return (
              <div key={String(c.coid)} className="comment-item" data-coid={String(c.coid)}>
                <CommentCard
                  comment={c}
                  onReply={() => setReplyTo(c)}
                  onQuote={loggedIn ? () => quoteIntoReply(c) : undefined}
                />
                {subs.length > 0 && (
                  <>
                    {/* v0.0.8.5：第一层评审评论上的收起/展开深层回复按钮 */}
                    <button
                      className="comment-sub-toggle"
                      onClick={() => toggleCollapsed(c.coid)}
                      title={isCollapsed ? '展开深层回复' : '收起深层回复'}
                    >
                      {isCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                      {isCollapsed ? `展开 ${subs.length} 条回复` : `收起 ${subs.length} 条回复`}
                    </button>
                    {!isCollapsed && (
                      <div className="comment-sub-list">
                        {subs.map((sub) => (
                          <div key={String(sub.coid)} className="comment-item comment-sub" data-coid={String(sub.coid)}>
                            <CommentCard
                              comment={sub}
                              onReply={() => setReplyTo(sub)}
                              onQuote={loggedIn ? () => quoteIntoReply(sub) : undefined}
                              // 回复的是第一层评论 → 父就在上方，隐藏引用文本
                              hideParentQuote={String(sub.parent) === String(c.coid)}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

