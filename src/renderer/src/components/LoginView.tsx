import { useCallback, useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { AgreementModal } from './AgreementModal'
import { AGREEMENT_KEY } from '../lib/agreement'
import type { AgreementData } from '../../../shared/types'

type ModalKind = 'own' | 'hq' | null

/** localStorage key：已同意荒启平台协议 */
const HQ_AGREEMENT_KEY = 'hqsf-hq-agreement-accepted'

/**
 * 登录视图：账号密码登录（M1）。
 * v0.0.6 起为覆盖层模态（未登录可直接浏览/写作，点右上角 ✕ 关闭）；
 * 登录前须勾选两份协议（每份先点协议名「进去看一眼」，看完才能勾选）；
 * 两份都勾上才允许点击登录按钮。已签署过的（版本匹配/有标记）自动勾选。
 */
export function LoginView(): React.JSX.Element {
  const busy = useAuthStore((s) => s.busy)
  const error = useAuthStore((s) => s.error)
  const loginPassword = useAuthStore((s) => s.loginPassword)
  const closeLogin = useUiStore((s) => s.closeLogin)

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')

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

  // ---- 协议同意 ----
  const [own, setOwn] = useState<AgreementData | null>(null)
  const [ownFail, setOwnFail] = useState(false)
  const [hqHtml, setHqHtml] = useState('')
  const [hqFail, setHqFail] = useState(false)
  const [viewedOwn, setViewedOwn] = useState(false) // 本应用协议已查看（看过才可勾选）
  const [viewedHq, setViewedHq] = useState(false) // 荒启协议已查看
  const [checkedOwn, setCheckedOwn] = useState(false)
  const [checkedHq, setCheckedHq] = useState(false)
  const [modal, setModal] = useState<ModalKind>(null)

  // 预取两份协议；已签署过（版本匹配/有标记）自动勾选。失败可经重试按钮重新拉取
  const loadOwn = useCallback(() => {
    setOwn(null)
    setOwnFail(false)
    void window.hqsf.getAgreement().then((res) => {
      if (res.ok && res.data) {
        setOwn(res.data)
        if (localStorage.getItem(AGREEMENT_KEY) === res.data.version) {
          setViewedOwn(true)
          setCheckedOwn(true)
        }
      } else {
        setOwnFail(true)
      }
    })
  }, [])

  const loadHq = useCallback(() => {
    setHqHtml('')
    setHqFail(false)
    void window.hqsf.getHuangqiAgreement().then((res) => {
      if (res.ok && res.data) {
        setHqHtml(res.data.html)
        if (localStorage.getItem(HQ_AGREEMENT_KEY) === '1') {
          setViewedHq(true)
          setCheckedHq(true)
        }
      } else {
        setHqFail(true)
      }
    })
  }, [])

  useEffect(() => {
    loadOwn()
    loadHq()
  }, [loadOwn, loadHq])

  async function handlePassword(): Promise<void> {
    if (!name || !password) return
    await loginPassword(name.trim(), password)
  }

  const loginDisabled = busy || !name || !password || !checkedOwn || !checkedHq

  return (
    <div className="login-wrap">
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
      <div className="login-card">
        <button className="login-close" onClick={closeLogin} title="先浏览，稍后登录">
          <X size={16} />
        </button>
        <div className="login-brand">
          <h1>黄芪饮片</h1>
          <p className="muted">本地写作 · 一键同步 · 随时发布</p>
        </div>

        <div className="login-form">
          <input
            type="text"
            placeholder="账号"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handlePassword()
            }}
          />
          <button className="primary-btn" disabled={loginDisabled} onClick={() => void handlePassword()}>
            {busy ? '登录中 …' : '登录'}
          </button>
        </div>

        {/* 协议同意：先点协议名「进去看一眼」，看完才能勾选；两个都勾上才能登录 */}
        <div className="login-agreements">
          <label className={`login-agreement-item ${!viewedOwn ? 'pending' : ''}`}>
            <input
              type="checkbox"
              disabled={!viewedOwn}
              checked={checkedOwn}
              onChange={(e) => {
                setCheckedOwn(e.target.checked)
                if (e.target.checked && own) localStorage.setItem(AGREEMENT_KEY, own.version)
              }}
            />
            <span>
              我已阅读并同意
              <button type="button" className="login-agreement-link" onClick={() => setModal('own')}>
                《黄芪饮片用户协议》
              </button>
            </span>
          </label>
          <label className={`login-agreement-item ${!viewedHq ? 'pending' : ''}`}>
            <input
              type="checkbox"
              disabled={!viewedHq}
              checked={checkedHq}
              onChange={(e) => {
                setCheckedHq(e.target.checked)
                if (e.target.checked) localStorage.setItem(HQ_AGREEMENT_KEY, '1')
              }}
            />
            <span>
              我已阅读并同意
              <button type="button" className="login-agreement-link" onClick={() => setModal('hq')}>
                《荒启科幻平台用户协议》
              </button>
            </span>
          </label>
          {!checkedOwn || !checkedHq ? (
            <p className="login-agreement-tip">请先查看并勾选上述两份协议后方可登录</p>
          ) : null}
        </div>

        {error && <div className="login-error">{error}</div>}
      </div>

      {modal === 'own' && (
        <AgreementModal
          title="黄芪饮片桌面客户端用户协议"
          state={ownFail ? 'fail' : own ? 'ok' : 'loading'}
          html={own?.html ?? ''}
          error={ownFail ? '协议文件缺失或损坏' : undefined}
          onRetry={loadOwn}
          onCancel={() => setModal(null)}
          onDone={() => {
            setViewedOwn(true)
            setModal(null)
          }}
        />
      )}
      {modal === 'hq' && (
        <AgreementModal
          title="荒启科幻平台用户协议"
          state={hqFail ? 'fail' : hqHtml ? 'ok' : 'loading'}
          html={hqHtml}
          error={hqFail ? '网络错误或协议页变更' : undefined}
          onRetry={loadHq}
          onCancel={() => setModal(null)}
          onDone={() => {
            setViewedHq(true)
            setModal(null)
          }}
        />
      )}
    </div>
  )
}
