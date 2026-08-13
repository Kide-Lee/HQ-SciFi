import { useEffect, useState } from 'react'
import { useUiStore } from '../stores/ui'
import { cachedImageUrl } from '../lib/sanitize'
import { ErrorBanner } from './ErrorBanner'
import { CoverImage } from './CoverImage'
import { SkeletonMetaCard } from './Skeletons'
import type { MetaInfo } from '../../../shared/types'

/** 每组推荐的展示数量上限（v0.0.2：避免栏目过长） */
const MAX_PER_GROUP = 8

/**
 * 连载栏目首页（v0.0.2）：点击左栏「连载」顶层（未选中子项）时显示
 * 「推荐合集」「推荐连载」两个栏目（metasList type=collection / serial），
 * 各栏目卡片带封面，每组限制展示前 MAX_PER_GROUP 个。
 * 点击某个合集/连载 → 打开该栏目文章列表。
 */
export function SerialHome(): React.JSX.Element {
  const openList = useUiStore((s) => s.openList)
  const [groups, setGroups] = useState<Record<string, MetaInfo[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const GROUPS: Array<{ type: string; title: string }> = [
    { type: 'collection', title: '推荐合集' },
    { type: 'serial', title: '推荐连载' }
  ]

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all(
      GROUPS.map((g) => window.hqsf.listMetas(g.type).then((res) => ({ type: g.type, res })))
    )
      .then((results) => {
        if (!alive) return
        const next: Record<string, MetaInfo[]> = {}
        let failed: string | null = null
        for (const { type, res } of results) {
          if (res.ok) next[type] = res.data
          else failed = res.error
        }
        setGroups(next)
        setError(failed)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="home-view">
      {error && <ErrorBanner title="连载栏目加载失败" message={error} />}

      {loading ? (
        // v0.0.7：预填充骨架——形状与真实 meta 卡片同构（封面 + 名称/描述）
        <>
          <span className="sr-only" role="status">加载中 …</span>
          {GROUPS.map((g) => (
            <section className="home-section" key={g.type}>
              <h2 className="home-section-title">{g.title}</h2>
              <div className="home-meta-grid">
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonMetaCard key={i} />
                ))}
              </div>
            </section>
          ))}
        </>
      ) : (
        GROUPS.map((g) => {
          const metas = (groups[g.type] ?? []).slice(0, MAX_PER_GROUP)
          const total = (groups[g.type] ?? []).length
          return (
            <section className="home-section" key={g.type}>
              <h2 className="home-section-title">
                {g.title}
                {total > MAX_PER_GROUP && (
                  <span className="muted home-section-sub">共 {total} 个，展示前 {MAX_PER_GROUP} 个</span>
                )}
              </h2>
              <div className="home-meta-grid">
                {metas.length === 0 && <div className="list-empty muted">（暂无）</div>}
                {metas.map((m) => {
                  const cover =
                    m.imgurl && /^https?:\/\//i.test(m.imgurl) ? cachedImageUrl(m.imgurl) : undefined
                  return (
                    <button
                      key={m.mid}
                      className="meta-card"
                      onClick={() => openList({ title: m.name, mid: m.mid })}
                      title={m.description || m.name}
                    >
                      {cover ? (
                        <CoverImage className="meta-card-cover" src={cover} alt="" />
                      ) : (
                        <div className="meta-card-cover placeholder" />
                      )}
                      <div className="meta-card-body">
                        <div className="meta-card-name">
                          {m.name}
                          {m.count ? <span className="meta-card-count">{m.count} 篇</span> : null}
                        </div>
                        {m.description && <div className="meta-card-desc">{m.description}</div>}
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
