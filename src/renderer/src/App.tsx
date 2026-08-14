import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { TopBar } from './components/TopBar'
import { LoginView } from './components/LoginView'
import { FirstRunAgreement } from './components/FirstRunAgreement'
import { useAuthStore } from './stores/auth'
import { useUiStore } from './stores/ui'
import { AGREEMENT_KEY } from './lib/agreement'

export default function App(): React.JSX.Element {
  const restoring = useAuthStore((s) => s.restoring)
  const restore = useAuthStore((s) => s.restore)
  const loginOpen = useUiStore((s) => s.loginOpen)
  // v0.0.7：首启协议门状态——null=校验中（加载态），false=未同意当前版本（展示协议门），
  // true=已同意（进入主界面）。与登录页共用 AGREEMENT_KEY：登录时勾选过则首启自动放行。
  const [agreementOk, setAgreementOk] = useState<boolean | null>(null)
  /** 协议门同意回调（稳定引用，避免协议门组件因回调身份变化反复重拉协议） */
  const acceptAgreement = useCallback(() => setAgreementOk(true), [])

  useEffect(() => {
    void restore()
  }, [restore])

  // v0.0.7：进入应用前先确认本应用用户协议是否已同意（本地文件读取，快；失败按未同意处理，协议门内可重试）
  useEffect(() => {
    let alive = true
    window.hqsf
      .getAgreement()
      .then((res) => {
        if (!alive) return
        setAgreementOk(!!res.ok && !!res.data && localStorage.getItem(AGREEMENT_KEY) === res.data.version)
      })
      .catch(() => {
        if (alive) setAgreementOk(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // v0.0.3：全局图片加载失败兜底——替换为 1px 透明图 + 灰底（去除浏览器破图图标）
  useEffect(() => {
    const handler = (e: Event): void => {
      const target = e.target
      if (!(target instanceof HTMLImageElement)) return
      if (target.dataset.imgFailed === '1') return
      target.dataset.imgFailed = '1'
      target.classList.add('img-failed')
      target.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
    }
    // 捕获阶段监听，覆盖所有动态注入的 img（正文/头像/封面）
    document.addEventListener('error', handler, true)
    return () => document.removeEventListener('error', handler, true)
  }, [])

  if (agreementOk === null) {
    return <div className="app-loading">正在加载 …</div>
  }

  // v0.0.7：首启协议门——未同意当前版本协议时，先阅读并勾选同意才能进入应用（荒启协议在登录时另行勾选）
  if (!agreementOk) {
    return <FirstRunAgreement onAccepted={acceptAgreement} />
  }

  if (restoring) {
    return <div className="app-loading">正在恢复会话 …</div>
  }

  // v0.0.6：取消「必须登录才能看到内容」——未登录直接进入主界面（本地写作/浏览阅读均可），
  // 登录改为覆盖层模态（用户卡「点击登录」唤起）；session 仅用于展示账号与启用登录态操作
  return (
    <>
      <div className="app-shell">
        <Sidebar />
        <div className="app-right">
          <TopBar />
          <MainArea />
        </div>
      </div>
      {loginOpen && <LoginView />}
    </>
  )
}
