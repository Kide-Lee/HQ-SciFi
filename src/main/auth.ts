import { apiRequest, endpoint, ApiError } from './net/api'
import { loadSession, saveSession, clearSession, isStrongEncryption } from './session'
import type { LoginResult, UserSession } from '../shared/types'

/**
 * 认证（api-research.md 第 2 节）：账号密码 hqUsers/userLogin。
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
    const resp = await apiRequest(endpoint('userLogin').path, {
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

/** 读取持久化会话（启动恢复登录态；不含 token，token 不下发渲染层） */
export function getSession(): UserSession | null {
  const s = loadSession()
  if (!s) return null
  return { userinfo: s.userinfo, insecure: s.insecure }
}

/**
 * 校验当前会话 token 是否仍有效。
 *
 * 服务端对无效 token 在列表类接口（contentsList）会静默降级（强制只查已发布、不报错），
 * 因此用登录必需接口探测。2026-08-14 修复：
 * 1. 探测接口从 isMark 换成 markList —— isMark 对 type=content 会先按 cid 查文章，
 *    传入探测用 cid=0 时即使 token 有效也返回 code 0「文章不存在」，导致探测恒失败；
 *    markList 仅按 token 取当前用户收藏列表，无副作用且有效 token 恒返回 code 1。
 * 2. 区分「服务端明确拒绝」（ApiError：token 失效/被拦截，可判定）与「网络异常」
 *    （fetch 失败，无法判定）。此前 catch 一律视为网络异常，token 失效时 valid/reachable
 *    双双为 false，渲染层按「无法联网判定」保留会话 → 用户停留在已登录界面但所有
 *    需登录操作（评论/点赞/收藏/评审）都报「用户未登录或Token验证失败」。
 *
 * 返回 { valid, reachable }：reachable=false 表示网络异常（无法判定，调用方不应强制登出）。
 */
export async function verifySessionToken(): Promise<{ valid: boolean; reachable: boolean }> {
  const s = loadSession()
  if (!s?.token) return { valid: false, reachable: true }
  try {
    const resp = await apiRequest<Record<string, unknown>>(endpoint('markList').path, {
      method: 'GET',
      query: { limit: 1, page: 1, token: s.token }
    })
    return { valid: resp.code === 1, reachable: true }
  } catch (err) {
    // ApiError = 服务端已响应且返回非 1 的 code（如 @LoginRequired 拦截），可明确判定失效；
    // 其余（网络失败/超时）不可判定，交由调用方保留会话。
    return { valid: false, reachable: !(err instanceof ApiError) }
  }
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
      await apiRequest(endpoint('signOut').path, { method: 'GET', query: { token: s.token } })
    } catch {
      /* 远端退出失败不阻塞本地清除 */
    }
  }
  clearSession()
}
