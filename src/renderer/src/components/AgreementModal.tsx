import { sanitizeHtml } from '../lib/sanitize'

/**
 * 协议查看层（modal）：登录页「进去看一眼」用。
 * 展示协议全文（主进程渲染的 HTML，渲染前经 sanitizeHtml 白名单净化防 XSS），
 * 点「我已阅读」关闭并解锁对应复选框；「取消」关闭且视为未阅读（复选框不解锁）；
 * 内容获取失败（state='fail'）时「我已阅读」禁用——看不了就不能勾选同意，
 * 提供「重试」重新拉取（onRetry 可选）。
 */
export function AgreementModal({
  title,
  state,
  html,
  error,
  onRetry,
  onCancel,
  onDone
}: {
  title: string
  state: 'loading' | 'ok' | 'fail'
  html: string
  error?: string
  onRetry?: () => void
  onCancel: () => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <div className="agreement-modal-mask">
      <div className="agreement-modal">
        <h2>{title}</h2>
        {state === 'loading' && <div className="agreement-body agreement-hint">正在加载协议内容 …</div>}
        {state === 'fail' && (
          <div className="agreement-body agreement-hint agreement-fail">
            无法获取该协议（{error ?? '未知错误'}）。获取失败时无法阅读并勾选同意。
            {onRetry && (
              <button className="ghost-btn agreement-retry" onClick={onRetry}>
                重试
              </button>
            )}
          </div>
        )}
        {state === 'ok' && (
          <div className="agreement-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
        )}
        <div className="agreement-modal-footer">
          <button className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button className="primary-btn" disabled={state !== 'ok'} onClick={onDone}>
            我已阅读
          </button>
        </div>
      </div>
    </div>
  )
}
