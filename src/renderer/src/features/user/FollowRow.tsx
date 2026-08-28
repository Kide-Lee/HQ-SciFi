import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle, UserCheck, UserPlus } from 'lucide-react'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { useReaderStore } from '../../stores/reader'
import { useUserStore } from '../../stores/user'
import { useChatStore } from '../../stores/chat'
import { cachedImageUrl, formatTs, userDisplayName, userAvatarUrl } from '../../lib/sanitize'
import { followItemDisplay } from '../../stores/user'
import { ErrorBanner } from '../../components/ErrorBanner'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import { ArticleCard } from '../../components/ArticleListView'
import { ReviewFeedCard, CommentFeedCard } from '../../components/FeedCards'
import type { RemoteArticle, ReviewItem, CommentItem, FollowFeedItem, UserMarkItem, UserFollowItem, UserProfile, UserStats, UserPageTab } from '../../../../shared/types'

export function FollowRow({
  f,
  mode
}: {
  f: UserFollowItem
  mode: 'follows' | 'fans'
}): React.JSX.Element {
  const d = followItemDisplay(f)
  const openUser = useUiStore((s) => s.openUserPage)
  const isSelf = useUserStore((s) => s.isSelf)
  const [busy, setBusy] = useState(false)
  // 关注列表里的用户一定已关注；粉丝/他人页需要查询当前登录用户是否已关注对方
  const [following, setFollowing] = useState<boolean | null>(mode === 'follows' ? true : null)
  const avatar = d.avatar ? cachedImageUrl(d.avatar) : undefined
  const uid = d.uid && d.uid !== '0' ? d.uid : String(f.touid ?? '')
  const clickable = uid !== '' && uid !== '0'

  useEffect(() => {
    if (mode === 'follows') {
      setFollowing(true)
      return
    }
    if (!uid) return
    let alive = true
    void window.hqsf.getFollowState(uid).then((res) => {
      if (alive && res.ok) setFollowing(res.data)
    })
    return () => {
      alive = false
    }
  }, [mode, uid])

  const actionLabel =
    mode === 'follows'
      ? '取关'
      : following === true
        ? '取关'
        : isSelf
          ? '回关'
          : '关注'

  async function handleFollowAction(): Promise<void> {
    if (!uid || busy || following == null) return
    setBusy(true)
    const follow = mode === 'fans' ? !following : false
    const res = await window.hqsf.followUser(uid, follow)
    setBusy(false)
    if (res.ok && res.data.ok) {
      setFollowing(follow)
      void useUserStore.getState().loadTab()
    } else {
      void window.hqsf.showMessageBox({
        type: 'error',
        title: follow ? '关注失败' : '取关失败',
        message: res.ok ? res.data.error ?? '操作失败' : res.error
      })
    }
  }

  return (
    <div className="user-follow-card">
      <div
        className={`user-follow-main${clickable ? '' : ' disabled'}`}
        role="button"
        tabIndex={clickable ? 0 : -1}
        onClick={() => {
          if (clickable) openUser(uid)
        }}
        onKeyDown={(e) => {
          if (clickable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            openUser(uid)
          }
        }}
        title={clickable ? `查看 ${d.name || uid} 的主页` : undefined}
      >
        {avatar ? (
          <img className="comment-avatar" src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="comment-avatar comment-avatar-placeholder" />
        )}
        <span className="user-follow-meta">
          <span className="user-follow-name-row">
            <span className="user-follow-name">{d.name || `UID ${uid}`}</span>
            <UserLevelBadge experience={d.experience} />
          </span>
          {d.introduce ? <span className="user-follow-intro">{d.introduce}</span> : null}
        </span>
      </div>
      <div className="user-follow-actions">
        <button
          className="user-follow-action"
          onClick={() => void handleFollowAction()}
          disabled={busy || !uid || following == null}
        >
          {following === true ? <UserCheck size={13} /> : <UserPlus size={13} />}
          {busy ? '处理中…' : actionLabel}
        </button>
        <button
          className="user-follow-action"
          onClick={() => useChatStore.getState().open({ uid, name: d.name || `UID ${uid}`, avatar: d.avatar })}
        >
          <MessageCircle size={13} />
          私聊
        </button>
      </div>
    </div>
  )
}
