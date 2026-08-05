import { app } from 'electron'
import { initApp } from './window'

// 单实例锁：避免多开窗口导致同步冲突
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  initApp()
}
