import { useEffect, useState } from 'react'
import { ARTICLE_ORDERS, useReaderStore } from '../stores/reader'
import { cachedImageUrl, formatTs } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import type { RemoteArticle } from '../../../shared/types'

/**
 * 文章列表视图（作品库/浏览入口）：
 * 拉取远端文章列表（contentsList 或 getMetaContents 分类），点击进入阅读视图。
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
  const loadList = useReaderStore((s) => s.loadList)
  const setOrder = useReaderStore((s) => s.setOrder)
  const clearList = useReaderStore((s) => s.clearList)
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)

  const [loadingMore, setLoadingMore] = useState(false)

  // 切换栏目时重拉列表
  useEffect(() => {
    clearList()
    void loadList({ mid, searchParams, order: 'created' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mid, JSON.stringify(searchParams)])

  async function handleLoadMore(): Promise<void> {
    if (listLoading || loadingMore) return
    setLoadingMore(true)
    await loadList({ mid, searchParams, append: true })
    setLoadingMore(false)
  }

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
        {list.map((a) => (
          <ArticleCard key={a.cid} article={a} active={readingCid === a.cid} onOpen={() => void openArticle(a.cid)} />
        ))}
      </div>

      {list.length > 0 && list.length < listTotal && (
        <div className="list-more">
          <button className="toolbar-btn" onClick={() => void handleLoadMore()} disabled={listLoading || loadingMore}>
            {loadingMore ? '加载中 …' : '加载更多'}
          </button>
          <span className="muted">
            {list.length} / {listTotal}
          </span>
        </div>
      )}
    </div>
  )
}

function ArticleCard({
  article,
  active,
  onOpen
}: {
  article: RemoteArticle
  active: boolean
  onOpen: () => void
}): React.JSX.Element {
  const author = article.authorInfo as Record<string, unknown> | undefined
  const authorName = String(
    author?.nickname ?? author?.nick ?? author?.nickName ?? author?.name ?? (article.authorId ? `UID ${article.authorId}` : '佚名')
  )
  // 封面：images[0] 优先（官方列表字段），cover 兜底；仅 http(s) 图片进缓存协议
  const coverRaw = (article.images && article.images[0]) || article.cover
  const cover = coverRaw && /^https?:\/\//i.test(coverRaw) ? cachedImageUrl(coverRaw) : undefined
  return (
    <button className={`article-card ${active ? 'active' : ''}`} onClick={onOpen}>
      {cover ? (
        <div className="article-card-cover">
          <img src={cachedImageUrl(cover)} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </div>
      ) : null}
      <div className="article-card-body">
        <div className="article-card-title">{article.title}</div>
        {article.text && <div className="article-card-excerpt">{article.text}</div>}
        <div className="article-card-meta">
          <span>{authorName}</span>
          {article.views ? <span>· {article.views} 阅读</span> : null}
          {article.likes ? <span>· {article.likes} 赞</span> : null}
          {article.commentsNum ? <span>· {article.commentsNum} 评论</span> : null}
          {article.score && article.score !== '-.-' ? <span className="card-score">· 评分 {article.score}</span> : null}
          {article.created ? <span>· {formatTs(article.created)}</span> : null}
        </div>
      </div>
    </button>
  )
}
