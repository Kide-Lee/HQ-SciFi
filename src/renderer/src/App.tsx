import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { TopBar } from './components/TopBar'
import { LoginView } from './components/LoginView'
import { useAuthStore } from './stores/auth'

/**
 * 会话恢复中页面：无边框窗口须可拖动 + 窗口控件（与登录页一致）——
 * macOS 由系统红绿灯接管（hiddenInset），非 mac 自绘最小化/全屏/关闭。
 */
function RestoringScreen(): React.JSX.Element {
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

  return (
    <div className="app-loading">
      <div className="window-drag-bar" />
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
      <span>正在恢复会话 …</span>
    </div>
  )
}

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
    return <RestoringScreen />
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
