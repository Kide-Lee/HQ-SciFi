import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { sanitizeHtml } from '../lib/sanitize'
import { AGREEMENT_KEY } from '../lib/agreement'

/**
 * 首启协议门（v0.0.7）：首次启动（或协议版本更新）后、进入应用前，
 * 必须先阅读并勾选同意《黄芪饮片用户协议》——同意后写入 localStorage（与登录页共用
 * AGREEMENT_KEY），登录时该协议复选框自动勾选。荒启平台协议不在首启门内（登录时另行勾选）。
 * 协议内容获取失败时无法同意（提供重试），保证「同意」始终建立在已展示协议全文之上。
 */
export function FirstRunAgreement({ onAccepted }: { onAccepted: () => void }): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>('loading')
  const [version, setVersion] = useState('')
  const [html, setHtml] = useState('')
  const [failMsg, setFailMsg] = useState('')
  /** 是否已滚动到协议底部（看完才能勾选） */
  const [read, setRead] = useState(false)
  const [checked, setChecked] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // ---- 无边框窗口控件（macOS 用系统红绿灯，非 mac 自绘） ----
  const [isMac, setIsMac] = useState(false)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let alive = true
    void window.hqsf.getAppInfo().then((info) => {
      if (alive) setIsMac(info.platform === 'darwin')
    })
    void window.hqsf.windowControls.isMaximized().then((v) => {
      if (alive) setMaximized(v)
    })
    const off = window.hqsf.windowControls.onMaximizedChanged((v) => setMaximized(v))
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 拉取协议全文（失败可重试；成功且本地已同意同版本则直接进入） */
  const load = useCallback(() => {
    setState('loading')
    setFailMsg('')
    void window.hqsf.getAgreement().then((res) => {
      if (!res.ok) {
        setFailMsg(res.error ?? '未知错误')
        setState('fail')
        return
      }
      // 已在登录/此前首启同意过当前版本：无需重复阅读，直接进入
      if (localStorage.getItem(AGREEMENT_KEY) === res.data.version) {
        onAccepted()
        return
      }
      setVersion(res.data.version)
      setHtml(res.data.html)
      setState('ok')
    })
  }, [onAccepted])

  useEffect(() => {
    load()
  }, [load])

  // 内容短到无需滚动时直接视为已阅读（否则滚动监听永不触发、无法勾选）
  useEffect(() => {
    if (state !== 'ok') return
    const el = bodyRef.current
    if (el && el.scrollHeight <= el.clientHeight + 8) setRead(true)
  }, [state, html])

  /** 滚动到协议底部（容差 8px）才解锁勾选 */
  function handleScroll(): void {
    const el = bodyRef.current
    if (!el || read) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setRead(true)
  }

  function accept(): void {
    if (state !== 'ok' || !read || !checked || !version) return
    localStorage.setItem(AGREEMENT_KEY, version)
    onAccepted()
  }

  return (
    <div className="firstrun-wrap">
      <div className="window-drag-bar" />
      {/* 无边框窗口控件：macOS 由系统红绿灯接管，非 mac 自绘最小化/全屏/关闭 */}
      {!isMac && (
        <div className="login-window-controls">
          <button className="topbar-btn" onClick={() => void window.hqsf.windowControls.minimize()} title="最小化">
            <Minus size={14} />
          </button>
          <button
            className="topbar-btn"
            onClick={() => void window.hqsf.windowControls.toggleMaximize()}
            title={maximized ? '还原窗口' : '全屏'}
          >
            {maximized ? <Copy size={13} /> : <Square size={12} />}
          </button>
          <button className="topbar-btn topbar-close" onClick={() => void window.hqsf.windowControls.close()} title="关闭">
            <X size={15} />
          </button>
        </div>
      )}
      <div className="agreement-modal">
        <h2>黄芪饮片桌面客户端用户协议</h2>

        {state === 'loading' && <div className="agreement-body agreement-hint">正在加载用户协议 …</div>}

        {state === 'fail' && (
          <div className="agreement-body agreement-hint agreement-fail">
            无法获取用户协议（{failMsg}）。无法阅读并同意协议时，应用无法继续使用。
            <button className="ghost-btn agreement-retry" onClick={load}>
              重试
            </button>
          </div>
        )}

        {state === 'ok' && (
          <>
            <div
              ref={bodyRef}
              className="agreement-body"
              onScroll={handleScroll}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
            />
            <div className="firstrun-check">
              <label className={`login-agreement-item ${!read ? 'pending' : ''}`}>
                <input
                  type="checkbox"
                  disabled={!read}
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span>我已阅读并同意《黄芪饮片用户协议》</span>
              </label>
            </div>
            {!read && <p className="firstrun-tip">请先阅读协议全文（滚动到底部）后再勾选同意</p>}
            <button className="primary-btn firstrun-accept" disabled={!read || !checked} onClick={accept}>
              同意并进入
            </button>
          </>
        )}
      </div>
    </div>
  )
}
