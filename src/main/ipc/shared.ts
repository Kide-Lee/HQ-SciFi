import { BrowserWindow } from 'electron'
import { getSession } from '../services/auth-service'
import type { IpcMainInvokeEvent } from 'electron'

/** IPC 返回约定：成功 { ok: true, data }，失败 { ok: false, error }（避免 Error 序列化丢 message） */
export function ok<T>(data: T) {
  return { ok: true as const, data }
}

export function fail(error: unknown) {
  return { ok: false as const, error: (error as Error).message }
}

/** senderFrame 校验：只接受本应用渲染层页面（生产 file://、dev http://localhost），防其他页面借 IPC 通道 */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  const url = frame?.url ?? ''
  return url.startsWith('file://') || /^https?:\/\/localhost(:\d+)?\//.test(url)
}

export function trusted(event: IpcMainInvokeEvent): Error | null {
  return isTrustedSender(event) ? null : new Error('非法调用来源')
}

/** 当前会话 uid（渲染层不可伪造；多字段容错） */
export function sessionUid(): string {
  return String(getSession()?.userinfo?.uid ?? getSession()?.userinfo?.id ?? '')
}

/** 根据 IPC 事件找到主窗口；窗口已销毁时返回 null */
export function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
}

/** 校验并规整目标 uid；非法值回退为 '0'（匿名/不可用） */
export function checkedUid(raw: unknown): string {
  const v = String(raw ?? '').trim()
  return /^\d+$/.test(v) ? v : '0'
}
