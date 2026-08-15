import { MessageCircle } from 'lucide-react'
import { anonymousAuthorDisplayName, cachedImageUrl, formatTs, userDisplayName } from '../lib/sanitize'
import { UserLevelBadge } from './UserLevelBadge'
import type { CommentItem, ReviewItem } from '../../../shared/types'

/**
 * v0.0.8 用户系统：信息流卡片（用户为主体）——与推荐首页「最新评审 / 最新讨论」完全同款。
 * 用户页主页四栏、评审/评论子页与推荐首页共用，避免样式漂移。
 */

/** 头像或昵称首字占位（无头像也有归属感） */
export function FeedAvatar({ src, name }: { src?: string; name: string }): React.JSX.Element {
  if (src) {
    return <img className="home-feed-avatar" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
  }
  return <span className="home-feed-avatar home-feed-avatar-fallback">{[...name][0] || '?'}</span>
}

/** 头像可点击的用户入口（点击头像进入用户页；匿名不可点） */
function FeedAvatarWrap({
  src,
  name,
  uid,
  onOpenUser
}: {
  src?: string
  name: string
  uid: string
  onOpenUser: () => void
}): React.JSX.Element {
  const clickable = uid !== '' && uid !== '0'
  return (
    <span
      className="home-feed-avatar-wrap"
      title={clickable ? '查看用户主页' : undefined}
      onClick={(e) => {
        if (!clickable) return
        e.stopPropagation()
        onOpenUser()
      }}
    >
      <FeedAvatar src={src} name={name} />
    </span>
  )
}

/** 评审摘要卡（推荐首页「最新评审」/ 用户页主页「评审」/ 用户页「评审」子页共用） */
export function ReviewFeedCard({
  review,
  onOpen,
  onOpenUser,
  onComment,
  footer,
  editing = false,
  hideScore = false
}: {
  review: ReviewItem
  onOpen: () => void
  onOpenUser: () => void
  /** 提供则显示与推荐首页一致的「评论这条评审」按钮 */
  onComment?: () => void
  /** 卡片底部附加内容（推荐首页就地回复编辑框等） */
  footer?: React.ReactNode
  /** 就地编辑框展开时解除卡片高度限制 */
  editing?: boolean
  /** 进行中/评审中活动不暴露评分 */
  hideScore?: boolean
}): React.JSX.Element {
  const u = review.userJson ?? {}
  const rawName = userDisplayName(u, `UID ${String(review.uid ?? '')}`)
  // v0.0.9：匿名作者的文章下，评审者就是作者本人时统一显示「匿名用户」
  const info = review.articleInfo as Record<string, unknown> | undefined
  const name = anonymousAuthorDisplayName(
    review.articleAuthorId != null || review.articleIsAnonymous != null
      ? { authorId: review.articleAuthorId, isAnonymous: review.articleIsAnonymous }
      : info
        ? {
            authorId: typeof info.authorId === 'string' || typeof info.authorId === 'number' ? info.authorId : undefined,
            isAnonymous: info.isAnonymous as boolean | number | string | undefined
          }
        : null,
    review.uid,
    rawName
  )
  const avatarRaw = String(u.avatar ?? u.headImg ?? u.headImgUrl ?? u.avatarUrl ?? '')
  const avatar = avatarRaw && /^https?:\/\//i.test(avatarRaw) ? cachedImageUrl(avatarRaw) : undefined
  const title = String(info?.title ?? info?.contenTitle ?? '')
  const content = String(review.zonghe ?? '').trim() || String(review.dianzi ?? '').trim()
  // 评审自身评分缺失（往期活动 actualscore='-.-'）时回退展示文章评分；
  // 进行中/评审中活动不暴露评分
  const actual = String(review.actualscore ?? '')
  const articleScore = String(info?.score ?? '')
  const displayScore = hideScore || review.hideScore
    ? ''
    : actual && actual !== '-.-'
      ? actual
      : articleScore && articleScore !== '-.-'
        ? articleScore
        : ''
  const score = displayScore ? `${displayScore} 分` : ''
  const commentCount = Number(review.replyNum) || 0
  const uid = String(review.uid ?? (u.uid as string | number | undefined) ?? '')

  return (
    <div className={`home-feed-card${editing ? ' editing' : ''}`}>
      {/* 卡片主体：点击跳转到对应文章评审 */}
      <button className="home-feed-main" onClick={onOpen} title={`查看《${title || String(review.cid ?? '')}》的评审`}>
        <span className="home-feed-user">
          <FeedAvatarWrap src={avatar} name={name} uid={uid} onOpenUser={onOpenUser} />
          <span className="home-feed-user-meta">
            <span className="home-feed-name-row">
              <span className="home-feed-username">{name}</span>
              <UserLevelBadge experience={u.experience} />
            </span>
            <span className="home-feed-time">{review.created ? formatTs(Number(review.created)) : ''}</span>
          </span>
          {score && <span className="home-feed-score">{score}</span>}
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
      {/* 文章归属与评论按钮同行——评《xxx》靠左，评论按钮靠右（与推荐首页一致） */}
      <span className="home-feed-actions">
        <span className="home-feed-article">评《{title || `文章 ${String(review.cid ?? '')}`}》</span>
        {onComment && (
          <button
            className="attitude-btn review-comments-btn home-feed-comment-btn"
            onClick={onComment}
            title={commentCount > 0 ? `评论这条评审（${commentCount} 条）` : '评论这条评审'}
          >
            <MessageCircle size={13} />
            {commentCount > 0 ? <span className="review-comments-count">{commentCount}</span> : null}
          </button>
        )}
      </span>
      {footer}
    </div>
  )
}

/** 评论摘要卡（推荐首页「最新讨论」/ 用户页主页「评论」/ 用户页「评论」子页共用） */
export function CommentFeedCard({
  comment,
  onOpen,
  onOpenUser,
  onReply,
  footer,
  editing = false
}: {
  comment: CommentItem
  onOpen: () => void
  onOpenUser: () => void
  /** 提供则显示与推荐首页一致的「回复这条评论」按钮 */
  onReply?: () => void
  footer?: React.ReactNode
  /** 就地编辑框展开时解除卡片高度限制 */
  editing?: boolean
}): React.JSX.Element {
  const avatarRaw = String(comment.avatar ?? '')
  const avatar = avatarRaw && /^https?:\/\//i.test(avatarRaw) ? cachedImageUrl(avatarRaw) : undefined
  // v0.0.9：匿名作者的文章下，评论者就是作者本人时统一显示「匿名用户」
  const author = anonymousAuthorDisplayName(
    { authorId: comment.articleAuthorId, isAnonymous: comment.articleIsAnonymous },
    comment.authorId,
    comment.author || '匿名'
  )
  const rid =
    comment.reviewid != null && String(comment.reviewid) !== '' && String(comment.reviewid) !== '0'
      ? String(comment.reviewid)
      : null
  const title = comment.articleTitle || `文章 ${String(comment.cid ?? '')}`
  const articleLine = rid
    ? `讨论于《${title}》${comment.reviewAuthor ? `中${comment.reviewAuthor}的评审` : '中的评审'}`
    : `评论于《${title}》`
  const uid = String(comment.authorId ?? '')

  return (
    <div className={`home-feed-card${editing ? ' editing' : ''}`}>
      {/* 卡片主体：点击跳转到对应文章评论区 / 评审评论区 */}
      <button className="home-feed-main" onClick={onOpen} title={`查看《${title}》的${rid ? '评审讨论' : '评论'}`}>
        <span className="home-feed-user">
          <FeedAvatarWrap src={avatar} name={author} uid={uid} onOpenUser={onOpenUser} />
          <span className="home-feed-user-meta">
            <span className="home-feed-name-row">
              <span className="home-feed-username">{author}</span>
              <UserLevelBadge experience={comment.experience} />
            </span>
            <span className="home-feed-time">{comment.created ? formatTs(Number(comment.created)) : ''}</span>
          </span>
        </span>
        <span className="home-feed-content">
          <span className="home-feed-content-text">{comment.text}</span>
        </span>
      </button>
      {/* 文章归属与回复按钮同行（与推荐首页一致） */}
      <span className="home-feed-actions">
        <span className="home-feed-article">{articleLine}</span>
        {onReply && (
          <button
            className="attitude-btn review-comments-btn home-feed-reply-btn"
            onClick={onReply}
            title={rid ? '回复这条评审讨论' : '回复这条评论'}
          >
            <MessageCircle size={13} />
          </button>
        )}
      </span>
      {footer}
    </div>
  )
}
