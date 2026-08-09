import { useEffect, useState } from 'react'
import { useUiStore } from '../stores/ui'
import { ACTIVITY_PHASE_LABEL, activityPhase, sortActivities } from '../lib/activity'
import { cachedImageUrl, formatSize, formatTs } from '../lib/sanitize'
import { CoverImage } from './CoverImage'
import { ErrorBanner } from './ErrorBanner'
import type { MetaInfo } from '../../../shared/types'

/** 聚合统计的活动数上限（近期活动才有实时统计，避免全量请求） */
const MAX_STATS = 8

/** 活动聚合统计（selectContents 文章聚合 + reviewList 评审聚合） */
interface ActivityStats {
  works: number
  authors: number
  words: number
  views: number
  reviewers: number
  reviews: number
}

/**
 * 活动栏目首页（v0.0.2）：点击左栏「活动」顶层（未选中子项）时显示近期活动栏目。
 * 每个活动卡片带封面 + 状态徽章 + 两行统计：
 * 第一行 作品/作者/字数/阅读量（全部活动）；第二行 评审人数/评审总数（仅已结束活动，
 * 进行中/评审中无评审数据不显示第二行）。统计由 selectContents + reviewList 聚合。
 * 点击卡片 → 打开该活动文章列表（进行中/评审中隐藏评分榜）。
 */
export function ActivityHome(): React.JSX.Element {
  const openList = useUiStore((s) => s.openList)
  const [activities, setActivities] = useState<MetaInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** midKey → 聚合统计 */
  const [stats, setStats] = useState<Record<string, ActivityStats>>({})

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.hqsf
      .listMetas('active')
      .then((res) => {
        if (!alive) return
        if (res.ok) setActivities(sortActivities(res.data))
        else setError(res.error)
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

  // v0.0.2：对近期活动（前 MAX_STATS 个）聚合统计
  useEffect(() => {
    if (loading || activities.length === 0) return
    let alive = true
    const targets = activities.slice(0, MAX_STATS)
    void Promise.allSettled(
      targets.map(async (m) => {
        const [artRes, revRes] = await Promise.all([
          window.hqsf.listRemoteArticles({ mid: m.mid, limit: 100, order: 'created' }),
          window.hqsf.listReviews({ activeid: m.mid, limit: 100 })
        ])
        const items = artRes.ok ? artRes.data.items : []
        const revItems = revRes.ok ? revRes.data.items : []
        return {
          midKey: String(m.mid),
          s: {
            works: items.length,
            authors: new Set(items.map((a) => a.authorId).filter(Boolean)).size,
            words: items.reduce((sum, a) => sum + (a.size ?? 0), 0),
            views: items.reduce((sum, a) => sum + (a.views ?? 0), 0),
            reviewers: new Set(revItems.map((r) => r.uid).filter(Boolean)).size,
            reviews: revRes.ok ? revRes.data.total : revItems.length
          }
        }
      })
    ).then((results) => {
      if (!alive) return
      const next: Record<string, ActivityStats> = {}
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.midKey] = r.value.s
      }
      setStats(next)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activities])

  return (
    <div className="home-view">
      {error && <ErrorBanner title="活动栏目加载失败" message={error} />}

      {loading ? (
        <section className="home-section">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton-row" style={{ marginBottom: 10 }} />
          ))}
        </section>
      ) : (
        <section className="home-section">
          <div className="home-list">
            {activities.length === 0 && <div className="list-empty muted">（暂无活动）</div>}
            {activities.map((m) => {
              const phase = activityPhase(m)
              const label = ACTIVITY_PHASE_LABEL[phase]
              const s = stats[String(m.mid)]
              const isOpenPhase = phase === 'ongoing' || phase === 'reviewing'
              const cover =
                m.imgurl && /^https?:\/\//i.test(m.imgurl) ? cachedImageUrl(m.imgurl) : undefined
              return (
                <button
                  key={m.mid}
                  className="activity-card"
                  onClick={() =>
                    openList({ title: m.name, mid: m.mid, activityPhase: phase, meta: m })
                  }
                  title={m.description || m.name}
                >
                  {cover ? (
                    <CoverImage className="activity-card-cover" src={cover} alt="" />
                  ) : (
                    <div className="activity-card-cover placeholder" />
                  )}
                  <div className="activity-card-body">
                    <div className="activity-card-head">
                      <span className="activity-card-name">{m.name}</span>
                      {label && <span className={`activity-badge phase-${phase}`}>{label}</span>}
                    </div>
                    {/* v0.0.2：描述优先占宽；每个分号后换行 */}
                    <div className="activity-card-content">
                      {m.description && (
                        <div className="activity-card-desc">
                          {/* v0.0.2：每个分号后插入 <br/> 换行（组件渲染避免 XSS） */}
                          {m.description
                            .split('；')
                            .map((seg, i, arr) => (
                              <span key={i}>
                                {seg.replace(/\n/g, '').trim()}
                                {i < arr.length - 1 ? (
                                  <>
                                    ；
                                    <br />
                                  </>
                                ) : null}
                              </span>
                            ))}
                        </div>
                      )}
                      {/* v0.0.2：stats 表格化——作品/作者一行、字数/阅读一行、评审人数/总数一行，两列对齐 */}
                      <div className="activity-card-stats-col">
                        <div className="activity-card-stats-table">
                          <div className="activity-card-stats-row">
                            <span>作品 {s?.works ?? '—'}</span>
                            <span>作者 {s?.authors ?? '—'}</span>
                          </div>
                          <div className="activity-card-stats-row">
                            <span>字数 {s ? formatSize(s.words) : '—'}</span>
                            <span>阅读 {s ? formatSize(s.views) : '—'}</span>
                          </div>
                          {!isOpenPhase && (
                            <div className="activity-card-stats-row">
                              <span>评审人数 {s?.reviewers ?? '—'}</span>
                              <span>评审总数 {s?.reviews ?? '—'}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
