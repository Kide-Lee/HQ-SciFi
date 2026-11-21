/**
 * Tauri WebView 传输层：`invoke` 极薄包装 + `window.__TAURI_INTERNALS__` 局部类型声明 + 事件订阅。
 *
 * 迁移来源：1.x `src/preload/index.ts`（Electron `contextBridge.exposeInMainWorld('hqsf', …)`，
 * 经 `ipcRenderer.invoke` / `ipcRenderer.on`）。Tauri 2 没有 preload，WebView 由 Tauri 注入
 * `window.__TAURI_INTERNALS__`（含 `invoke` 与 `transformCallback`），本文件在其上做等价传输。
 *
 * 与 Electron 的行为差异：
 * - Electron：`ipcRenderer.invoke` 由主进程 `ipcMain.handle` 返回 `{ok,data}|{ok,error}`，永不因业务失败 reject；
 * - Tauri：命令返回 Rust `Result<T, CommandError>`，成功值是裸载荷，失败会变成 Promise 拒绝
 *   （壳层用 `CoreError::to_envelope()` 生产拒绝载荷 `{ok:false,error:"文案"}`）。
 *   本文件把拒绝统一转成 `new Error(文案)`；信封的重新包装由 `src/bridge/index.ts` 负责。
 * - `window.hqsf` 在 Electron 下由 preload 暴露；在 Tauri 下由 `installTauriBridge()` 安装。
 *
 * 依赖说明：本机无 npm（仅 pnpm），故不新增 `@tauri-apps/api`。若将来允许加依赖，可把
 * `invoke` 换成 `@tauri-apps/api/core` 的 `invoke`、把事件监听换成 `@tauri-apps/api/event` 的
 * `listen`（各一行替换，其余代码不变）。
 */
import type { HqsfApi } from '../shared/contracts/hqsf-api'

/**
 * Tauri 2 注入的内部 API。只声明本桥接用到的成员；
 * `transformCallback` 在部分平台/版本可能不存在，故可选（调用前做特性检测）。
 */
export interface TauriInternals {
  invoke<T>(cmd: string, args?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>
  /** 注册一个 JS 回调并返回 callback id；`plugin:event|listen` 的 handler 参数就是该 id。 */
  transformCallback?(callback: (event: unknown) => void, once?: boolean): number
}

declare global {
  interface Window {
    /** Tauri 2 初始化脚本注入；Electron 下不存在（据此判定运行环境）。 */
    __TAURI_INTERNALS__?: TauriInternals
    /**
     * 渲染层唯一依赖的门面（85 invoke + 2 事件订阅）。
     * Electron：preload 通过 contextBridge 暴露；Tauri：`installTauriBridge()` 安装。
     */
    hqsf: HqsfApi
  }
}

/** 取 Tauri 内部 API；非 Tauri（Electron / 普通浏览器 / 测试环境）返回 null。 */
export function getTauriInternals(): TauriInternals | null {
  if (typeof window === 'undefined') return null
  return window.__TAURI_INTERNALS__ ?? null
}

/** 当前是否运行在 Tauri WebView 里（Electron 下为 false）。 */
export function isTauriRuntime(): boolean {
  return getTauriInternals() !== null
}

/**
 * 从 Rust 命令的拒绝载荷里提取用户可读文案。
 * 正常形如 `{ok:false,error:"文案"}`；同时兼容裸字符串与 `Error`，避免壳层序列化差异导致文案丢失。
 */
export function toErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const record = error as { error?: unknown; message?: unknown }
    if (typeof record.error === 'string') return record.error
    if (typeof record.message === 'string') return record.message
  }
  return String(error)
}

/**
 * 发一条 Tauri 命令。Rust `Err` 时抛 `new Error(文案)`（文案原样，不做改写）。
 * 参数键使用 Rust `#[serde(rename_all = "camelCase")]` 之后的字段名（见 `Tauri命令契约.md` §2）。
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = getTauriInternals()
  if (!internals) throw new Error('Tauri 运行时不可用：未检测到 window.__TAURI_INTERNALS__')
  try {
    return await internals.invoke<T>(cmd, args)
  } catch (error) {
    throw new Error(toErrorMessage(error))
  }
}

/** 事件对象的线上形状（Tauri 2 `plugin:event|listen` 推给 JS 回调的对象）。 */
interface TauriEventEnvelope<T> {
  event: string
  id: number
  payload: T
}

/** 只判别外层信封结构（payload 可以是任意业务值，含 undefined）。 */
function isTauriEventEnvelope<T>(raw: unknown): raw is TauriEventEnvelope<T> {
  return typeof raw === 'object' && raw !== null && 'payload' in raw
}

/**
 * 订阅一个 Tauri 事件，返回**同步**取消订阅函数（对齐 1.x preload 的 `ipcRenderer.on` 返回值语义）。
 *
 * 实现：`transformCallback` 注册 JS 回调拿 handler id → `invoke('plugin:event|listen', {event, handler})`
 * 返回 eventId → 取消时 `invoke('plugin:event|unlisten', {event, eventId})`。
 * 若监听尚未落地就被取消（React 严格模式下 effect 立即 cleanup），会在 listen resolve 后补 unlisten。
 *
 * TODO(verify): 事件桥接。Tauri 2.12 的 `plugin:event|listen` 内部协议（`transformCallback` 的
 * id 形态、事件信封 `{event,id,payload}`、`unlisten` 是否需要 `target`）未在本机实测
 * （本机无 WebKitGTK、壳层尚在实现）；壳层联调时按真实内部 API 校验本段。
 * 内部 API 缺失时降级为 no-op 取消函数并告警，保证渲染层不崩。
 */
export function listenTauriEvent<T>(event: string, handler: (payload: T) => void): () => void {
  const internals = getTauriInternals()
  if (!internals || typeof internals.transformCallback !== 'function') {
    console.warn(`[bridge] 事件桥接不可用（缺少 __TAURI_INTERNALS__.transformCallback），已忽略订阅：${event}`)
    return () => {}
  }

  let disposed = false
  let unlistenId: number | null = null

  try {
    const handlerId = internals.transformCallback((raw) => {
      if (!isTauriEventEnvelope<T>(raw)) return
      handler(raw.payload)
    })
    void invoke<number>('plugin:event|listen', { event, handler: handlerId })
      .then((eventId) => {
        if (disposed) {
          // 订阅期间组件已卸载：补一次 unlisten，避免监听泄漏。
          void invoke('plugin:event|unlisten', { event, eventId }).catch(() => {})
        } else {
          unlistenId = eventId
        }
      })
      .catch((error: unknown) => {
        console.warn(`[bridge] 事件监听失败：${event}`, error)
      })
  } catch (error) {
    console.warn(`[bridge] 事件监听失败：${event}`, error)
  }

  return () => {
    disposed = true
    if (unlistenId !== null) {
      const eventId = unlistenId
      unlistenId = null
      void invoke('plugin:event|unlisten', { event, eventId }).catch(() => {})
    }
  }
}