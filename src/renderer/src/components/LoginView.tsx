import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../stores/auth'

type Tab = 'password' | 'phone'

/** 登录视图：账号密码 + 手机验证码（M1） */
export function LoginView(): React.JSX.Element {
  const busy = useAuthStore((s) => s.busy)
  const error = useAuthStore((s) => s.error)
  const loginPassword = useAuthStore((s) => s.loginPassword)
  const loginPhone = useAuthStore((s) => s.loginPhone)
  const sendSmsCode = useAuthStore((s) => s.sendSmsCode)

  const [tab, setTab] = useState<Tab>('password')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [smsMsg, setSmsMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  async function handlePassword(): Promise<void> {
    if (!name || !password) return
    await loginPassword(name.trim(), password)
  }

  async function handleSms(): Promise<void> {
    if (!phone) return
    const err = await sendSmsCode(phone.trim())
    if (err) {
      setSmsMsg(err)
      return
    }
    setSmsMsg('验证码已发送')
    setCountdown(60)
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1 && timerRef.current) clearInterval(timerRef.current)
        return c - 1
      })
    }, 1000)
  }

  async function handlePhone(): Promise<void> {
    if (!phone || !code) return
    await loginPhone(phone.trim(), code.trim())
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <h1>荒启科幻</h1>
          <p className="muted">本地写作 · 一键同步 · 随时发布</p>
        </div>

        <div className="login-tabs">
          <button className={tab === 'password' ? 'active' : ''} onClick={() => setTab('password')}>
            账号密码
          </button>
          <button className={tab === 'phone' ? 'active' : ''} onClick={() => setTab('phone')}>
            手机验证码
          </button>
        </div>

        {tab === 'password' ? (
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
            <button className="primary-btn" disabled={busy || !name || !password} onClick={() => void handlePassword()}>
              {busy ? '登录中 …' : '登录'}
            </button>
          </div>
        ) : (
          <div className="login-form">
            <input
              type="tel"
              placeholder="手机号"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <div className="code-row">
              <input
                type="text"
                placeholder="验证码"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handlePhone()
                }}
              />
              <button className="ghost-btn" disabled={countdown > 0 || !phone} onClick={() => void handleSms()}>
                {countdown > 0 ? `${countdown}s 后重发` : '发送验证码'}
              </button>
            </div>
            <button className="primary-btn" disabled={busy || !phone || !code} onClick={() => void handlePhone()}>
              {busy ? '登录中 …' : '登录'}
            </button>
            {smsMsg && <div className="login-tip">{smsMsg}</div>}
          </div>
        )}

        {error && <div className="login-error">{error}</div>}
        <p className="login-foot muted">使用荒启科幻账号登录，凭据经系统安全存储加密保存</p>
      </div>
    </div>
  )
}
