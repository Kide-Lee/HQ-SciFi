import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { LoginView } from './components/LoginView'
import { useAuthStore } from './stores/auth'

export default function App(): React.JSX.Element {
  const session = useAuthStore((s) => s.session)
  const restoring = useAuthStore((s) => s.restoring)
  const restore = useAuthStore((s) => s.restore)

  useEffect(() => {
    void restore()
  }, [restore])

  if (restoring) {
    return <div className="app-loading">正在恢复会话 …</div>
  }

  if (!session) {
    return <LoginView />
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <MainArea />
    </div>
  )
}
