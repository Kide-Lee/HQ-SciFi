import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useReaderStore } from '../stores/reader'
import { useAuthStore } from '../stores/auth'
import { anonymousAuthorDisplayName, cachedImageUrl, formatTs } from '../lib/sanitize'
import { SkeletonComment } from './Skeletons'
import type { CommentItem } from '../../../shared/types'

/**
 * 评论区（v0.0.3 移入右栏「评论」tab）：
 * 普通评论平铺 + 楼中楼回复 + 发表框 + 加载更多；
 * v0.0.5：关联评审的评论（reviewid>0）已移入评审卡片内（默认收起），
 * 本组件只展示普通评论。
 * 数据走 store（loadComments/submitComment），发表经 hqComments/commentsAdd（text ≥4 字）。
 */

/** 评论关联的评审 id（0/空 = 普通评论） */
export function ridOf(c: CommentItem): string {
  const v = c.reviewid
  if (v == null || String(v) === '0' || String(v) === '') return ''
  return String(v)
}

/**
 * v0.0.8.4：楼中楼扁平化——顶层评论的全部后代（二层及更深，无论多深）
 * 按深度优先顺序（父先于子，同层按出现序）全部归入第二层展示。
 */
export function flatSubs(comments: CommentItem[], topCoid: number | string): CommentItem[] {
  const byParent = new Map<string, CommentItem[]>()
  for (const c of comments) {
    const key = String(c.parent)
    const arr = byParent.get(key)
    if (arr) arr.push(c)
    else byParent.set(key, [c])
  }
  const out: CommentItem[] = []
  const walk = (coid: number | string): void => {
    for (const c of byParent.get(String(coid)) ?? []) {
      out.push(c)
      walk(c.coid)
    }
  }
  walk(topCoid)
  return out
}

export function CommentSection({ cid }: { cid: string }): React.JSX.Element {
  const comments = useReaderStore((s) => s.comments)
  const commentsLoading = useReaderStore((s) => s.commentsLoading)
  const commentsHasMore = useReaderStore((s) => s.commentsHasMore)
  const commentSubmitting = useReaderStore((s) => s.commentSubmitting)
  const commentMessage = useReaderStore((s) => s.commentMessage)
  const loadComments = useReaderStore((s) => s.loadComments)
  const submitComment = useReaderStore((s) => s.submitComment)
  const clearCommentMessage = useReaderStore((s) => s.clearCommentMessage)
  const detail = useReaderStore((s) => s.detail)
  // v0.0.8：深链目标（首页「最新讨论」普通评论跳转定位）
  const target = useReaderStore((s) => s.target)
  const clearTarget = useReaderStore((s) => s.clearTarget)

  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)
  // v0.0.8.5：已收起深层评论的第一层评论 coid 集合
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

  // v0.0.8：消费深链目标——滚动定位到目标评论（评论按 coid 升序分页加载，
  // 目标可能是最新评论（第 2+ 页），未命中且还有下一页时继续追加加载）
  useEffect(() => {
    if (!target?.commentId || target?.reviewId) return
    if (target.cid !== cid) {
      clearTarget()
      return
    }
    const el = document.querySelector(`.reader-panel [data-coid="${CSS.escape(target.commentId)}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      clearTarget()
    } else if (!commentsLoading) {
      if (commentsHasMore) void loadComments(cid, { append: true, limit: 100 })
      else clearTarget() // 已无更多页仍未找到，放弃定位
    }
  })

  // v0.0.5：仅普通评论（未关联评审）顶层；评审评论由评审卡片内展示。
  // 评审评论的子评论（parent 指向评审顶层评论）不属于普通树。
  const top = useMemo(
    () => comments.filter((c) => ridOf(c) === '' && (String(c.parent) === '0' || c.parent == null)),
    [comments]
  )

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

  /** v0.0.6：评论框随内容自动增高（三行起步），最高为右栏高度的 1/3，超出后内部滚动 */
  function autoGrow(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto'
    const panel = ta.closest('.reader-panel') as HTMLElement | null
    const maxH = panel ? Math.max(56, Math.floor(panel.clientHeight / 3)) : 240
    const h = Math.min(ta.scrollHeight, maxH)
    ta.style.height = `${h}px`
    ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden'
  }

  return (
    <section className="reader-comments">
      {commentMessage && (
        <div className={commentMessage.startsWith('评论发布失败') ? 'reader-comments-err' : 'reader-comments-msg'}>
          {commentMessage}
          <button className="dismiss" onClick={clearCommentMessage} title="关闭">
            <X size={12} />
          </button>
        </div>
      )}

      {/* v0.0.6：评论列表占满右栏可滚动区域；发表框固定在右栏底部 */}
      <div className="comment-list">
        {/* v0.0.7：预填充骨架——仅首屏（无评论）显示；「加载更多」追加时不遮已有列表 */}
        {commentsLoading && top.length === 0 && (
          // 形状与真实评论行同构（头像 + 昵称/时间 + 内容）
          <>
            <span className="sr-only" role="status">加载评论中 …</span>
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonComment key={i} />
            ))}
          </>
        )}
        {!commentsLoading && top.length === 0 && (
          <div className="muted comment-empty">还没有评论，来抢沙发吧</div>
        )}

        {top.map((c) => {
          // v0.0.8.4：二层及更深的评论全部扁平化到第二层（按对话顺序）
          const subs = flatSubs(comments, c.coid)
          const isCollapsed = collapsedSubs.has(String(c.coid))
          return (
            <div key={String(c.coid)} className="comment-item" data-coid={String(c.coid)}>
              <CommentCard comment={c} onReply={() => setReplyTo(c)} />
              {subs.length > 0 && (
                <>
                  {/* v0.0.8.5：第一层评论上的收起/展开深层回复按钮 */}
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

        {commentsHasMore && (
          <button className="comment-more" onClick={() => void loadComments(cid, { append: true })}>
            加载更多评论
          </button>
        )}
      </div>

      {/* v0.0.6：未登录不显示发表框，改为登录提示 */}
      {loggedIn ? (
        <form className="comment-form" onSubmit={(e) => void handleSubmit(e)}>
          <textarea
            className="comment-input"
            rows={3}
            value={draft}
            placeholder={
              replyTo
                ? `回复 @${anonymousAuthorDisplayName(detail, replyTo.authorId, replyTo.author || '匿名')}`
                : '写下你的评论…'
            }
            onChange={(e) => {
              setDraft(e.target.value)
              setLocalErr(null)
              autoGrow(e.target)
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
    </section>
  )
}

/** 单条评论（头像 + 昵称 + 时间 + 内容 + 回复按钮）；父评论摘要（parentComments）一并展示（v0.0.3：引用单行省略） */
export function CommentCard({
  comment,
  onReply,
  hideParentQuote = false
}: {
  comment: CommentItem
  onReply: () => void
  /** v0.0.8.5：隐藏被回复父评论的引用（深层评论回复第一层评论时，父就在上方，引用冗余） */
  hideParentQuote?: boolean
}): React.JSX.Element {
  const avatar = comment.avatar && /^https?:\/\//i.test(comment.avatar) ? cachedImageUrl(comment.avatar) : undefined
  const detail = useReaderStore((s) => s.detail)
  // v0.0.9：匿名作者的文章下，评论者就是作者本人时统一显示「匿名用户」
  const author = anonymousAuthorDisplayName(detail, comment.authorId, comment.author || '匿名')
  const pc = comment.parentComments
  return (
    <div className="comment-card">
      <div className="comment-card-head">
        {avatar ? (
          <img className="comment-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="comment-avatar comment-avatar-placeholder" />
        )}
        {/* v0.0.5：头像右侧 meta 分组——昵称一行，下方评论时间一行（与评审卡片一致） */}
        <div className="comment-meta">
          <div className="comment-meta-top">
            <span className="comment-author">{author}</span>
          </div>
          {comment.created ? <span className="comment-time">{formatTs(comment.created)}</span> : null}
        </div>
        <button className="comment-reply-btn" onClick={onReply}>
          回复
        </button>
      </div>
      {/* 楼中楼：展示被回复的父评论摘要（服务端返回 parentComments；单行省略）。
          v0.0.8.5：深层评论回复第一层评论时父就在上方，隐藏引用 */}
      {!hideParentQuote && pc && pc.text ? (
        <div className="comment-parent-quote" title={pc.text}>
          <span className="comment-parent-author">{pc.author ? `@${pc.author}：` : ''}</span>
          {pc.text}
        </div>
      ) : null}
      <div className="comment-text">{comment.text}</div>
    </div>
  )
}
