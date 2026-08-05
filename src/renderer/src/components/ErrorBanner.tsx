import { useState } from 'react'

/**
 * 统一错误提示条（M2 收尾：合并「同步失败」与「阅读/列表/评审」两套报错展示）。
 * 形态：标题 + 主消息 + 明细行（可选）+ 复制报错按钮 + 提示语（可选）+ 关闭（可选）。
 * 复制内容 = 标题 + 全部明细/消息，便于反馈给开发排查。
 */
export function ErrorBanner({
  title = '操作失败',
  message,
  details = [],
  hint,
  onDismiss
}: {
  /** 错误标题，如「同步失败 3 处」「阅读失败」 */
  title?: string
  /** 主错误消息（单条场景）；与 details 同时给出时展示 details */
  message?: string
  /** 多条明细（同步失败逐条） */
  details?: string[]
  /** 底部提示语（如登录态过期引导） */
  hint?: string
  /** 关闭按钮回调；不传则不显示关闭按钮 */
  onDismiss?: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const lines = details.length > 0 ? details : message ? [message] : []

  async function handleCopy(): Promise<void> {
    const text = [title, ...lines, hint ?? ''].filter(Boolean).join('\n')
    try {
      const res = await window.hqsf.copyText(text)
      if (res.ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      // 复制失败静默处理（不影响错误展示本身）
    }
  }

  return (
    <div className="error-banner">
      <div className="error-banner-head">
        <span className="error-banner-title">{title}</span>
        <div className="error-banner-actions">
          {lines.length > 0 && (
            <button className="copy-btn" onClick={() => void handleCopy()}>
              {copied ? '已复制 ✓' : '复制报错'}
            </button>
          )}
          {onDismiss && (
            <button className="dismiss" onClick={onDismiss} title="关闭">
              ✕
            </button>
          )}
        </div>
      </div>
      {lines.map((line, i) => (
        <div key={i} className="error-banner-line">
          {line}
        </div>
      ))}
      {hint && <div className="error-banner-hint">{hint}</div>}
    </div>
  )
}
