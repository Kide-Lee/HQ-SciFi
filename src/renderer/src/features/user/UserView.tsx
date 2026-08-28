import { useEffect, useRef, useState } from 'react'
import { LogOut, MessageCircle, UserCheck, UserPlus } from 'lucide-react'
import { useUiStore } from '../../stores/ui'
import { useAuthStore } from '../../stores/auth'
import { useReaderStore } from '../../stores/reader'
import { followItemDisplay, useUserStore } from '../../stores/user'
import { useChatStore } from '../../stores/chat'
import { ArticleCard } from '../../components/ArticleListView'
import { CommentFeedCard, ReviewFeedCard } from '../../components/FeedCards'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import { ErrorBanner } from '../../components/ErrorBanner'
import { cachedImageUrl, userDisplayName } from '../../lib/sanitize'
import type {
  CommentItem,
  FollowFeedItem,
  RemoteArticle,
  ReviewItem,
  UserFollowItem,
  UserMarkItem
} from '../../../../shared/types'

/** 用户页打开文章/评审/评论的深链跳转：退出用户页 → 打开文章 → 切右栏 tab + 定位目标 */


/** 动态条目 → 文章卡数据（发表的作品沿用 ArticleCard） */


/** 动态条目 → 评审卡数据（复用 ReviewFeedCard，保留评分与评论数） */


/** 动态条目 → 评论卡数据（复用 CommentFeedCard） */


/** 粉丝/关注卡片（两列网格；关注列表可取关，粉丝列表可回关，均含私聊） */


/** 收藏文章卡：markList 条目字段与文章列表条目基本同构，直接映射为 RemoteArticle 复用 ArticleCard */


import { useOpenFromUser, feedToArticle, feedToReview, feedToComment, markToArticle } from './helpers'
import { FollowRow } from './FollowRow'
import { UserListTab } from './UserListTab'
import { LazySentinel } from './LazySentinel'

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


/** 懒加载哨兵：进入视口（提前 240px）自动加载下一页，策略与作品库列表一致 */

