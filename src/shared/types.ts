/**
 * 三端共享类型（主进程 / preload / 渲染层）—— 单一来源，避免重复定义漂移。
 */

// ---------- 通用 ----------

export interface ApiRequestOptions {
  method?: 'GET' | 'POST'
  /** GET 查询参数（searchParams/limit/page/order/searchKey 等） */
  query?: Record<string, unknown>
  /** POST form 表单字段（params/token 等，值会被 String() 序列化） */
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

/** IPC 返回约定：成功 { ok:true, data }，失败 { ok:false, error } */
export type ApiResult<T> = { ok: true; data: T; total?: number } | { ok: false; error: string }

// ---------- 文章索引 ----------

/** 文章四态 + 本地未同步草稿 */
export type ArticleType = 'post_draft' | 'waiting' | 'post' | 'reject' | 'local'

export interface ArticleRow {
  /** 远端 cid；本地未同步草稿为 '' */
  cid: string
  title: string
  type: ArticleType
  /** 远端 status 原始值（publish 等） */
  status: string
  authorId: string
  /** 远端 modified 时间戳（秒） */
  remoteModified: number
  /** 本地文件 mtime（毫秒） */
  localModified: number
  /** 上次同步时的本地内容哈希 */
  contentHash: string
  /** 本地 md 文件绝对路径（无则空串） */
  filePath: string
  syncedAt: number
  createdAt: number
  updatedAt: number
}

// ---------- 认证 ----------

/** 渲染层可见的会话信息（token 只留在主进程，经 getStoredToken 使用，不下发渲染层） */
export interface UserSession {
  userinfo: Record<string, unknown>
  /** safeStorage 不可用（Linux 无 keyring / basic_text 后端）降级时的风险提示 */
  insecure: boolean
}

export interface LoginResult {
  ok: boolean
  userinfo?: Record<string, unknown>
  insecure?: boolean
  error?: string
}

// ---------- 同步 ----------

export interface PullResult {
  /** 新建或更新（覆盖）的本地草稿数 */
  pulled: number
  /** 远端有更新但本地已修改、保留本地的冲突数 */
  conflicts: number
  /** 拉取的远端条目总数（三类之和） */
  total: number
  errors: string[]
}

export interface PushResult {
  ok: boolean
  cid?: string
  /** 推送后文章所处状态：post_draft（存草稿）| waiting（已发布） */
  type?: ArticleType
  error?: string
}

// ---------- 本地存档 ----------

export interface LocalNode {
  name: string
  path: string
  isDir: boolean
  children?: LocalNode[]
}
