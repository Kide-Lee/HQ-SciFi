import { create } from 'zustand'
import type { UserSession } from '../../../shared/types'
import { useReaderStore } from './reader'

interface AuthState {
  /** 当前会话（用户信息；token 只存在主进程，不下发渲染层） */
  session: UserSession | null
  /** 启动时恢复会话中 */
  restoring: boolean
  /** 登录请求进行中 */
  busy: boolean
  /** 最近一次登录错误文案 */
  error: string | null
  restore: () => Promise<void>
  loginPassword: (name: string, password: string) => Promise<boolean>
  sendSmsCode: (phone: string) => Promise<string | null>
  loginPhone: (phone: string, code: string) => Promise<boolean>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  restoring: true,
  busy: false,
  error: null,

  restore: async () => {
    const res = await window.hqsf.getSession()
    set({ session: res.ok ? res.data : null, restoring: false })
  },

  loginPassword: async (name, password) => {
    set({ busy: true, error: null })
    const res = await window.hqsf.loginPassword(name, password)
    if (res.ok && res.data.ok) {
      set({
        session: {
          userinfo: res.data.userinfo ?? {},
          insecure: res.data.insecure ?? false
        },
        busy: false
      })
      return true
    }
    set({ busy: false, error: res.ok ? res.data.error ?? '登录失败' : res.error })
    return false
  },

  sendSmsCode: async (phone) => {
    const res = await window.hqsf.sendSmsCode(phone)
    if (res.ok && res.data.ok) return null
    return res.ok ? res.data.error ?? '发送失败' : res.error
  },

  loginPhone: async (phone, code) => {
    set({ busy: true, error: null })
    const res = await window.hqsf.loginPhone(phone, code)
    if (res.ok && res.data.ok) {
      set({
        session: {
          userinfo: res.data.userinfo ?? {},
          insecure: res.data.insecure ?? false
        },
        busy: false
      })
      return true
    }
    set({ busy: false, error: res.ok ? res.data.error ?? '登录失败' : res.error })
    return false
  },

  logout: async () => {
    await window.hqsf.logout()
    // 换账号时清空评审任务标记与拉取状态，避免残留/不重拉
    useReaderStore.setState({ reviewTaskByCid: {}, reviewTasksLoaded: false })
    set({ session: null, error: null })
  }
}))
