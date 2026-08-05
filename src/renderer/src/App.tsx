import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'

export default function App(): React.JSX.Element {
  return (
    <div className="app-shell">
      <Sidebar />
      <MainArea />
    </div>
  )
}
