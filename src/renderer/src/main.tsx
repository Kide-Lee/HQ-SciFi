import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'

// Electron 渲染进程的 alert() 关闭后可能导致窗口内输入框无法插入光标（已知 bug，
// Windows 上偶发且重启才能恢复）。应用内已统一改用 window.hqsf.showMessageBox
// 走主进程原生对话框；这里再兜底拦截依赖库/遗留代码误调的 alert()。
window.alert = (message?: unknown): void => {
  void window.hqsf.showMessageBox({
    type: 'info',
    title: '提示',
    message: message == null ? '' : String(message)
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
