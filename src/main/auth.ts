import { apiRequest } from './net/api'
import { loadSession, saveSession, clearSession, isStrongEncryption } from './session'
import type { LoginResult, UserSession } from '../shared/types'

/**
 * 认证（api-research.md 第 2 节）：账号密码 hqUsers/userLogin、手机验证码 phoneLogin + SendCode。
 * 登录成功后 token 经 safeStorage 加密持久化；退出 signOut。
 */

/** 从登录响应中容错提取 token / uid / nickname（返回结构以实测为准，多种形态兼容） */
function extractIdentity(data: unknown): { token?: string; uid?: string; nickname?: string } {
  if (data == null || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const token = typeof d.token === 'string' ? d.token : undefined
  const info = (typeof d.userinfo === 'object' && d.userinfo != null ? d.userinfo : d) as Record<string, unknown>
  const uid = info.uid != null ? String(info.uid) : info.id != null ? String(info.id) : undefined
  const nickname = typeof info.nickname === 'string' ? info.nickname : typeof info.nick === 'string' ? info.nick : undefined
  return { token, uid, nickname }
}

/**
 * 规范化用户信息：合并响应顶层（剔除 token）与 userinfo 嵌套层，
 * 供渲染层按实际字段名（nickname/nick/userName/avatar/headImg/uid…）容错展示。
 */
function normalizeUserinfo(data: unknown): Record<string, unknown> {
  if (data == null || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const nested =
    typeof d.userinfo === 'object' && d.userinfo != null ? (d.userinfo as Record<string, unknown>) : {}
  const { token: _token, ...rest } = d
  return { ...nested, ...rest }
}

export async function loginWithPassword(name: string, password: string): Promise<LoginResult> {
  try {
    const resp = await apiRequest('hqUsers/userLogin', {
      method: 'POST',
      body: { params: JSON.stringify({ name, password }) }
    })
    const { token, uid, nickname } = extractIdentity(resp.data)
    if (!token) return { ok: false, error: '登录响应缺少 token（接口结构可能变化）' }
    // 顶层 uid 缺失时（uid 嵌在 userinfo 下），从规范化的 userinfo 再补一次
    const userinfo = normalizeUserinfo(resp.data)
    if (uid && userinfo.uid == null) userinfo.uid = uid
    if (nickname && userinfo.nickname == null) userinfo.nickname = nickname
    saveSession({ token, userinfo })
    return { ok: true, userinfo, insecure: !isStrongEncryption() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function sendSmsCode(phone: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await apiRequest('hqUsers/SendCode', {
      method: 'POST',
      body: { params: JSON.stringify({ phone }) }
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function loginWithPhone(phone: string, code: string): Promise<LoginResult> {
  try {
    const resp = await apiRequest('hqUsers/phoneLogin', {
      method: 'POST',
      body: { params: JSON.stringify({ phone, code }) }
    })
    const { token, uid, nickname } = extractIdentity(resp.data)
    if (!token) return { ok: false, error: '登录响应缺少 token（接口结构可能变化）' }
    // 顶层 uid 缺失时（uid 嵌在 userinfo 下），从规范化的 userinfo 再补一次
    const userinfo = normalizeUserinfo(resp.data)
    if (uid && userinfo.uid == null) userinfo.uid = uid
    if (nickname && userinfo.nickname == null) userinfo.nickname = nickname
    saveSession({ token, userinfo })
    return { ok: true, userinfo, insecure: !isStrongEncryption() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 读取持久化会话（启动恢复登录态；不含 token，token 不下发渲染层） */
export function getSession(): UserSession | null {
  const s = loadSession()
  if (!s) return null
  return { userinfo: s.userinfo, insecure: s.insecure }
}

/** 仅供主进程内部使用的 token */
export function getStoredToken(): string | null {
  return loadSession()?.token ?? null
}

/** 退出登录：调用远端 signOut + 清除本地会话 */
export async function logout(): Promise<void> {
  const s = loadSession()
  if (s?.token) {
    try {
      await apiRequest('hqUsers/signOut', { method: 'POST', body: { token: s.token } })
    } catch {
      /* 远端退出失败不阻塞本地清除 */
    }
  }
  clearSession()
}
