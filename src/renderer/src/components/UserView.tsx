import { useEffect, useRef, useState } from 'react'
import { LogOut, MessageCircle, UserCheck, UserPlus } from 'lucide-react'
import { useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { useReaderStore } from '../stores/reader'
import { followItemDisplay, useUserStore } from '../stores/user'
import { useChatStore } from '../stores/chat'
import { ArticleCard } from './ArticleListView'
import { CommentFeedCard, ReviewFeedCard } from './FeedCards'
import { UserLevelBadge } from './UserLevelBadge'
import { ErrorBanner } from './ErrorBanner'
import { cachedImageUrl, userDisplayName } from '../lib/sanitize'
import type {
  CommentItem,
  FollowFeedItem,
  RemoteArticle,
  ReviewItem,
  UserFollowItem,
  UserMarkItem
} from '../../../shared/types'

/** 用户页打开文章/评审/评论的深链跳转：退出用户页 → 打开文章 → 切右栏 tab + 定位目标 */
function useOpenFromUser(): (
  cid: string,
  opts?: { reviewId?: string; commentId?: string }
) => void {
  const openArticle = useReaderStore((s) => s.openArticle)
  return (cid, opts) => {
    const ui = useUiStore.getState()
    const reader = useReaderStore.getState()
    ui.closeUserPage()
    if (opts?.reviewId || opts?.commentId) {
      reader.setTarget({
        cid,
        ...(opts.reviewId ? { reviewId: opts.reviewId } : {}),
        ...(opts.commentId ? { commentId: opts.commentId } : {})
      })
    }
    void openArticle(cid)
    if (opts?.reviewId) ui.openPanelTab('review')
    else if (opts?.commentId) ui.openPanelTab('comments')
  }
}

/** 动态条目 → 文章卡数据（发表的作品沿用 ArticleCard） */
function feedToArticle(item: FollowFeedItem): RemoteArticle {
  return {
    cid: item.cid,
    title: item.articleTitle ?? item.cid,
    type: 'post',
    status: 'publish',
    score: item.score ?? '-.-',
    text: item.text ?? '',
    authorId: item.uid,
    authorInfo: {
      uid: item.uid,
      name: item.userName ?? '',
      avatar: item.avatar ?? '',
      experience: item.experience
    },
    views: item.views ?? 0,
    likes: item.likes ?? 0,
    commentsNum: item.commentsNum ?? 0,
    created: item.created,
    modified: 0,
    isAnonymous: false,
    active: null,
    size: item.size,
    hideScore: item.hideScore === true
  }
}

/** 动态条目 → 评审卡数据（复用 ReviewFeedCard，保留评分与评论数） */
function feedToReview(item: FollowFeedItem): ReviewItem {
  return {
    id: item.reviewId ?? '',
    cid: item.cid,
    uid: item.uid,
    actualscore: item.score,
    zonghe: item.text,
    replyNum: item.replyNum,
    userJson: {
      uid: item.uid,
      name: item.userName ?? '',
      avatar: item.avatar ?? '',
      experience: item.experience
    },
    articleInfo: { title: item.articleTitle ?? '' },
    created: item.created,
    hideScore: item.hideScore === true
  }
}

/** 动态条目 → 评论卡数据（复用 CommentFeedCard） */
function feedToComment(item: FollowFeedItem): CommentItem {
  return {
    coid: item.commentId ?? '',
    cid: item.cid,
    parent: 0,
    text: item.text ?? '',
    articleTitle: item.articleTitle,
    author: item.userName ?? '',
    authorId: item.uid,
    avatar: item.avatar,
    created: item.created,
    reviewid: item.reviewid,
    reviewAuthor: item.reviewAuthor,
    experience: item.experience
  }
}

/** 粉丝/关注卡片（两列网格；关注列表可取关，粉丝列表可回关，均含私聊） */
function FollowRow({
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

/** 收藏文章卡：markList 条目字段与文章列表条目基本同构，直接映射为 RemoteArticle 复用 ArticleCard */
function markToArticle(m: UserMarkItem): RemoteArticle {
  return {
    cid: m.cid,
    title: m.title,
    type: m.type ?? 'post',
    status: 'publish',
    score: m.score ?? '-.-',
    text: m.text ?? '',
    authorId: m.authorId ?? '',
    authorInfo: m.authorInfo,
    cover: m.cover,
    introduction: undefined,
    views: m.views ?? 0,
    likes: m.likes ?? 0,
    commentsNum: m.commentsNum ?? 0,
    created: m.created ?? 0,
    modified: 0,
    isAnonymous: false,
    active: m.active ?? null,
    size: m.size,
    images: m.images,
    hideScore: m.hideScore === true
  }
}

export function UserView(): React.JSX.Element | null {
  const userPageUid = useUiStore((s) => s.userPageUid)
  const openUser = useUiStore((s) => s.openUserPage)
  const user = useUserStore()
  const logout = useAuthStore((s) => s.logout)
  const open = useOpenFromUser()
  const readingCid = useReaderStore((s) => s.readingCid)

  // 用户页打开/切换目标时初始化 user store（uid 相同则仅回到主页）
  useEffect(() => {
    if (userPageUid) void useUserStore.getState().openUserPage(userPageUid)
  }, [userPageUid])

  // 当前视图未初始化完成（uid 不匹配）时给加载态
  if (!userPageUid || user.uid !== userPageUid) {
    return (
      <div className="user-view loading">
        <span className="muted">正在加载用户页 …</span>
      </div>
    )
  }

  const profile = user.profile
  const name = profile ? userDisplayName(profile as unknown as Record<string, unknown>, `UID ${user.uid}`) : `UID ${user.uid}`
  const avatar = profile?.avatar ? cachedImageUrl(profile.avatar) : undefined
  const bg = profile?.userBg ? cachedImageUrl(profile.userBg) : undefined
  const stats = user.stats
  const home = user.home
  const tab = user.tab
  // 服务端占位评论已在主进程适配层过滤

  const statsCells: Array<{ label: string; value: number | string; onClick: () => void }> = [
    { label: '文章', value: stats ? stats.contentsNum : '-', onClick: () => user.setTab('articles') },
    { label: '评论', value: stats ? stats.commentsNum : '-', onClick: () => user.setTab('comments') },
    {
      label: '粉丝',
      value: stats ? stats.fanNum : '-',
      onClick: () => {
        user.setTab('fans')
        user.setFanMode('fans')
      }
    }
  ]
  if (user.isSelf) {
    statsCells.push({
      label: '关注',
      value: user.followTotal ?? '-',
      onClick: () => {
        user.setTab('fans')
        user.setFanMode('follows')
      }
    })
  }

  function handleLogout(): void {
    void logout()
    useUiStore.getState().closeUserPage()
  }

  return (
    <div className="user-view">
        {/* 头部背景 + 用户信息 */}
        <div className="user-banner" style={bg ? { backgroundImage: `url("${bg}")` } : undefined}>
          <div className="user-banner-mask" />
          <div className="user-head">
            <button
              className="user-avatar-btn"
              onClick={() => useUserStore.getState().setTab('home')}
              title="回到用户主页"
            >
              {avatar ? (
                <img className="user-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span className="user-avatar user-avatar-fallback">{[...name][0] || '?'}</span>
              )}
            </button>
            <div className="user-head-main">
              <div className="user-head-name-row">
                <span className="user-head-name">{name}</span>
                <UserLevelBadge experience={profile?.experience} />
              </div>
              <div className="user-head-uid">UID {user.uid}</div>
              {profile?.introduce ? <div className="user-head-intro">{profile.introduce}</div> : null}
            </div>
            <div className="user-head-actions">
              {user.isSelf ? (
                <button className="user-action-btn" onClick={handleLogout} title="退出登录">
                  <LogOut size={14} /> 退出
                </button>
              ) : (
                <>
                  <button
                    className="user-action-btn"
                    onClick={() => useChatStore.getState().open({ uid: user.uid ?? '', name, avatar })}
                    title="私聊"
                  >
                    <MessageCircle size={14} /> 私聊
                  </button>
                  <button
                    className={`user-action-btn follow${user.followState ? ' following' : ''}`}
                    disabled={user.followBusy}
                    onClick={() => void user.toggleFollow()}
                    title={user.followState ? '取消关注' : '关注'}
                  >
                    {user.followState ? <UserCheck size={14} /> : <UserPlus size={14} />}
                    {user.followState ? '已关注' : '关注'}
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="user-stats">
            {statsCells.map((c) => (
              <button className="user-stat" key={c.label} onClick={c.onClick} title={`查看${c.label}`}>
                <b>{c.value}</b>
                <i>{c.label}</i>
              </button>
            ))}
          </div>
        </div>

        {tab === 'home' ? (
          <div className="user-home">
            {home.loading && <div className="muted">正在加载主页 …</div>}
            {home.error && <ErrorBanner title="用户页加载失败" message={home.error} />}

            {/* v0.0.8 反馈：没有内容的栏目直接隐藏 */}
            {!home.loading &&
              home.marks.length === 0 &&
              home.articles.length === 0 &&
              home.reviews.length === 0 &&
              home.comments.length === 0 && <div className="list-empty muted">（暂无内容）</div>}

            {user.isSelf && home.marks.length > 0 && (
              <section className="home-section">
                <h2 className="home-section-title">收藏</h2>
                <div className="home-list">
                  {home.marks.map((m) => (
                    <ArticleCard
                      key={m.cid}
                      article={markToArticle(m)}
                      active={readingCid === m.cid}
                      onOpen={() => open(m.cid)}
                    />
                  ))}
                </div>
              </section>
            )}

            {home.articles.length > 0 && (
              <section className="home-section">
                <h2 className="home-section-title">文章</h2>
                <div className="home-list">
                  {home.articles.map((a) => (
                    <ArticleCard
                      key={a.cid}
                      article={a}
                      active={readingCid === a.cid}
                      onOpen={() => open(a.cid)}
                    />
                  ))}
                </div>
              </section>
            )}

            {home.reviews.length > 0 && (
              <section className="home-section">
                <h2 className="home-section-title">评审</h2>
                <div className="home-feed-list">
                  {home.reviews.map((r) => (
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
              </section>
            )}

            {home.comments.length > 0 && (
              <section className="home-section">
                <h2 className="home-section-title">评论</h2>
                <div className="home-feed-list">
                  {home.comments.map((c) => (
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
              </section>
            )}
          </div>
        ) : (
          <UserListTab />
        )}
    </div>
  )
}

/** 左栏 tab 对应的全量列表视图 */
function UserListTab(): React.JSX.Element {
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

/** 懒加载哨兵：进入视口（提前 240px）自动加载下一页，策略与作品库列表一致 */
function LazySentinel({
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
