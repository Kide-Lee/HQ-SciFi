import { useEffect, useMemo, useState } from 'react'
import { CheckCheck } from 'lucide-react'
import { useNotificationStore, type NotificationCategory } from '../stores/notifications'
import { useChatStore } from '../stores/chat'
import { cachedImageUrl, formatTs } from '../lib/sanitize'
import { useReaderStore } from '../stores/reader'
import { useUiStore } from '../stores/ui'
import { CommentFeedCard, ReviewFeedCard } from './FeedCards'
import type { AppNotification, ChatSession } from '../../../shared/types'

type NotificationGroup = 'interact' | 'chat' | 'notice'

/** v0.0.10：消息中心合并分类——互动（评论+评审）、私聊、通知（粉丝+系统+财务） */
const CATEGORY_GROUPS: Array<{ key: NotificationGroup; label: string; categories: NotificationCategory[] }> = [
  { key: 'interact', label: '互动', categories: ['comment', 'review'] },
  { key: 'chat', label: '私聊', categories: ['chat'] },
  { key: 'notice', label: '通知', categories: ['fan', 'system', 'finance'] }
]

/** 私聊用户卡片：头像 + 昵称 + 最近消息 + 时间；有未读时置顶展示并带角标 */
function ChatSessionCard({ session, onOpen }: { session: ChatSession; onOpen: () => void }): React.JSX.Element {
  const avatar = session.avatar && /^https?:\/\//i.test(session.avatar) ? cachedImageUrl(session.avatar) : undefined
  return (
    <button className={`chat-session-card${session.unread > 0 ? ' unread' : ''}`} onClick={onOpen}>
      {avatar ? (
        <img className="chat-session-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="chat-session-avatar chat-session-avatar-fallback">{session.name.slice(0, 1)}</span>
      )}
      <span className="chat-session-main">
        <span className="chat-session-head">
          <span className="chat-session-name">{session.name}</span>
          <span className="chat-session-time">{session.lastTime ? formatTs(session.lastTime) : ''}</span>
        </span>
        <span className="chat-session-last">{session.lastMsg || '（暂无消息）'}</span>
      </span>
      {session.unread > 0 && <span className="chat-session-badge">{session.unread}</span>}
    </button>
  )
}

/**
 * v0.0.9：右栏「消息」内容区。
 * 分组 tab（互动/私聊/通知）复用评审界面的 tab 视觉；
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
  const [groupKey, setGroupKey] = useState<NotificationGroup>('interact')
  // v0.0.10：私聊会话列表（hqChat/myChat），仅在「私聊」tab 加载并轮询
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatReloadKey, setChatReloadKey] = useState(0)

  // 每次打开消息面板都重新拉取，保证列表和未读数是最新的
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 进入「私聊」tab 拉取会话列表；停留期间轮询，保证新私聊能置顶
  useEffect(() => {
    if (groupKey !== 'chat') return
    let alive = true
    const run = async (): Promise<void> => {
      setChatLoading(true)
      try {
        const res = await window.hqsf.listChatSessions()
        if (!alive) return
        if (res.ok) {
          setChatSessions(res.data.items)
          setChatError(null)
        } else {
          setChatError(res.error)
        }
      } catch (err) {
        if (alive) setChatError((err as Error).message)
      } finally {
        if (alive) setChatLoading(false)
      }
    }
    void run()
    const timer = window.setInterval(() => void run(), 15000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [groupKey, chatReloadKey])

  const group = CATEGORY_GROUPS.find((g) => g.key === groupKey) ?? CATEGORY_GROUPS[0]
  const list = notifications.filter((n) => group.categories.includes(n.category))
  const unreadCount =
    group.key === 'chat'
      ? chatSessions.reduce((sum, s) => sum + s.unread, 0)
      : list.filter((n) => !n.read).length

  const sortedChatSessions = useMemo(
    () =>
      [...chatSessions].sort((a, b) => {
        // 新私聊（未读）置顶；同未读状态按最近消息时间倒序
        const aUnread = a.unread > 0 ? 1 : 0
        const bUnread = b.unread > 0 ? 1 : 0
        return bUnread - aUnread || b.lastTime - a.lastTime
      }),
    [chatSessions]
  )

  async function markGroupRead(): Promise<void> {
    if (group.key === 'chat') {
      if (unreadCount === 0) return
      const res = await window.hqsf.markNotificationsRead(['chat'])
      if (res.ok) {
        setChatSessions((list) => list.map((s) => ({ ...s, unread: 0 })))
        await useNotificationStore.getState().refreshUnread()
      } else {
        setChatError(res.error)
      }
      return
    }
    await Promise.all(group.categories.map((c) => markCategoryRead(c)))
  }

  function openChatSession(s: ChatSession): void {
    useChatStore.getState().open({ uid: s.uid, name: s.name, avatar: s.avatar })
    if (s.unread <= 0) return
    // 打开即视为已读：清本地未读并通知主进程标记 chat 分类已读
    setChatSessions((list) => list.map((x) => (x.chatid === s.chatid ? { ...x, unread: 0 } : x)))
    void (async () => {
      const res = await window.hqsf.markNotificationsRead(['chat'])
      if (res.ok) await useNotificationStore.getState().refreshUnread()
      else setChatError(res.error)
    })()
  }

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
        {CATEGORY_GROUPS.map((g) => {
          const count =
            g.key === 'chat'
              ? chatSessions.reduce((sum, s) => sum + s.unread, 0)
              : notifications.filter((n) => g.categories.includes(n.category) && !n.read).length
          return (
            <button
              key={g.key}
              className={`notification-tab${group.key === g.key ? ' active' : ''}`}
              onClick={() => setGroupKey(g.key)}
            >
              {g.label}
              {count > 0 ? <span className="notification-tab-badge">{count}</span> : null}
            </button>
          )
        })}
      </div>

      <div className="notification-toolbar">
        <span className="notification-count muted">
          {loading || (group.key === 'chat' && chatLoading && sortedChatSessions.length === 0) ? '加载中 …' : unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}
        </span>
        {unreadCount > 0 && (
          <button className="notification-read-all" onClick={() => void markGroupRead()}>
            <CheckCheck size={13} />
            全部已读
          </button>
        )}
      </div>

      <div className="notification-list">
        {group.key === 'chat' ? (
          <>
            {chatError && (
              <div className="muted notification-empty">
                私聊列表加载失败：{chatError}
                <button className="notification-read-all" onClick={() => setChatReloadKey((k) => k + 1)}>
                  重试
                </button>
              </div>
            )}
            {chatLoading && sortedChatSessions.length === 0 && <div className="muted notification-empty">加载中…</div>}
            {!chatLoading && !chatError && sortedChatSessions.length === 0 && (
              <div className="muted notification-empty">（暂无私聊）</div>
            )}
            {sortedChatSessions.map((s) => (
              <ChatSessionCard key={s.chatid} session={s} onOpen={() => openChatSession(s)} />
            ))}
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}
