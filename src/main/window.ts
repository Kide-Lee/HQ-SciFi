import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { initDb } from './db'
import { registerImageProtocol } from './imgcache'
import { loadApiConfig } from './net/apiconfig'
import { getStoredToken, verifySessionToken } from './auth'
import { clearSession } from './session'
import { getAppSettings } from './settings'
import { scheduleAutoUpdateCheck } from './updater'

/**
 * v0.0.7：启动时校验一次 token——服务端确认失效（非网络异常）则立即丢弃本地会话，
 * 退回未登录状态（此后渲染层 getSession 返回 null，不再展示已登录界面）。
 * 网络异常/校验异常不误清（离线可继续本地写作）；不阻塞窗口创建，渲染层 restore
 * 会做同样的校验兜底（此处保证磁盘上的失效 token 不被残留，独立于渲染层行为）。
 */
async function startupTokenCheck(): Promise<void> {
  try {
    if (!getStoredToken()) return
    const { valid, reachable } = await verifySessionToken()
    if (!valid && reachable) clearSession()
  } catch {
    /* 校验异常不阻塞启动、不误清会话 */
  }
}

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

/** 启动阶段出错：弹窗提示后退出（无 GUI 环境则只写 console，供 CI/日志诊断） */
function failStartup(stage: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[startup] ${stage} failed:`, err)
  try {
    dialog.showErrorBox(`启动失败（${stage}）`, message)
  } catch {
    /* 无 GUI 环境（CI 等）：错误已输出到控制台 */
  }
  app.exit(1)
}

export function initApp(): void {
  app.whenReady().then(() => {
    // 先加载 API 配置（baseUrl + 全部接口定义）：缺失/损坏时立即报错并退出，
    // 错误信息面向编译/打包本应用的开发者（提示复制 api.config.example.json 为 api.config.json）。
    try {
      loadApiConfig()
    } catch (err) {
      failStartup('API 配置加载失败', err)
      return
    }
    // v0.0.10：initDb / 协议注册 / IPC 注册任一失败都弹窗退出，
    // 不再 unhandled rejection 静默无窗口
    try {
      initDb()
    } catch (err) {
      failStartup('本地数据库初始化', err)
      return
    }
    try {
      registerImageProtocol()
    } catch (err) {
      failStartup('图片缓存协议注册', err)
      return
    }
    try {
      registerIpcHandlers()
    } catch (err) {
      failStartup('IPC 处理器注册', err)
      return
    }
    createWindow()
    // v0.1.10：按设置定时检查 GitHub 新版本（失败静默）
    scheduleAutoUpdateCheck()
    // v0.0.7：启动校验一次 token，失效则丢弃（并行执行，不阻塞窗口展示）
    void startupTokenCheck()

    app.on('activate', () => {
      // macOS 惯例：点击 Dock 图标且无窗口时重建窗口
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
