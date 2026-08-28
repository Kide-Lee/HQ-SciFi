import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle, UserCheck, UserPlus } from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { useReaderStore } from '../../stores/reader'
import { useUserStore } from '../../stores/user'
import { useChatStore } from '../../stores/chat'
import { cachedImageUrl, formatTs, userDisplayName, userAvatarUrl } from '../../lib/sanitize'
import { ErrorBanner } from '../../components/ErrorBanner'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import { ArticleCard } from '../../components/ArticleListView'
import { ReviewFeedCard, CommentFeedCard } from '../../components/FeedCards'
import type { RemoteArticle, ReviewItem, CommentItem, FollowFeedItem, UserMarkItem, UserFollowItem, UserProfile, UserStats, UserPageTab } from '../../../../shared/types'

import { useOpenFromUser, feedToArticle, feedToReview, feedToComment, markToArticle } from './helpers'
import { FollowRow } from './FollowRow'
import { LazySentinel } from './LazySentinel'

export function UserListTab(): React.JSX.Element {
  const user = useUserStore()
  const open = useOpenFromUser()
  const openUser = useUiStore((s) => s.openUserPage)
  const tab = user.tab
  const [feedFilter, setFeedFilter] = useState<'all' | 'article' | 'review' | 'comment' | 'review_comment'>('all')

  if (tab === 'dynamic') {
    const items = user.dynamic.items.filter((it) =>
      feedFilter === 'all' ? true : it.kind === feedFilter
    )
    return (
      <div className="user-list-view">
        <div className="user-list-toolbar">
          <div className="list-orders">
            {(
              [
                ['all', '全部'],
                ['article', '文章'],
                ['review', '评审'],
                ['comment', '评论'],
                ['review_comment', '评审评论']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`order-btn ${feedFilter === key ? 'active' : ''}`}
                onClick={() => setFeedFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {user.dynamic.loading && items.length === 0 && <div className="muted">正在加载动态 …</div>}
        {user.dynamic.error && items.length === 0 && <ErrorBanner title="动态加载失败" message={user.dynamic.error} />}
        {/* 动态全部占一行：文章沿用 ArticleCard；评审/评论复用推荐首页同款卡片（含评论/回复按钮） */}
        <div className="home-list">
          {items.length === 0 && !user.dynamic.loading && <div className="list-empty muted">（暂无动态）</div>}
          {items.map((it) => {
            if (it.kind === 'article') {
              return (
                <ArticleCard
                  key={`article:${it.cid}`}
                  article={feedToArticle(it)}
                  active={false}
                  onOpen={() => open(it.cid)}
                />
              )
            }
            if (it.kind === 'review') {
              return (
                <ReviewFeedCard
                  key={`review:${it.reviewId ?? it.cid}`}
                  review={feedToReview(it)}
                  onOpen={() => open(it.cid, { reviewId: it.reviewId })}
                  onOpenUser={() => openUser(it.uid)}
                  onComment={() => open(it.cid, { reviewId: it.reviewId })}
                />
              )
            }
            return (
              <CommentFeedCard
                key={`comment:${it.commentId ?? it.cid}`}
                comment={feedToComment(it)}
                onOpen={() => open(it.cid, { reviewId: it.reviewid, commentId: it.commentId })}
                onOpenUser={() => openUser(it.uid)}
                onReply={() => open(it.cid, { reviewId: it.reviewid, commentId: it.commentId })}
              />
            )
          })}
        </div>
      </div>
    )
  }

  if (tab === 'marks') {
    return (
      <div className="user-list-view">
        {user.marks.error && <ErrorBanner title="收藏加载失败" message={user.marks.error} />}
        <div className="home-list">
          {user.marks.items.length === 0 && !user.marks.loading && <div className="list-empty muted">（暂无收藏）</div>}
          {user.marks.items.map((m) => (
            <ArticleCard key={m.cid} article={markToArticle(m)} active={false} onOpen={() => open(m.cid)} />
          ))}
        </div>
        <LazySentinel
          loading={user.marks.loading}
          hasMore={user.marks.hasMore}
          error={user.marks.error}
          onLoad={() => void useUserStore.getState().loadTab(true)}
        />
      </div>
    )
  }

  if (tab === 'fans') {
    // 本人页按切换按钮显示关注/粉丝；他人页只有「粉丝」
    const mode = user.isSelf ? user.fanMode : 'fans'
    return (
      <div className="user-list-view">
        {user.isSelf && (
          <div className="list-orders">
            <button className={`order-btn ${mode === 'follows' ? 'active' : ''}`} onClick={() => user.setFanMode('follows')}>
              关注
            </button>
            <button className={`order-btn ${mode === 'fans' ? 'active' : ''}`} onClick={() => user.setFanMode('fans')}>
              粉丝
            </button>
          </div>
        )}
        {user.fans.error && <ErrorBanner title="列表加载失败" message={user.fans.error} />}
        <div className="user-follow-list two-col">
          {user.fans.items.length === 0 && !user.fans.loading && <div className="list-empty muted">（暂无）</div>}
          {user.fans.items.map((f) => (
            <FollowRow key={`${f.uid}:${f.touid}:${f.created}`} f={f} mode={mode} />
          ))}
        </div>
        <LazySentinel
          loading={user.fans.loading}
          hasMore={user.fans.hasMore}
          error={user.fans.error}
          onLoad={() => void useUserStore.getState().loadTab(true)}
        />
      </div>
    )
  }

  if (tab === 'articles') {
    return (
      <div className="user-list-view">
        {user.articles.error && <ErrorBanner title="文章加载失败" message={user.articles.error} />}
        <div className="home-list">
          {user.articles.items.length === 0 && !user.articles.loading && <div className="list-empty muted">（暂无文章）</div>}
          {user.articles.items.map((a) => (
            <ArticleCard key={a.cid} article={a} active={false} onOpen={() => open(a.cid)} />
          ))}
        </div>
        <LazySentinel
          loading={user.articles.loading}
          hasMore={user.articles.hasMore}
          error={user.articles.error}
          onLoad={() => void useUserStore.getState().loadTab(true)}
        />
      </div>
    )
  }

  if (tab === 'reviews') {
    return (
      <div className="user-list-view">
        {user.reviews.error && <ErrorBanner title="评审加载失败" message={user.reviews.error} />}
        <div className="home-feed-list">
          {user.reviews.items.length === 0 && !user.reviews.loading && <div className="list-empty muted">（暂无评审）</div>}
          {user.reviews.items.map((r) => (
            <ReviewFeedCard
              key={String(r.id)}
              review={r}
              onOpen={() => open(String(r.cid ?? ''), { reviewId: String(r.id) })}
              onOpenUser={() => {
                const uid = String(r.uid ?? (r.userJson as Record<string, unknown> | undefined)?.uid ?? '')
                if (uid && uid !== '0') openUser(uid)
              }}
              onComment={() => open(String(r.cid ?? ''), { reviewId: String(r.id) })}
            />
          ))}
        </div>
        <LazySentinel
          loading={user.reviews.loading}
          hasMore={user.reviews.hasMore}
          error={user.reviews.error}
          onLoad={() => void useUserStore.getState().loadTab(true)}
        />
      </div>
    )
  }

  // comments
  return (
    <div className="user-list-view">
      {user.comments.error && <ErrorBanner title="评论加载失败" message={user.comments.error} />}
      <div className="home-feed-list">
        {user.comments.items.length === 0 && !user.comments.loading && <div className="list-empty muted">（暂无评论）</div>}
        {user.comments.items.map((c) => (
            <CommentFeedCard
              key={String(c.coid)}
              comment={c}
              onOpen={() => open(String(c.cid ?? ''), { commentId: String(c.coid) })}
              onOpenUser={() => {
                const uid = String(c.authorId ?? '')
                if (uid && uid !== '0') openUser(uid)
              }}
              onReply={() => open(String(c.cid ?? ''), { commentId: String(c.coid) })}
            />
          ))}
      </div>
      <LazySentinel
        loading={user.comments.loading}
        hasMore={user.comments.hasMore}
        error={user.comments.error}
        onLoad={() => void useUserStore.getState().loadTab(true)}
      />
    </div>
  )
}
