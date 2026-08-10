import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { TopBar } from './components/TopBar'
import { LoginView } from './components/LoginView'
import { useAuthStore } from './stores/auth'

export default function App(): React.JSX.Element {
  const session = useAuthStore((s) => s.session)
  const restoring = useAuthStore((s) => s.restoring)
  const restore = useAuthStore((s) => s.restore)

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

  // 未登录只能看到登录页（登录前须勾选协议，见 LoginView）
  if (!session) {
    return <LoginView />
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-right">
        <TopBar />
        <MainArea />
      </div>
    </div>
  )
}
