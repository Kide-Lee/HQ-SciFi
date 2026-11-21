import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyInitialSettings } from './stores/settings'
import './styles/index.css'
import { installTauriBridge } from '../../bridge/index'

/**
 * 迁移来源（Tauri 2）：1.x 渲染层入口。Tauri WebView 没有 Electron preload，
 * 故在渲染前安装 `window.hqsf`（85 invoke + 2 事件订阅）；Electron 下
 * `installTauriBridge()` 检测不到 `__TAURI_INTERNALS__`，直接返回、不覆盖 preload 门面，
 * 行为与 1.x 完全一致。
 */
installTauriBridge()

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

applyInitialSettings()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
