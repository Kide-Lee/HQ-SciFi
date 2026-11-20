import { useEffect, useMemo, useState } from 'react'
import MarkdownIt from 'markdown-it'

export function ChangelogModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [content, setContent] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const md = useMemo(() => new MarkdownIt({ html: false, linkify: true, breaks: true }), [])

  useEffect(() => {
    void window.hqsf.getChangelog().then((res) => {
      if (res.ok) {
        setContent(res.data.markdown)
        setVersion(res.data.version)
      } else {
        setError(res.error)
      }
    })
  }, [])

  return (
    <div className="settings-code-mask">
      <div className="settings-code-modal">
        <h3>更新日志（v{version || '…'}）</h3>
        {error && <div className="settings-hint error">{error}</div>}
        <div
          className="settings-changelog"
          dangerouslySetInnerHTML={{ __html: content ? md.render(content) : '正在加载…' }}
        />
        <div className="settings-code-footer">
          <button className="primary-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
