import { create } from 'zustand'
import type { UserSession } from '../../../shared/types'
import { useReaderStore } from './reader'
import { useDocsStore } from './docs'

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
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  restoring: true,
  busy: false,
  error: null,

  restore: async () => {
    const res = await window.hqsf.getSession()
    if (!res.ok || !res.data) {
      set({ session: null, restoring: false })
      return
    }
    // 校验 token 有效性：服务端对无效 token 在列表接口静默降级（拿到错误的已发布数据），
    // 失效时清除本地会话并提示重新登录；网络异常（离线）不强制登出
    try {
      const v = await window.hqsf.verifySession()
      if (v.ok && v.data.valid) {
        set({ session: res.data, restoring: false })
        return
      }
      if (v.ok && !v.data.reachable) {
        // 无法联网判定：保留会话（离线可继续本地写作）
        set({ session: res.data, restoring: false })
        return
      }
    } catch {
      // 校验异常按可保留处理，避免误登出
      set({ session: res.data, restoring: false })
      return
    }
    // 明确失效：清除主进程会话（signOut 失败不阻塞本地清除），回登录页提示
    await window.hqsf.logout()
    set({ session: null, restoring: false, error: '登录已过期，请重新登录' })
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
      afterLogin()
      // 登录成功 = 可能切换账号：主进程已清空本地索引，这里同步刷新侧栏四态（避免残留旧账号文章）
      void useDocsStore.getState().refreshArticles()
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

/**
 * 登录成功后的收尾——重置并重拉评审任务
 * （换账号登录时避免上一账号残留的任务徽章/loaded 状态）
 */
function afterLogin(): void {
  useReaderStore.setState({ reviewTaskByCid: {}, reviewTasksLoaded: false })
  void useReaderStore.getState().loadReviewTasks()
}
