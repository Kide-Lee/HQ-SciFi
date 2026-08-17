import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useUiStore } from '../stores/ui'
import { useReaderStore } from '../stores/reader'
import { cachedImageUrl } from '../lib/sanitize'
import { ArticleCard } from './ArticleListView'
import { CommentFeedCard, ReviewFeedCard } from './FeedCards'
import { ErrorBanner } from './ErrorBanner'
import type { CommentItem, RemoteArticle, ReviewItem, UserSearchResult } from '../../../shared/types'

type SearchType = 'articles' | 'comments' | 'reviews' | 'users'

const SEARCH_TABS: Array<{ key: SearchType; label: string }> = [
  { key: 'articles', label: '文章' },
  { key: 'comments', label: '评论' },
  { key: 'reviews', label: '评审' },
  { key: 'users', label: '用户' }
]

interface SearchResults {
  articles: RemoteArticle[]
  comments: CommentItem[]
  reviews: ReviewItem[]
  users: UserSearchResult[]
}

const EMPTY_RESULTS: SearchResults = { articles: [], comments: [], reviews: [], users: [] }

/**
 * v0.0.9：作品库首页改版为「荒启 + 全局搜索」。
 * 搜索范围：文章 / 评论 / 评审 / 用户，与官方 H5 搜索页保持一致。
 */
export function LibraryHome(): React.JSX.Element {
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)
  const myReviewedCids = useReaderStore((s) => s.myReviewedCids)
  const openUserPage = useUiStore((s) => s.openUserPage)
  const librarySearchActive = useUiStore((s) => s.librarySearchActive)
  const setLibrarySearchActive = useUiStore((s) => s.setLibrarySearchActive)

  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeType, setActiveType] = useState<SearchType>('articles')
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS)

  // 顶栏“返回”按钮会把 librarySearchActive 置为 false，这里同步清空本地搜索结果
  useEffect(() => {
    if (!librarySearchActive && searched) {
      setQuery('')
      setSearched(false)
      setResults(EMPTY_RESULTS)
      setActiveType('articles')
      setError(null)
    }
  }, [librarySearchActive, searched])

  async function doSearch(raw?: string): Promise<void> {
    const keyword = (raw ?? query).trim()
    if (!keyword) return
    setLoading(true)
    setError(null)
    setSearched(true)
    setActiveType('articles')
    setLibrarySearchActive(true)
    try {
      const [a, c, r, u] = await Promise.all([
        window.hqsf.listRemoteArticles({
          searchParams: { type: 'post' },
          searchKey: keyword,
          limit: 10,
          order: 'created'
        }),
        window.hqsf.searchComments(keyword, 10),
        window.hqsf.searchReviews(keyword, 10),
        window.hqsf.searchUsers(keyword, 10)
      ])
      setResults({
        articles: a.ok ? a.data.items : [],
        comments: c.ok ? c.data.items : [],
        reviews: r.ok ? r.data.items : [],
        users: u.ok ? u.data.items : []
      })
      const errs = [a, c, r, u].filter((x) => !x.ok).map((x) => x.error)
      setError(errs[0] ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function lucky(): Promise<void> {
    try {
      const res = await window.hqsf.listRemoteArticles({ searchParams: { type: 'post' }, limit: 50, order: 'created' })
      if (!res.ok || res.data.items.length === 0) return
      const item = res.data.items[Math.floor(Math.random() * res.data.items.length)]
      void openArticle(item.cid)
    } catch {
      // 随机打开失败静默
    }
  }

  const counts: Record<SearchType, number> = {
    articles: results.articles.length,
    comments: results.comments.length,
    reviews: results.reviews.length,
    users: results.users.length
  }

  return (
    <div className="library-search-page">
      {/* 搜索区：荒启图标 + 搜索框 */}
      <div className={`library-search-hero${searched ? ' compact' : ''}`}>
        <img
          className="library-search-logo"
          src={cachedImageUrl('https://www.huangqisf.com/logo-w.png')}
          alt="荒启"
          onClick={() => useUiStore.getState().setSection('recommend')}
          title="返回推荐首页"
        />
        <form
          className="library-search-form"
          onSubmit={(e) => {
            e.preventDefault()
            void doSearch()
          }}
        >
          <div className="library-search-box">
            <Search size={18} className="library-search-icon" />
            <input
              className="library-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在荒启中搜索"
              autoFocus={!searched}
            />
            {query && (
              <button
                type="button"
                className="library-search-clear"
                onClick={() => setQuery('')}
                title="清除"
              >
                <X size={18} />
              </button>
            )}
            <button type="submit" className="library-search-btn" disabled={loading}>
              {loading ? '搜索中…' : '搜索'}
            </button>
          </div>
          <div className="library-search-actions">
            <button type="button" className="library-search-wormhole" onClick={() => void lucky()}>
              时空乱流
            </button>
            <button
              type="button"
              className="library-search-wormhole"
              onClick={() => window.open('https://www.huangqisf.com/', '_blank')}
            >
              前往官网
            </button>
          </div>
        </form>
      </div>

      {error && <ErrorBanner title="搜索失败" message={error} />}

      {searched && (
        <div className="library-search-results">
          <div className="list-toolbar">
            <span className="list-title">搜索“{query.trim()}”</span>
            <div className="library-search-tabs">
            {SEARCH_TABS.map((t) => (
              <button
                key={t.key}
                className={`order-btn library-search-tab${activeType === t.key ? ' active' : ''}`}
                onClick={() => setActiveType(t.key)}
              >
                {t.label}
                <span className="library-search-tab-count">{counts[t.key]}</span>
              </button>
            ))}
            </div>
          </div>

          {loading ? (
            <div className="muted library-search-loading">正在搜索…</div>
          ) : (
            <div className="library-search-list">
              {activeType === 'articles' && (
                <>
                  {results.articles.length === 0 && <div className="list-empty muted">（没有匹配的文章）</div>}
                  {results.articles.map((a) => (
                    <ArticleCard
                      key={a.cid}
                      article={a}
                      active={readingCid === a.cid}
                      taskStatus={reviewTaskByCid[a.cid]}
                      reviewed={myReviewedCids[a.cid] === true}
                      onOpen={() => void openArticle(a.cid)}
                    />
                  ))}
                </>
              )}

              {activeType === 'comments' && (
                <div className="home-feed-list">
                  {results.comments.length === 0 && <div className="list-empty muted">（没有匹配的评论）</div>}
                  {results.comments.map((c) => (
                    <CommentFeedCard
                      key={String(c.coid)}
                      comment={c}
                      onOpen={() => {
                        if (c.cid) void openArticle(String(c.cid))
                      }}
                      onOpenUser={() => {
                        const uid = String(c.authorId ?? '')
                        if (uid && uid !== '0') openUserPage(uid)
                      }}
                    />
                  ))}
                </div>
              )}

              {activeType === 'reviews' && (
                <div className="home-feed-list">
                  {results.reviews.length === 0 && <div className="list-empty muted">（没有匹配的评审）</div>}
                  {results.reviews.map((r) => (
                    <ReviewFeedCard
                      key={String(r.id)}
                      review={r}
                      onOpen={() => {
                        if (r.cid) void openArticle(String(r.cid))
                      }}
                      onOpenUser={() => {
                        const uid = String(r.uid ?? (r.userJson as Record<string, unknown> | undefined)?.uid ?? '')
                        if (uid && uid !== '0') openUserPage(uid)
                      }}
                    />
                  ))}
                </div>
              )}

              {activeType === 'users' && (
                <div className="user-follow-list">
                  {results.users.length === 0 && <div className="list-empty muted">（没有匹配的用户）</div>}
                  {results.users.map((u) => {
                    const avatar = u.avatar && /^https?:\/\//i.test(u.avatar) ? cachedImageUrl(u.avatar) : undefined
                    return (
                      <button
                        key={u.uid}
                        className="user-follow-row"
                        onClick={() => openUserPage(u.uid)}
                        title={`查看 ${u.name || u.uid} 的主页`}
                      >
                        {avatar ? (
                          <img className="comment-avatar" src={avatar} alt="" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="comment-avatar comment-avatar-placeholder" />
                        )}
                        <span className="user-follow-meta">
                          <span className="user-follow-name-row">
                            <span className="user-follow-name">{u.name || `UID ${u.uid}`}</span>
                          </span>
                          {u.introduce ? <span className="user-follow-intro">{u.introduce}</span> : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
