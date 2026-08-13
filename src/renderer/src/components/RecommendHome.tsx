import { useEffect, useState } from 'react'
import { useReaderStore } from '../stores/reader'
import { ArticleCard } from './ArticleListView'
import { ErrorBanner } from './ErrorBanner'
import { SkeletonArticleCard } from './Skeletons'
import type { RemoteArticle } from '../../../shared/types'

/**
 * 推荐栏目首页（v0.0.2）：点击左栏「推荐」顶层（未选中子项）时显示，
 * 类似荒启 h5 首页：置顶文章区 + 最新发布流。
 */
export function RecommendHome(): React.JSX.Element {
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)
  const loadReviewTasks = useReaderStore((s) => s.loadReviewTasks)

  const [top, setTop] = useState<RemoteArticle[]>([])
  const [latest, setLatest] = useState<RemoteArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 登录后全局拉一次评审任务（红点/卡片标记共用）
  useEffect(() => {
    void loadReviewTasks()
  }, [loadReviewTasks])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      // 置顶文章：contentsList searchParams={istop:1}（2026-08-08 实测）
      window.hqsf.listRemoteArticles({ searchParams: { istop: 1 }, limit: 6, order: 'created' }),
      // 最新发布流
      window.hqsf.listRemoteArticles({ searchParams: { type: 'post' }, limit: 12, order: 'created' })
    ])
      .then(([t, l]) => {
        if (!alive) return
        const topItems = t.ok ? t.data.items : []
        const latestItems = l.ok ? l.data.items : []
        setTop(topItems)
        setLatest(latestItems)
        // v0.0.6+：上报首页文章合集供右栏搜索
        useReaderStore.getState().setHomeList([...topItems, ...latestItems])
        setError(!t.ok ? t.error : !l.ok ? l.error : null)
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
      {error && <ErrorBanner title="首页加载失败" message={error} />}

      {loading ? (
        // v0.0.7：预填充骨架——形状与加载完成后的页面同构（置顶 grid 卡 + 最新列表卡）
        <>
          <span className="sr-only" role="status">加载中 …</span>
          <section className="home-section">
            <h2 className="home-section-title">置顶文章</h2>
            <div className="home-top-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonArticleCard key={i} />
              ))}
            </div>
          </section>
          <section className="home-section">
            <h2 className="home-section-title">最新发布</h2>
            <div className="home-list">
              {Array.from({ length: 12 }).map((_, i) => (
                <SkeletonArticleCard key={i} />
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          {top.length > 0 && (
            <section className="home-section">
              <h2 className="home-section-title">置顶文章</h2>
              <div className="home-top-grid">
                {top.map((a) => (
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
          )}

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
