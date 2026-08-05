import { useEffect, useRef } from 'react'
import { ARTICLE_ORDERS, useReaderStore } from '../stores/reader'
import { cachedImageUrl, formatTs } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import type { RemoteArticle } from '../../../shared/types'

/**
 * 文章列表视图（作品库/浏览入口）：
 * 拉取远端文章列表（contentsList 或 getMetaContents 分类），点击进入阅读视图。
 * 懒加载：底部哨兵进入视口（提前 240px）自动加载下一页，无需按钮。
 * M3 将接入推荐/连载/活动等栏目，此组件作为通用列表载体。
 */
export function ArticleListView({
  title,
  mid,
  searchParams
}: {
  title: string
  mid?: number | string
  searchParams?: Record<string, unknown>
}): React.JSX.Element {
  const list = useReaderStore((s) => s.list)
  const listTotal = useReaderStore((s) => s.listTotal)
  const listLoading = useReaderStore((s) => s.listLoading)
  const listError = useReaderStore((s) => s.listError)
  const listOrder = useReaderStore((s) => s.listOrder)
  const listHasMore = useReaderStore((s) => s.listHasMore)
  const loadList = useReaderStore((s) => s.loadList)
  const setOrder = useReaderStore((s) => s.setOrder)
  const clearList = useReaderStore((s) => s.clearList)
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /** 防重入：加载进行中不重复触发（IntersectionObserver 回调无 state 闭包问题） */
  const loadingRef = useRef(false)

  // 榜单（非时间排序）显示排名
  const isRanked = listOrder !== 'created'
  const hasMore = listHasMore && list.length > 0

  // 切换栏目时重拉列表
  useEffect(() => {
    clearList()
    void loadList({ mid, searchParams, order: 'created' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mid, JSON.stringify(searchParams)])

  // 无限滚动：哨兵进入视口（提前 240px）自动加载下一页
  useEffect(() => {
    const sentinel = sentinelRef.current
    // 无更多、首屏加载中、或出错了都不触发自动加载
    if (!sentinel || !hasMore || (listLoading && list.length === 0) || listError) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingRef.current || listLoading) return
        loadingRef.current = true
        void loadList({ mid, searchParams, append: true }).finally(() => {
          loadingRef.current = false
        })
      },
      { rootMargin: '240px 0px' }
    )
    obs.observe(sentinel)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mid, JSON.stringify(searchParams), listOrder, hasMore, listLoading, listError])

  return (
    <div className="article-list-view">
      <div className="list-toolbar">
        <span className="list-title">{title}</span>
        <div className="list-orders">
          {ARTICLE_ORDERS.map((o) => (
            <button
              key={o.key}
              className={`order-btn ${listOrder === o.key ? 'active' : ''}`}
              onClick={() => setOrder(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {listError && <ErrorBanner title="列表加载失败" message={listError} />}

      <div className="article-list">
        {listLoading && list.length === 0 && <div className="list-empty muted">加载中 …</div>}
        {!listLoading && list.length === 0 && !listError && (
          <div className="list-empty muted">（该栏目暂无文章）</div>
        )}
        {list.map((a, idx) => (
          <ArticleCard
            key={a.cid}
            article={a}
            rank={isRanked ? idx + 1 : undefined}
            active={readingCid === a.cid}
            onOpen={() => void openArticle(a.cid)}
          />
        ))}
      </div>

      {/* 加载哨兵：滚近底部自动加载下一页 */}
      <div className="list-more" ref={sentinelRef}>
        {list.length > 0 && !listHasMore ? (
          <span className="muted">已加载全部 {list.length} 篇</span>
        ) : listLoading && list.length > 0 ? (
          <span className="muted">加载中 …</span>
        ) : null}
      </div>
    </div>
  )
}

function ArticleCard({
  article,
  rank,
  active,
  onOpen
}: {
  article: RemoteArticle
  /** 榜单排名（非时间排序时传入，1 起） */
  rank?: number
  active: boolean
  onOpen: () => void
}): React.JSX.Element {
  const author = article.authorInfo as Record<string, unknown> | undefined
  const authorName = String(
    author?.nickname ?? author?.nick ?? author?.nickName ?? author?.name ?? (article.authorId ? `UID ${article.authorId}` : '佚名')
  )
  // 作者头像（authorInfo.avatar；仅 http(s) 走缓存协议）
  const avatarRaw = String(author?.avatar ?? author?.headImg ?? author?.avatarUrl ?? '')
  const avatar = avatarRaw && /^https?:\/\//i.test(avatarRaw) ? cachedImageUrl(avatarRaw) : undefined
  // 封面：images[0] 优先（官方列表字段），cover 兜底；仅 http(s) 图片进缓存协议
  const coverRaw = (article.images && article.images[0]) || article.cover
  const cover = coverRaw && /^https?:\/\//i.test(coverRaw) ? cachedImageUrl(coverRaw) : undefined
  return (
    <button className={`article-card ${active ? 'active' : ''}`} onClick={onOpen}>
      {cover ? (
        <div className="article-card-cover">
          <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </div>
      ) : null}
      <div className="article-card-body">
        <div className="article-card-title">
          <span className="article-card-title-text">{article.title}</span>
          {rank != null && (
            <span className={`article-rank ${rank <= 3 ? `top-${rank}` : ''}`} title={`第 ${rank} 名`}>
              {rank}
            </span>
          )}
        </div>
        {article.text && <div className="article-card-excerpt">{article.text}</div>}
        <div className="article-card-meta">
          <span className="article-card-author">
            {avatar ? (
              <img className="author-avatar" src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ) : null}
            {authorName}
          </span>
          {/* 统计组：靠右对齐，跨卡片右缘对齐；计数项（阅读/赞/评论）始终显示，0 也占位 */}
          <span className="article-card-stats">
            <span>{article.views} 阅读</span>
            <span>{article.likes} 赞</span>
            <span>{article.commentsNum} 评论</span>
            {/* 评分栏位始终保留（无评分显示灰色占位），保证跨卡片对齐 */}
            <span className={`card-score ${article.score && article.score !== '-.-' ? '' : 'no-score'}`}>
              {article.score && article.score !== '-.-' ? `${article.score} 分` : '-.- 分'}
            </span>
            {article.created ? <span>{formatTs(article.created)}</span> : null}
          </span>
        </div>
      </div>
    </button>
  )
}
