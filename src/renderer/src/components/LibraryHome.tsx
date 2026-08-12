import { useEffect, useState } from 'react'
import { useUiStore } from '../stores/ui'
import { useReaderStore } from '../stores/reader'
import { cachedImageUrl } from '../lib/sanitize'
import { ArticleCard } from './ArticleListView'
import { CoverImage } from './CoverImage'
import { ErrorBanner } from './ErrorBanner'
import type { RemoteArticle } from '../../../shared/types'

/**
 * 作品库栏目首页（v0.0.2）：点击左栏「作品库」顶层（未选中子项）时显示
 * 四个作品分类入口（原创作品/科幻杂谈/官方公告/外文翻译）+ 最新发布流；
 * 加载中渲染预填充骨架（宽度填满父元素）。
 */
export function LibraryHome(): React.JSX.Element {
  const openList = useUiStore((s) => s.openList)
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)

  const [cats, setCats] = useState<
    Array<{ mid: number | string; name: string; description?: string; imgurl?: string }>
  >([])
  const [latest, setLatest] = useState<RemoteArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      window.hqsf.listCategories(),
      window.hqsf.listRemoteArticles({ searchParams: { type: 'post' }, limit: 12, order: 'created' })
    ])
      .then(([c, l]) => {
        if (!alive) return
        if (c.ok)
          setCats(c.data.map((x) => ({ mid: x.mid, name: x.name, description: x.description, imgurl: x.imgurl })))
        else setError(c.error)
        const latestItems = l.ok ? l.data.items : []
        setLatest(latestItems)
        // v0.0.6+：上报首页文章合集供右栏搜索
        useReaderStore.getState().setHomeList(latestItems)
        setLoading(false)
      })
      .catch((err) => {
        if (!alive) return
        setError((err as Error).message)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="home-view">
      {error && <ErrorBanner title="作品库加载失败" message={error} />}

      {loading ? (
        <>
          <section className="home-section">
            <h2 className="home-section-title">作品分类</h2>
            <div className="home-list">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton-row" />
              ))}
            </div>
          </section>
          <section className="home-section">
            <h2 className="home-section-title">最新发布</h2>
            <div className="home-list">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton-row" />
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="home-section">
            <h2 className="home-section-title">作品分类</h2>
            <div className="home-meta-grid library-cat-grid">
              {cats.map((c) => {
                // v0.0.2：无配图的分类不显示占位封面
                const cover =
                  c.imgurl && /^https?:\/\//i.test(c.imgurl) ? cachedImageUrl(c.imgurl) : undefined
                return (
                  <button
                    key={c.mid}
                    className="meta-card"
                    onClick={() => openList({ title: c.name, mid: c.mid })}
                    title={c.description || c.name}
                  >
                    {cover ? (
                      <CoverImage className="meta-card-cover" src={cover} alt="" />
                    ) : null}
                    <div className="meta-card-body">
                      <div className="meta-card-name">{c.name}</div>
                      {c.description && <div className="meta-card-desc">{c.description}</div>}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="home-section">
            <h2 className="home-section-title">最新发布</h2>
            <div className="home-list">
              {latest.length === 0 && <div className="list-empty muted">（暂无文章）</div>}
              {latest.map((a) => (
                <ArticleCard
                  key={a.cid}
                  article={a}
                  active={readingCid === a.cid}
                  taskStatus={reviewTaskByCid[a.cid]}
                  onOpen={() => void openArticle(a.cid)}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
