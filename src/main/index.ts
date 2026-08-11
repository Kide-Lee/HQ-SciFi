import { app } from 'electron'
import { join } from 'node:path'
import { isTestMode } from './testmode'
import { initApp } from './window'

// 测试模式（本地 RuleApi 联调）：独立 userData（~/.config/hqsf-test），
// 数据库/session/设置与正式使用完全隔离；须在 app ready 前设置
if (isTestMode()) {
  app.setPath('userData', join(app.getPath('appData'), 'hqsf-test'))
}

// 单实例锁：避免多开窗口导致同步冲突（测试/正式 userData 不同，锁互不干扰，可同时运行）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  initApp()
}
