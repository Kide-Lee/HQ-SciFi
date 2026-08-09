import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { cachedImageUrl, formatTs } from '../lib/sanitize'
import type { CommentItem } from '../../../shared/types'

/**
 * 评论区（M2 阅读视图正文下方）：平铺评论 + 楼中楼回复 + 发表框 + 加载更多。
 * 数据走 store（loadComments/submitComment），发表经 hqComments/commentsAdd（text ≥4 字，首次可能进审核）。
 */
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

  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)

  // 顶层评论（parent 为 0/空）；其余为楼中楼子评论
  const top = useMemo(() => comments.filter((c) => String(c.parent) === '0' || c.parent == null), [comments])
  const childrenOf = (coid: number | string): CommentItem[] =>
    comments.filter((c) => String(c.parent) === String(coid))

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const text = draft.trim()
    if (text.length < 4) {
      setLocalErr(`评论内容至少 4 个字（当前 ${text.length} 字）`)
      return
    }
    setLocalErr(null)
    const ok = await submitComment({ cid, text, parent: replyTo?.coid })
    if (ok) {
      setDraft('')
      setReplyTo(null)
    }
  }

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
          <textarea
            className="comment-input"
            rows={2}
            value={draft}
            placeholder={replyTo ? `回复 @${replyTo.author}（≥4 字）` : '写下你的评论…（≥4 字）'}
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
        {top.map((c) => (
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
        {commentsHasMore && (
          <button className="comment-more" onClick={() => void loadComments(cid, { append: true })}>
            加载更多评论
          </button>
        )}
      </div>
    </section>
  )
}

/** 单条评论（头像 + 昵称 + 时间 + 内容 + 回复按钮）；父评论摘要（parentComments）一并展示 */
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
      {/* 楼中楼：展示被回复的父评论摘要（服务端返回 parentComments） */}
      {pc && pc.text ? (
        <div className="comment-parent-quote">
          <span className="comment-parent-author">{pc.author ? `@${pc.author}：` : ''}</span>
          {pc.text}
        </div>
      ) : null}
      <div className="comment-text">{comment.text}</div>
    </div>
  )
}
