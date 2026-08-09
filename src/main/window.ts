import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { initDb } from './db'
import { registerImageProtocol } from './imgcache'

/** electron-vite dev 模式下由环境变量注入渲染层 URL */
function rendererUrl(): string {
  return process.env['ELECTRON_RENDERER_URL'] ?? ''
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // v0.0.3：取消系统标题栏，窗口控件（最小化/全屏/关闭）由渲染层顶栏自绘
    frame: false,
    autoHideMenuBar: true,
    title: '荒启科幻',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // v0.0.2：任何界面按 Ctrl+F12 打开/收起开发者工具（打包后同样可用；macOS 亦为 Ctrl 键）
  win.webContents.on('before-input-event', (_event, input) => {
    if (
      input.type === 'keyDown' &&
      input.control &&
      !input.alt &&
      !input.shift &&
      !input.meta &&
      input.key.toLowerCase() === 'f12'
    ) {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
      else win.webContents.openDevTools()
    }
  })

  // v0.0.3：无边框窗口——最大化状态变化通知渲染层（自绘顶栏按钮同步图标）
  win.on('maximize', () => win.webContents.send('hqsf:window-maximized-changed', true))
  win.on('unmaximize', () => win.webContents.send('hqsf:window-maximized-changed', false))

  // 外部链接一律交给系统浏览器，不在应用内新开窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      import('electron').then(({ shell }) => shell.openExternal(url))
    }
    return { action: 'deny' }
  })

  const devUrl = rendererUrl()
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function initApp(): void {
  app.whenReady().then(() => {
    initDb()
    registerImageProtocol()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      // macOS 惯例：点击 Dock 图标且无窗口时重建窗口
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
