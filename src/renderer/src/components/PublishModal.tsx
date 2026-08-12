import { useEffect, useState } from 'react'
import type { ArticleMeta } from '../../../shared/frontmatter'

interface MetaOption {
  mid: string
  name: string
}

interface PublishModalProps {
  open: boolean
  onClose: () => void
  onConfirm: (meta: ArticleMeta) => void
}

/**
 * v0.0.6：发布表单——按下「发布」后弹出，填写文章元信息（类型/标签/活动/公开阅读）。
 * 元信息不再常驻编辑栏、不再写入本地 frontmatter；此处选择后作为本次发布参数提交。
 * 活动仅可选「正在进行中」（activeStatus===1）或「不参加」。
 */
export function PublishModal({ open, onClose, onConfirm }: PublishModalProps): React.JSX.Element | null {
  const [cats, setCats] = useState<MetaOption[]>([])
  const [tags, setTags] = useState<MetaOption[]>([])
  const [acts, setActs] = useState<MetaOption[]>([])
  const [category, setCategory] = useState('')
  const [selTags, setSelTags] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [isopen, setIsopen] = useState(true)

  // 打开时重置表单并加载 metas（活动仅保留进行中）
  useEffect(() => {
    if (!open) return
    setCategory('')
    setSelTags([])
    setActive('')
    setIsopen(true)
    void window.hqsf.listMetas('category').then((r) => {
      if (r.ok) setCats(r.data.map((m) => ({ mid: String(m.mid), name: m.name })))
    })
    void window.hqsf.listMetas('tag').then((r) => {
      if (r.ok) setTags(r.data.map((m) => ({ mid: String(m.mid), name: m.name })))
    })
    void window.hqsf.listMetas('active').then((r) => {
      if (!r.ok) return
      setActs(r.data.filter((m) => Number(m.activeStatus) === 1).map((m) => ({ mid: String(m.mid), name: m.name })))
    })
  }, [open])

  if (!open) return null

  function toggleTag(name: string): void {
    setSelTags((cur) => (cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name]))
  }

  return (
    <div className="publish-modal-backdrop" onClick={onClose}>
      <div className="publish-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="publish-modal-title">发布文章</h3>
        <p className="publish-modal-hint">发布后进入待审核，由服务器裁决为已发布或已拒绝</p>

        <label className="publish-field">
          <span className="publish-label">类型 <em>必选</em></span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={!category ? 'unset' : ''}>
            <option value="">选择类型…</option>
            {cats.map((c) => (
              <option key={c.mid} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="publish-field">
          <span className="publish-label">标签</span>
          <div className="publish-tags">
            {tags.length === 0 && <span className="muted">（加载中/无标签）</span>}
            {tags.map((t) => (
              <label key={t.mid} className={`publish-tag${selTags.includes(t.name) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={selTags.includes(t.name)}
                  onChange={() => toggleTag(t.name)}
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>

        <label className="publish-field">
          <span className="publish-label">活动</span>
          <select value={active} onChange={(e) => setActive(e.target.value)}>
            <option value="">不参加</option>
            {acts.map((a) => (
              <option key={a.mid} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <label className="publish-field publish-check">
          <input type="checkbox" checked={isopen} onChange={(e) => setIsopen(e.target.checked)} />
          <span>公开阅读</span>
        </label>

        <div className="publish-modal-actions">
          <button className="toolbar-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="toolbar-btn primary"
            disabled={!category}
            title={category ? '提交发布' : '请先选择文章类型'}
            onClick={() => onConfirm({ category, tags: selTags, active: active || undefined, isopen })}
          >
            发布
          </button>
        </div>
      </div>
    </div>
  )
}
