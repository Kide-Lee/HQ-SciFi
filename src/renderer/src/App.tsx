import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { TopBar } from './components/TopBar'
import { LoginView } from './components/LoginView'
import { useAuthStore } from './stores/auth'
import { useUiStore } from './stores/ui'

export default function App(): React.JSX.Element {
  const restoring = useAuthStore((s) => s.restoring)
  const restore = useAuthStore((s) => s.restore)
  const loginOpen = useUiStore((s) => s.loginOpen)

  useEffect(() => {
    void restore()
  }, [restore])

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
