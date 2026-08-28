import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, FileDown, MessageCircle, PenLine, X } from 'lucide-react'
import { anonymousAuthorDisplayName, cachedImageUrl, formatSize, formatTs, scoreColor, userAvatarUrl, userDisplayName } from '../../lib/sanitize'
import { REVIEW_ORDERS, useReaderStore } from '../../stores/reader'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { ErrorBanner } from '../../components/ErrorBanner'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import { ReviewInlineComments } from './ReviewInlineComments'
import type { CommentItem, ReviewItem, ReviewPayload } from '../../../../shared/types'

export function ReviewItemCard({
  review,
  isMine,
  onEdit
}: {
  review: ReviewItem
  isMine: boolean
  onEdit?: () => void
}): React.JSX.Element {
  const setAttitude = useReaderStore((s) => s.setAttitude)
  const detail = useReaderStore((s) => s.detail)
  const openUserPage = useUiStore((s) => s.openUserPage)
  // v0.0.5：评审评论内嵌于卡片，默认收起（点击「评论 N」展开/收起；「回复评审」展开并聚焦回复框）
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [replyIntent, setReplyIntent] = useState(false)
  // v0.0.8：隐藏评分开关（我的评审展示页，方便截图分享不泄露评分）
  const [hideScores, setHideScores] = useState(false)
  // v0.0.8：深链目标——目标评审（带评论定位）的评论区自动展开
  const target = useReaderStore((s) => s.target)
  useEffect(() => {
    if (target?.reviewId && String(review.id) === String(target.reviewId) && target.commentId) {
      setCommentsOpen(true)
    }
  }, [target, review.id])
  const u = review.userJson ?? {}
  const rNameRaw = String(u.nickname ?? u.nick ?? u.nickName ?? u.name ?? `UID ${String(u.uid ?? review.uid ?? '')}`)
  // v0.0.9：匿名作者的文章下，评审者就是作者本人时统一显示「匿名用户」
  const rName = anonymousAuthorDisplayName(detail, review.uid, rNameRaw)
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
  // v0.0.8：评审者头像可点进入用户页（匿名不可点）
  const reviewUid = String(review.uid ?? u.uid ?? '')
  const reviewUserClickable =
    reviewUid !== '' && reviewUid !== '0' && rName !== '匿名用户' && !review.isAi
  return (
    <div className={`review-item ${hideScores ? 'hide-scores' : ''}`} data-review-id={String(review.id)}>
      <div className="review-item-head">
        {avatar ? (
          <img
            className={`review-item-avatar${reviewUserClickable ? ' user-link' : ''}`}
            src={avatar}
            alt=""
            referrerPolicy="no-referrer"
            title={reviewUserClickable ? '查看用户主页' : undefined}
            onClick={reviewUserClickable ? () => openUserPage(reviewUid) : undefined}
          />
        ) : null}
        {/* v0.0.5：头像右侧 meta 分组——评审者名字一行，下方一行评审发布时间 */}
        <div className="review-item-meta">
          <div className="review-item-meta-top">
            <span
              className={`review-item-author${reviewUserClickable ? ' user-link' : ''}`}
              title={reviewUserClickable ? '查看用户主页' : undefined}
              onClick={reviewUserClickable ? () => openUserPage(reviewUid) : undefined}
            >
              {rName}
            </span>
            <UserLevelBadge experience={u.experience} />
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
        {/* v0.0.8：右侧操作组（隐藏评分/编辑/评论）——我的评审与其他评审共用同一容器样式靠右 */}
        <div className="review-actions-right">
          {isMine && (
            /* v0.0.8：隐藏评分开关——纯图标（与编辑/评论按钮一致），hover 提示用途 */
            <button
              className="attitude-btn review-comments-btn review-hide-score-btn"
              onClick={() => setHideScores((v) => !v)}
              title={hideScores ? '显示评分' : '隐藏评分（方便截图分享，不泄露自己的评分）'}
            >
              {hideScores ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          )}
          {isMine && onEdit && (
            /* v0.0.8：纯图标按钮，与旁边的评论按钮样式一致（文字去掉，靠 title 提示） */
            <button className="attitude-btn review-comments-btn review-edit-btn" onClick={onEdit} title="编辑我的评审">
              <PenLine size={13} />
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

