import { app } from 'electron'
import { join } from 'node:path'
import { isTestMode } from './testmode'
import { isHardwareAccelerationEnabled, loadAppSettings } from './settings'
import { initApp } from './window'

// 测试模式（本地 RuleApi 联调）：独立 userData（~/.config/hqsf-test），
// 数据库/session/设置与正式使用完全隔离；须在 app ready 前设置
if (isTestMode()) {
  app.setPath('userData', join(app.getPath('appData'), 'hqsf-test'))
}

// v0.0.9：Linux/Wayland 下修复 fcitx5/ibus 等输入法偶发无法调出的问题。
// --enable-wayland-ime 让 Chromium 在 Wayland 原生接入输入法；
// --ozone-platform-hint=auto 允许 Electron 自动选择 Wayland/X11。
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-wayland-ime')
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

// v0.1.10：硬件加速必须在 ready 前设置；设置同步读入，缺失时使用默认值。
loadAppSettings()
if (!isHardwareAccelerationEnabled()) {
  app.disableHardwareAcceleration()
}

// 单实例锁：避免多开窗口导致同步冲突（测试/正式 userData 不同，锁互不干扰，可同时运行）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  initApp()
}
