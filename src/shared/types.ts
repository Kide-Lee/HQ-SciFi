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
  /**
   * raw 模式：跳过 {code,msg,data} 约定校验，直接返回解析后的 JSON 对象。
   * 用于响应不遵循约定、成功响应为裸对象（如 hqContents/contentsInfo 返回文章对象）的接口。
   */
  raw?: boolean
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

// ---------- 阅读与评审（M2 读审一体） ----------

/** 文章列表条目（contentsList data 项，字段见 api-research.md） */
export interface RemoteArticle {
  cid: string
  title: string
  type: string
  status: string
  /** 评分（"3.9" / 未评 "-.-"） */
  score: string
  /** 400 字纯文本摘要（无 HTML 标签） */
  text: string
  authorId: string
  authorInfo?: Record<string, unknown>
  category?: unknown
  tag?: unknown
  collection?: unknown
  cover?: string
  introduction?: string
  views: number
  likes: number
  commentsNum: number
  created: number
  modified: number
  isAnonymous?: boolean
  /** 关联活动（active[0].mid） */
  active?: Array<{ mid: number | string }> | null
  /** 字数（列表条目可选） */
  size?: number
  /** 配图（列表条目，images[0] 为封面） */
  images?: string[]
}

/** 文章详情（contentsInfo 裸对象；text 为完整 HTML 正文） */
export interface ArticleDetail {
  cid: string
  title: string
  /** 完整正文（Quill HTML，isMd:0） */
  text: string
  score: string
  authorId: string
  userJson?: Record<string, unknown>
  views: number
  likes: number
  commentsNum: number
  created: number
  modified: number
  size?: number
  isAnonymous?: boolean
  category?: unknown
  active?: Array<{ mid: number | string }> | null
  markdown?: number
}

/** 文章列表拉取选项（contentsList / selectContents / choiceList） */
export interface ArticleListOptions {
  /** searchParams JSON 对象（type/category/mid/authorId 等，服务端过滤） */
  searchParams?: Record<string, unknown>
  /** 分类 mid（走 selectContents 拉分类文章；作品库/连载/活动/tag 通用） */
  mid?: number | string
  /** 精选源（choiceList；公开、固定顺序、分页生效） */
  choice?: boolean
  limit?: number
  page?: number
  order?: string
  searchKey?: string
}

// ---------- 栏目与模型（M3 内容浏览） ----------

/** metas 栏目条目（hqMetas/metasList，类型 category/serial/collection/active/tag） */
export interface MetaInfo {
  mid: number | string
  type: string
  name: string
  slug: string
  description?: string
  imgurl?: string
  /** 关联文章数（实测多为 0，列表取数走 selectContents） */
  count?: number
  deadline?: number
  isReview?: number
}

/** AI 模型条目（gpt/gptList；对应推荐栏目「AI模型」） */
export interface GptModel {
  id: number | string
  name: string
  intro: string
  avatar?: string
  /** type 0=通用助手 / 1=专项大师（润色/翻译等） */
  type: number
  price: number
  source: string
}

/** 评审条目（reviewList data 项） */
export interface ReviewItem {
  id: number | string
  /** 被评审文章 cid */
  cid?: number | string
  activeid?: number | string
  isAi?: number
  attitudeType?: number
  /** 综合得分 */
  actualscore?: string
  /** 逗号分隔五维分数串（dianzi,wenbi,jiezou,renwu,liyi） */
  score?: string
  /** 五维评语（dianzi=设定 / wenbi=文笔 / renwu=人物 / jiezou=情节 / liyi=思想性） */
  dianzi?: string
  wenbi?: string
  renwu?: string
  jiezou?: string
  liyi?: string
  /** 综合评价（选填） */
  zonghe?: string
  /** 态度计数（joy 开心 / helpful 有用 / earnest 认真） */
  joy?: number
  helpful?: number
  earnest?: number
  userJson?: Record<string, unknown>
  /** 被评审文章信息（reviewList 的 articleInfo） */
  articleInfo?: Record<string, unknown>
  created?: number
}

/** 提交/编辑评审载荷（addReview / editReview 的 params JSON） */
export interface ReviewPayload {
  /** 五维评语（各 ≥10 字） */
  dianzi: string
  wenbi: string
  renwu: string
  jiezou: string
  liyi: string
  /** 综合评价（选填） */
  zonghe?: string
  /** 五维评分 0-10 */
  dianziScore: number
  wenbiScore: number
  renwuScore: number
  jiezouScore: number
  liyiScore: number
  /** 目标文章 cid */
  cid: string
  /** 关联活动 mid（无活动传 0） */
  activeid?: number | string
  /** 编辑已有评审时传评审 id */
  id?: number | string
}

/** 评审提交结果 */
export interface ReviewSubmitResult {
  ok: boolean
  error?: string
}

// ---------- 评审任务（reviewTask，M3 文章卡片强调） ----------

/** 评审任务条目（review/reviewTask，按 uid 查：status 0=待评审 / 1=已完成） */
export interface ReviewTaskItem {
  /** 被评审文章 cid */
  cid: string
  /** 0 待评审 / 1 已完成（非 0 视为已完成） */
  status: number
  /** 关联活动 mid（练笔期次） */
  activeid?: number | string
  activeName?: string
  articleTitle?: string
}
