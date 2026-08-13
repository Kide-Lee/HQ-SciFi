import { useEffect, useState } from 'react'
import { ErrorBanner } from './ErrorBanner'
import { cachedImageUrl } from '../lib/sanitize'
import { SkeletonGptCard } from './Skeletons'
import type { GptModel } from '../../../shared/types'

/**
 * AI 模型列表（推荐栏目「AI模型」，gpt/gptList）。
 * 卡片展示模型头像/名称/简介/来源/价格；对话功能属后续版本。
 */
export function GptListView({ title }: { title: string }): React.JSX.Element {
  const [models, setModels] = useState<GptModel[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.hqsf.listGptModels().then((res) => {
      if (!alive) return
      if (res.ok) setModels(res.data)
      else setError(res.error)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="gpt-list-view">
      <div className="list-toolbar">
        <span className="list-title">{title}</span>
      </div>
      {error && <ErrorBanner title="AI 模型加载失败" message={error} />}
      <div className="gpt-grid">
        {models == null && !error && (
          // v0.0.7：预填充骨架——形状与真实 AI 模型卡片同构（头像 + 名称/标签 + 简介）
          <>
            <span className="sr-only" role="status">加载中 …</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonGptCard key={i} />
            ))}
          </>
        )}
        {models != null && models.length === 0 && !error && (
          <div className="list-empty muted">（暂无模型）</div>
        )}
        {models?.map((m) => {
          const avatar = m.avatar && /^https?:\/\//i.test(m.avatar) ? cachedImageUrl(m.avatar) : undefined
          return (
            <div className="gpt-card" key={m.id}>
              <div className="gpt-card-head">
                {avatar ? (
                  <img className="gpt-avatar" src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <div className="gpt-avatar gpt-avatar-fallback">{m.name.slice(0, 1)}</div>
                )}
                <div className="gpt-card-title">
                  <span className="gpt-name">{m.name}</span>
                  <span className="gpt-tag">{m.type === 1 ? '专项大师' : '通用助手'}</span>
                </div>
              </div>
              <div className="gpt-intro">{m.intro || '（暂无简介）'}</div>
              <div className="gpt-meta">
                <span>来源 {m.source || '未知'}</span>
                <span className="muted">对话功能后续版本开放</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
