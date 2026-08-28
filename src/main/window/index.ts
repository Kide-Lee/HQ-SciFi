import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getAppSettings } from '../infra/settings'

/** electron-vite dev 模式下由环境变量注入渲染层 URL */
function rendererUrl(): string {
  return process.env['ELECTRON_RENDERER_URL'] ?? ''
}

export function createWindow(): BrowserWindow {
  // macOS：用 titleBarStyle:'hiddenInset' 隐藏标题栏但保留原生红绿灯（traffic lights），
  // 红绿灯下移到自绘顶栏（36px）内垂直居中；其余平台维持 frame:false 由渲染层自绘窗口控件。
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // v0.0.3：取消系统标题栏，窗口控件（最小化/全屏/关闭）由渲染层顶栏自绘
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : { frame: false }),
    autoHideMenuBar: true,
    title: '黄芪饮片',
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
    // 确保窗口和 webContents 获得焦点：某些平台/桌面环境下首启偶发窗口已显示
    // 但输入框无法获得焦点/插入光标，显式 focus 可规避。
    win.focus()
    win.webContents.focus()
  })

  // v0.1.10：每次页面加载完成应用缩放与自定义 CSS/JS（首启和刷新均生效）
  win.webContents.on('did-finish-load', () => {
    applyWindowCustomCode(win)
  })

  // v0.0.9：窗口重新获得焦点时也把焦点交还 webContents，降低输入法/键盘状态卡死概率
  win.on('focus', () => {
    if (!win.isDestroyed()) win.webContents.focus()
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

/** 已注入 CSS 的 id，便于更新时移除旧样式避免重复叠加 */
const customCssKeys = new WeakMap<BrowserWindow, string>()

/** v0.1.10：窗口加载完成后应用缩放与自定义代码 */
export function applyWindowCustomCode(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const settings = getAppSettings()
  try {
    if (win.webContents.getZoomFactor() !== settings.zoomFactor) {
      win.webContents.setZoomFactor(settings.zoomFactor)
    }
  } catch {
    /* 窗口销毁竞态忽略 */
  }
  const prevKey = customCssKeys.get(win)
  if (prevKey) {
    customCssKeys.delete(win)
    void win.webContents.removeInsertedCSS(prevKey).catch(() => undefined)
  }
  if (settings.customCss) {
    void win.webContents.insertCSS(settings.customCss, { cssOrigin: 'user' }).then((key) => {
      if (!win.isDestroyed()) customCssKeys.set(win, key)
    }).catch(() => {
      console.error('[settings] 自定义 CSS 注入失败')
    })
  }
  if (settings.customJs) {
    void win.webContents.executeJavaScript(settings.customJs).catch((err: unknown) => {
      console.error('[settings] 自定义 JS 执行失败:', err)
    })
  }
}
