import { useEffect, useMemo, useRef } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { ARTICLE_ORDERS, useReaderStore } from '../stores/reader'
import { cachedImageUrl, formatSize, formatTs, scoreColor } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import { CoverImage } from './CoverImage'
import { SkeletonArticleCard } from './Skeletons'
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
  searchParams,
  choice = false,
  activityPhase,
  activityMeta
}: {
  title: string
  mid?: number | string
  searchParams?: Record<string, unknown>
  /** 精选源（choiceList）：固定顺序，无排序按钮 */
  choice?: boolean
  /** 活动状态（v0.0.2）：进行中/评审中隐藏评分榜排序、评分与排名 */
  activityPhase?: 'ongoing' | 'reviewing' | 'ended'
  /** 活动 meta（v0.0.2：列表页顶部展示活动介绍） */
  activityMeta?: {
    mid: number | string
    name: string
    imgurl?: string
    description?: string
    deadline?: number
  }
}): React.JSX.Element {
  const list = useReaderStore((s) => s.list)
  const listTotal = useReaderStore((s) => s.listTotal)
  const listLoading = useReaderStore((s) => s.listLoading)
  const listError = useReaderStore((s) => s.listError)
  const listOrder = useReaderStore((s) => s.listOrder)
  const listOrderAsc = useReaderStore((s) => s.listOrderAsc)
  const listHasMore = useReaderStore((s) => s.listHasMore)
  const loadList = useReaderStore((s) => s.loadList)
  const setOrder = useReaderStore((s) => s.setOrder)
  const toggleOrderAsc = useReaderStore((s) => s.toggleOrderAsc)
  const clearList = useReaderStore((s) => s.clearList)
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)
  const loadReviewTasks = useReaderStore((s) => s.loadReviewTasks)

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /** 防重入：加载进行中不重复触发（IntersectionObserver 回调无 state 闭包问题） */
  const loadingRef = useRef(false)

  // 评审任务集合：登录后全局拉一次（幂等），命中任务的文章卡片做强调标记
  useEffect(() => {
    void loadReviewTasks()
  }, [loadReviewTasks])

  // 榜单排序（评分/点赞/评论/阅读）显示排名；按时间/字数/回复是浏览排序不显示
  const RANK_ORDERS = new Set(['score', 'likes', 'commentsNum', 'views'])
  // v0.0.2：进行中/评审中活动文章无评分 → 隐藏「评分榜」排序、评分与排名
  const hideScoreboard = activityPhase === 'ongoing' || activityPhase === 'reviewing'
  const orders = hideScoreboard ? ARTICLE_ORDERS.filter((o) => o.key !== 'score') : ARTICLE_ORDERS
  const isRanked = !hideScoreboard && RANK_ORDERS.has(listOrder)
  const hasMore = listHasMore && list.length > 0

  /**
   * 并列排名：按排序键值分组，相同键值同 rank（竞赛式跳号 1,2,2,4）。
   * 名次基于「降序键值」计算（与当前展示方向无关）：最高分永远第 1 名；
   * 无评分（score='-.-'）或键值为空不参与排名。
   */
  const rankOf = useMemo(() => {
    if (!isRanked) return null
    const keyOf = (a: RemoteArticle): number | null => {
      switch (listOrder) {
        case 'score': {
          const s = Number.parseFloat(a.score)
          return a.score !== '-.-' && Number.isFinite(s) ? s : null
        }
        case 'likes':
          return a.likes
        case 'commentsNum':
          return a.commentsNum
        case 'views':
          return a.views
        default:
          return null
      }
    }
    const withKey = list.map((a) => ({ a, k: keyOf(a) }))
    const desc = [...withKey].sort((x, y) => (y.k ?? -Infinity) - (x.k ?? -Infinity))
    const map = new Map<string, number | undefined>()
    let prev: number | null = null
    let rank = 0
    desc.forEach((w, i) => {
      if (w.k == null) {
        map.set(w.a.cid, undefined)
        return
      }
      // 竞赛式跳号：与上一名键值相同则沿用同名次（1,2,2,4），否则取降序位置序号
      if (prev === null || w.k !== prev) rank = i + 1
      map.set(w.a.cid, rank)
      prev = w.k
    })
    return map
  }, [list, listOrder, isRanked])

  // 切换栏目时重拉列表
  useEffect(() => {
    clearList()
    // v0.0.2：进入进行中/评审中活动列表时强制回到时间排序（评分榜被隔离，残留的 score 排序无意义）
    if (hideScoreboard && listOrder === 'score') {
      setOrder('created')
      return
    }
    // v0.0.2：用当前所选排序加载（读文章返回列表时保持排序选择；切换排序按钮即时重排）
    void loadList({ mid, searchParams, choice, order: choice ? undefined : listOrder })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mid, JSON.stringify(searchParams), choice])

  // 无限滚动：哨兵进入视口（提前 240px）自动加载下一页
  useEffect(() => {
    const sentinel = sentinelRef.current
    // 无更多、首屏加载中、或出错了都不触发自动加载
    if (!sentinel || !hasMore || (listLoading && list.length === 0) || listError) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingRef.current || listLoading) return
        loadingRef.current = true
        void loadList({ mid, searchParams, choice, append: true }).finally(() => {
          loadingRef.current = false
        })
      },
      { rootMargin: '240px 0px' }
    )
    obs.observe(sentinel)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mid, JSON.stringify(searchParams), choice, listOrder, hasMore, listLoading, listError])

  return (
    <div className="article-list-view">
      {/* v0.0.2：活动列表页顶部——该活动的介绍信息（封面/描述/截止/状态） */}
      {activityMeta && (
        <div className="activity-info">
          {activityMeta.imgurl && /^https?:\/\//i.test(activityMeta.imgurl) ? (
            <CoverImage className="activity-info-cover" src={cachedImageUrl(activityMeta.imgurl)} alt="" />
          ) : null}
          <div className="activity-info-body">
            <div className="activity-info-head">
              <span className="activity-info-name">{activityMeta.name}</span>
              {activityPhase && activityPhase !== 'ended' && (
                <span className={`activity-badge phase-${activityPhase}`}>
                  {activityPhase === 'ongoing' ? '进行中' : '评审中'}
                </span>
              )}
            </div>
            {activityMeta.description && (
              <div className="activity-info-desc">{activityMeta.description}</div>
            )}
            {activityMeta.deadline ? (
              <div className="activity-info-meta">投稿截止 {formatTs(activityMeta.deadline)}</div>
            ) : null}
          </div>
        </div>
      )}
      <div className="list-toolbar">
        <span className="list-title">{title}</span>
        {!choice && (
          <div className="list-orders">
            {orders.map((o) => (
              <button
                key={o.key}
                className={`order-btn ${listOrder === o.key ? 'active' : ''}`}
                onClick={() => setOrder(o.key)}
              >
                {o.label}
              </button>
            ))}
            {/* v0.0.2：所有排序共用一个方向切换（服务端默认降序 ↓；升序 ↑） */}
            <button
              className={`order-btn order-dir-btn ${listOrderAsc ? 'asc' : ''}`}
              onClick={toggleOrderAsc}
              title={listOrderAsc ? '当前升序（小→大），点击切回降序' : '当前降序（大→小），点击切换为升序'}
            >
              {listOrderAsc ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
            </button>
          </div>
        )}
      </div>

      {listError && <ErrorBanner title="列表加载失败" message={listError} />}

      <div className="article-list">
        {listLoading && list.length === 0 && (
          // v0.0.7：预填充骨架——形状与真实文章卡片同构（封面 + 标题/摘要 + meta）
          <>
            <span className="sr-only" role="status">加载中 …</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonArticleCard key={i} />
            ))}
          </>
        )}
        {!listLoading && list.length === 0 && !listError && (
          <div className="list-empty muted">（该栏目暂无文章）</div>
        )}
        {list.map((a) => (
          <ArticleCard
            key={a.cid}
            article={a}
            rank={rankOf?.get(a.cid)}
            active={readingCid === a.cid}
            taskStatus={reviewTaskByCid[a.cid]}
            hideScore={hideScoreboard}
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

/** 文章卡片（列表/首页通用；v0.0.2 起导出供栏目首页复用） */
export function ArticleCard({
  article,
  rank,
  active,
  taskStatus,
  hideScore = false,
  onOpen
}: {
  article: RemoteArticle
  /** 榜单排名（非时间排序时传入，1 起） */
  rank?: number
  active: boolean
  /** 评审任务状态：0 待评审（强调高亮）/ 1 已完成（弱标记）/ 未定义 = 非任务文章 */
  taskStatus?: number
  /** 隐藏评分栏位（进行中/评审中活动文章无评分，v0.0.2） */
  hideScore?: boolean
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
  const hasScore = !!article.score && article.score !== '-.-'
  const scoreColorValue = scoreColor(article.score)
  const isTaskTodo = taskStatus === 0
  const isTaskDone = taskStatus !== undefined && taskStatus !== 0
  return (
    <button
      className={`article-card ${active ? 'active' : ''} ${isTaskTodo ? 'task-todo' : ''} ${isTaskDone ? 'task-done' : ''}`}
      onClick={onOpen}
    >
      {cover ? (
        <div className="article-card-cover">
          <CoverImage className="cover-img" src={cover} alt="" />
        </div>
      ) : null}
      <div className="article-card-body">
        <div className="article-card-title">
          {isTaskTodo && <span className="task-badge task-badge-todo" title="评审任务：待评审">待评审</span>}
          {isTaskDone && <span className="task-badge task-badge-done" title="评审任务：已评审">已评审</span>}
          <span className="article-card-title-text">{article.title}</span>
          {rank != null && (
            <span className={`article-rank ${rank <= 3 ? `top-${rank}` : ''}`} title={`第 ${rank} 名`}>
              {rank}
            </span>
          )}
        </div>
        {/* v0.0.6：无摘要显示「无法提取到摘要」提示（居中），有摘要原样显示 */}
        {article.text ? (
          <div className="article-card-excerpt">{article.text}</div>
        ) : (
          <div className="article-card-excerpt article-card-excerpt-none">{`(´･ω･\`) 无法提取到摘要呢`}</div>
        )}
        <div className="article-card-meta">
          <span className="article-card-author">
            {avatar ? (
              <img className="author-avatar" src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ) : null}
            {authorName}
          </span>
          {/* 统计组：靠右对齐，跨卡片右缘对齐；计数项（阅读/赞/评论）始终显示，0 也占位 */}
          <span className="article-card-stats">
            {/* v0.0.2：卡片标记字数（formatSize 千分位） */}
            {article.size ? <span>{formatSize(article.size)} 字</span> : null}
            <span>{article.views} 阅读</span>
            <span>{article.likes} 赞</span>
            <span>{article.commentsNum} 评论</span>
            {/* 评分栏位始终保留（无评分显示灰色占位），按红→紫色相着色；hideScore 时整体隐藏 */}
            {!hideScore && (
              <span
                className={`card-score ${hasScore ? '' : 'no-score'}`}
                style={hasScore && scoreColorValue ? { color: scoreColorValue } : undefined}
              >
                {hasScore ? `${article.score} 分` : '-.- 分'}
              </span>
            )}
            {article.created ? <span>{formatTs(article.created)}</span> : null}
          </span>
        </div>
      </div>
    </button>
  )
}
