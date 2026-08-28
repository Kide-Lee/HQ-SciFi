import { app, BrowserWindow, dialog } from 'electron'
import { initDb } from '../infra/db'
import { registerImageProtocol } from '../infra/media/imgcache'
import { loadApiConfig } from '../infra/net/apiconfig'
import { clearSession } from '../infra/session'
import { getAppSettings } from '../infra/settings'
import { scheduleAutoUpdateCheck } from '../infra/updater'
import { getStoredToken, verifySessionToken } from '../services/auth-service'
import { registerIpcHandlers } from '../ipc'
import { createWindow } from '../window'

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

/** 供启动流程读取缩放设置（若后续需要设置相关启动参数） */
export { getAppSettings }
