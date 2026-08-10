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
  /** 新建或更新（覆盖）的本地文件数（草稿与待审核/已发布/已拒绝统一落盘） */
  pulled: number
  /** 远端有更新但本地已修改、保留本地的冲突数 */
  conflicts: number
  /** 拉取的远端条目总数（四类之和） */
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
  /** v0.0.6：相对存档根的路径（''=根；统一 / 分隔；新建文件/文件夹时用） */
  rel: string
  isDir: boolean
  children?: LocalNode[]
  /** v0.0.6：文件信息（仅 md 文件；写作首页卡片展示用） */
  mtime?: number
  /** 正文字数（去空白） */
  words?: number
  /** 摘要（去首部标题后前 100 字） */
  summary?: string
}

// ---------- 阅读与评审（M2 读审一体） ----------

/** 文章关联栏目引用（active/category/collection/tag 数组项，2026-08-08 实测含 name+mid+type） */
export interface MetaRef {
  mid: number | string
  name?: string
  type?: string
  imgurl?: string
  deadline?: number
}

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
  category?: MetaRef[]
  tag?: MetaRef[]
  collection?: MetaRef[]
  cover?: string
  introduction?: string
  views: number
  likes: number
  commentsNum: number
  created: number
  modified: number
  isAnonymous?: boolean
  /** 关联活动（active[0].mid / name） */
  active?: MetaRef[] | null
  /** 字数（列表条目可选） */
  size?: number
  /** 配图（列表条目，images[0] 为封面） */
  images?: string[]
  /** 最后回复时间（列表条目，按回复排序用） */
  replyTime?: number
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
  category?: MetaRef[]
  collection?: MetaRef[]
  active?: MetaRef[] | null
  markdown?: number
  /** 导言（contentsInfo 返回；缺失时客户端从列表缓存回填，避免漏展示有导言的文章） */
  introduction?: string
  /** 当前用户是否已点赞（0/1，2026-08 实测 contentsInfo 返回；用于点赞按钮初始态） */
  isLikes?: number
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
  /**
   * 活动状态（2026-08-08 实测）：1=进行中 / -1=评审中 / 0=已结束；
   * 进行中/评审中的活动文章无评分（score 恒 '-.-'）
   */
  activeStatus?: number
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
  /** 评者 uid（2026-08-08 实测条目含 uid 字段；用于「我的评审」过滤） */
  uid?: string
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
  /** 关联该评审的评论数（reviewList 返回 replyNum，实测与评论列表 reviewid 关联数一致） */
  replyNum?: number
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

// ---------- 评论（hqComments/） ----------

/** 评论条目（commentsList data 项，TypechoComments 表；coid 为评论 id） */
export interface CommentItem {
  /** 评论 id（coid） */
  coid: number | string
  /** 所属文章 cid */
  cid: number | string
  /** 上级评论 coid（0 = 顶层评论；回复他人时传其 coid） */
  parent: number | string
  /** 评论内容（纯文本） */
  text: string
  /** 作者昵称 */
  author: string
  /** 作者 uid（0 = 匿名访客） */
  authorId: number | string
  /** 头像 URL */
  avatar?: string
  /** 创建时间（秒） */
  created: number
  /** 子评论（楼中楼）数 */
  subNum?: number
  /** 父评论摘要（commentsList 返回 parentComments：author/text/created） */
  parentComments?: { author?: string; text?: string; created?: string }
  /**
   * v0.0.3：关联的评审 id（荒启定制版字段，实测 2026-08：0=普通评论，>0=对某评审的回复/讨论）。
   * 由 hqComments/commentsList 与 commentsAdd 的 reviewid 参数承载。
   */
  reviewid?: number | string
}

/** 评论提交结果（commentsAdd） */
export interface CommentSubmitResult {
  ok: boolean
  error?: string
}

// ---------- 用户互动（hqUserlog/：点赞 / 收藏 / 投币） ----------

/** 用户日志操作结果（addLog：likes/mark/reward） */
export interface LogOpResult {
  ok: boolean
  error?: string
}

/** 收藏状态（isMark 查询：cid + type=content） */
export interface MarkStatus {
  /** 是否已收藏 */
  marked: boolean
  /** 收藏日志 id（取消收藏时传给 removeLog 的 key） */
  logid?: number | string
}

// ---------- 用户协议（登录前须阅读并同意） ----------

/** 用户协议内容（主进程读取 md 并渲染为 HTML 后下发；version 用于本地比对是否已同意） */
export interface AgreementData {
  version: string
  html: string
}
