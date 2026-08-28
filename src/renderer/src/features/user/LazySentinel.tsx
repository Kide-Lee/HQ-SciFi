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

export function LazySentinel({
  loading,
  hasMore,
  error,
  onLoad
}: {
  loading: boolean
  hasMore: boolean
  error: string | null
  onLoad: () => void
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null)
  const busyRef = useRef(false)
  const onLoadRef = useRef(onLoad)
  useEffect(() => {
    onLoadRef.current = onLoad
  }, [onLoad])

  useEffect(() => {
    const el = ref.current
    if (!el || !hasMore || error) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || busyRef.current) return
        busyRef.current = true
        onLoadRef.current()
      },
      { rootMargin: '240px 0px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, error])

  useEffect(() => {
    if (!loading) busyRef.current = false
  }, [loading])

  if (!hasMore) return <div className="muted">已加载全部</div>
  return <div ref={ref} className="user-lazy-sentinel">
    {loading ? '加载中 …' : ''}
  </div>
}
