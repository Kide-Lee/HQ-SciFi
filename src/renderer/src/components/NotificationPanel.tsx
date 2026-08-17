import { useEffect, useState } from 'react'
import { CheckCheck } from 'lucide-react'
import { NOTIFICATION_CATEGORY_LABEL, useNotificationStore, type NotificationCategory } from '../stores/notifications'
import { formatTs } from '../lib/sanitize'
import { useReaderStore } from '../stores/reader'
import { useUiStore } from '../stores/ui'
import { CommentFeedCard, ReviewFeedCard } from './FeedCards'
import type { AppNotification } from '../../../shared/types'

const CATEGORIES: NotificationCategory[] = ['comment', 'review', 'finance', 'system']

/**
 * v0.0.9：右栏「消息」内容区。
 * 分类 tab（评论/评审/财务/系统）复用评审界面的 tab 视觉；
 * 评论/评审消息直接复用最新讨论卡/最新评审卡。
 */
export function NotificationPanel(): React.JSX.Element {
  const notifications = useNotificationStore((s) => s.notifications)
  const loading = useNotificationStore((s) => s.loading)
  const error = useNotificationStore((s) => s.error)
  const load = useNotificationStore((s) => s.load)
  const markRead = useNotificationStore((s) => s.markRead)
  const markCategoryRead = useNotificationStore((s) => s.markCategoryRead)
  const openArticle = useReaderStore((s) => s.openArticle)
  const openPanelTab = useUiStore((s) => s.openPanelTab)
  const openUserPage = useUiStore((s) => s.openUserPage)
  const [category, setCategory] = useState<NotificationCategory>('comment')

  // 每次打开消息面板都重新拉取，保证列表和未读数是最新的
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const list = notifications.filter((n) => n.category === category)
  const unreadCount = list.filter((n) => !n.read).length

  function openMessage(n: AppNotification): void {
    if (!n.cid) return
    const cid = String(n.cid)
    const ui = useUiStore.getState()
    const reader = useReaderStore.getState()
    // 用户页打开消息时先退出用户页，否则 MainArea 会继续停留在用户页
    if (ui.userPageUid) ui.closeUserPage()
    const tab = n.review ? 'review' : n.comment?.reviewid ? 'review' : 'comments'
    if (n.review?.id) {
      reader.setTarget({ cid, reviewId: String(n.review.id) })
    } else if (n.comment?.coid) {
      reader.setTarget({
        cid,
        ...(n.comment.reviewid ? { reviewId: String(n.comment.reviewid) } : {}),
        commentId: String(n.comment.coid)
      })
    }
    void openArticle(cid)
    openPanelTab(tab)
  }

  function openMessageUser(n: AppNotification): void {
    const uid = String(n.comment?.authorId ?? n.review?.uid ?? '')
    if (uid && uid !== '0') openUserPage(uid)
  }

  return (
    <div className="notification-panel">
      <div className="notification-tabs">
        {CATEGORIES.map((c) => {
          const count = notifications.filter((n) => n.category === c && !n.read).length
          return (
            <button
              key={c}
              className={`notification-tab${category === c ? ' active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {NOTIFICATION_CATEGORY_LABEL[c]}
              {count > 0 ? <span className="notification-tab-badge">{count}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="notification-toolbar">
        <span className="notification-count muted">
          {loading ? '加载中 …' : unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}
        </span>
        {unreadCount > 0 && (
          <button className="notification-read-all" onClick={() => void markCategoryRead(category)}>
            <CheckCheck size={13} />
            全部已读
          </button>
        )}
      </div>

      <div className="notification-list">
        {error && (
          <div className="muted notification-empty">
            加载失败：{error}
            <button className="notification-read-all" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {!loading && !error && list.length === 0 && <div className="muted notification-empty">（暂无消息）</div>}
        {list.map((n) => {
          // 评论/评审消息复用信息流卡片，保持与最新讨论/最新评审一致的视觉
          if (n.comment) {
            return (
              <div key={n.id} className={n.read ? 'notification-feed' : 'notification-feed unread'}>
                <CommentFeedCard
                  comment={n.comment}
                  onOpen={() => openMessage(n)}
                  onOpenUser={() => openMessageUser(n)}
                  headerAction={
                    !n.read ? (
                      <button
                        className="notification-mark-read"
                        onClick={(e) => {
                          e.stopPropagation()
                          void markRead(n.id)
                        }}
                      >
                        标记已读
                      </button>
                    ) : undefined
                  }
                />
              </div>
            )
          }
          if (n.review) {
            return (
              <div key={n.id} className={n.read ? 'notification-feed' : 'notification-feed unread'}>
                <ReviewFeedCard
                  review={n.review}
                  onOpen={() => openMessage(n)}
                  onOpenUser={() => openMessageUser(n)}
                  headerAction={
                    !n.read ? (
                      <button
                        className="notification-mark-read"
                        onClick={(e) => {
                          e.stopPropagation()
                          void markRead(n.id)
                        }}
                      >
                        标记已读
                      </button>
                    ) : undefined
                  }
                />
              </div>
            )
          }
          return (
            <div key={n.id} className={`notification-item${n.read ? '' : ' unread'}`}>
              <div className="notification-item-head">
                <span className="notification-item-title">
                  {!n.read && <span className="notification-dot" />}
                  {n.title}
                </span>
                <span className="notification-item-time">{formatTs(n.time)}</span>
              </div>
              <div className="notification-item-text">{n.text}</div>
              {!n.read && (
                <button className="notification-mark-read" onClick={() => void markRead(n.id)}>
                  标记已读
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
