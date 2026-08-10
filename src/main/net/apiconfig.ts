import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 荒启 API 配置加载层。
 *
 * 接口定义（baseUrl + 各接口 path/method）不再硬编码在代码里，统一从 api.config.json 读取：
 * - 程序内所有接口调用经 `endpoint(name)` 取值，未配置的接口会抛 `ApiConfigError`；
 * - 应用启动时由 window.ts 显式调用 `loadApiConfig()` 提前加载——配置缺失/损坏时
 *   立即报错（dialog.showErrorBox + console），提示给编译/打包本应用的开发者。
 *
 * 配置文件不入库（见 .gitignore），仓库提供模板 api.config.example.json。
 */

/** 配置缺失/损坏/取不到接口时抛出的错误类型（面向编译本应用的开发者） */
export class ApiConfigError extends Error {
  constructor(message: string) {
    super(`[API 配置] ${message}`)
    this.name = 'ApiConfigError'
  }
}

export type HttpMethod = 'GET' | 'POST'

export interface ApiEndpoint {
  /** 接口路径（不含基址，如 "hqUsers/userLogin"） */
  path: string
  /** HTTP 方法（接口定义记录；调用处以显式传参为准，此字段供校验与参考，多形态接口如 contentsInfo 由调用处覆盖） */
  method: HttpMethod
}

export interface ApiConfig {
  /** 荒启 API 基址（如 https://api.huangqisf.com/，可指向自建服务端） */
  baseUrl: string
  endpoints: Record<string, ApiEndpoint>
}

/** 程序必需的接口清单（与 api.config.example.json 的 endpoints 一一对应） */
export const REQUIRED_ENDPOINTS = [
  // 认证（auth.ts）
  'userLogin',
  'signOut',
  // 写作同步（sync.ts）
  'contentsList',
  'contentsInfo',
  'contentsAdd',
  'contentsUpdate',
  'uploadFile',
  // 阅读与评审（read.ts）
  'choiceList',
  'selectContents',
  'metasList',
  'gptList',
  'reviewTask',
  'reviewList',
  'addReview',
  'editReview',
  'attitude',
  'commentsList',
  'commentsAdd',
  'addLog',
  'isMark',
  'removeLog'
] as const

export type EndpointName = (typeof REQUIRED_ENDPOINTS)[number]

/** 各接口用途说明（报错时提示开发者补全配置用） */
const ENDPOINT_DESC: Record<EndpointName, string> = {
  userLogin: '账号密码登录',
  signOut: '退出登录',
  contentsList: '文章列表（按状态/作者拉取）',
  contentsInfo: '文章详情（全文）',
  contentsAdd: '新建文章/草稿',
  contentsUpdate: '更新文章/草稿',
  uploadFile: 'multipart 上传文件（配图）',
  choiceList: '精选文章列表',
  selectContents: '按栏目（mid）拉文章列表',
  metasList: '栏目（metas）列表',
  gptList: 'AI 模型列表',
  reviewTask: '评审任务列表',
  reviewList: '评审列表',
  addReview: '提交评审',
  editReview: '编辑评审',
  attitude: '评审态度表态',
  commentsList: '评论列表',
  commentsAdd: '发表评论',
  addLog: '用户互动日志（点赞/收藏/投币）',
  isMark: '查询收藏状态',
  removeLog: '取消收藏'
}

/** 候选配置文件路径（按优先级尝试；前两个在非 Electron 环境也可用，便于测试） */
function candidatePaths(): string[] {
  const paths: string[] = []
  if (process.env.HQSF_API_CONFIG) paths.push(process.env.HQSF_API_CONFIG)
  // 开发模式（npm run dev）cwd 为项目根
  paths.push(join(process.cwd(), 'api.config.json'))
  // 打包后：asar 内 / resources 下（electron-builder extraResources 拷入）
  try {
    // 惰性 require：避免在非 Electron 环境（单元测试）顶层加载失败
    const { app } = require('electron') as typeof import('electron')
    paths.push(join(app.getAppPath(), 'api.config.json'))
  } catch {
    /* 非 Electron 环境跳过 */
  }
  if (process.resourcesPath) paths.push(join(process.resourcesPath, 'api.config.json'))
  return paths
}

/** 校验原始 JSON → ApiConfig；任何缺失/非法字段都抛 ApiConfigError（带开发者可读的修复指引） */
export function validateApiConfig(raw: unknown): ApiConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiConfigError('配置文件顶层必须是对象 { baseUrl, endpoints }')
  }
  const obj = raw as Record<string, unknown>

  const rawBaseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : obj.baseUrl
  if (typeof rawBaseUrl !== 'string' || !/^https?:\/\//i.test(rawBaseUrl)) {
    throw new ApiConfigError(
      `baseUrl 缺失或非法（应为 http(s):// 开头的 URL，当前值: ${JSON.stringify(rawBaseUrl)}）`
    )
  }
  // 归一化尾斜杠：无尾斜杠且带子路径时（如 https://example.com/api），new URL 拼接会静默丢子路径
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : rawBaseUrl + '/'

  const endpointsRaw = obj.endpoints
  if (endpointsRaw == null || typeof endpointsRaw !== 'object' || Array.isArray(endpointsRaw)) {
    throw new ApiConfigError('缺少 endpoints 字段（应为对象 { 接口名: { path, method } }）')
  }
  const src = endpointsRaw as Record<string, unknown>
  const endpoints: Record<string, ApiEndpoint> = {}
  for (const name of REQUIRED_ENDPOINTS) {
    const e = src[name]
    if (e == null || typeof e !== 'object' || Array.isArray(e)) {
      throw new ApiConfigError(
        `endpoints 缺少必填接口 "${name}"（${ENDPOINT_DESC[name]}）。请复制 api.config.example.json 为 api.config.json 后按需修改。`
      )
    }
    const { path, method } = e as Record<string, unknown>
    if (typeof path !== 'string' || path.length === 0) {
      throw new ApiConfigError(
        `endpoints.${name}.path 缺失或为空（${ENDPOINT_DESC[name]}；应为接口路径字符串，如 "hqUsers/userLogin"）`
      )
    }
    if (method !== 'GET' && method !== 'POST') {
      throw new ApiConfigError(
        `endpoints.${name}.method 非法（应为 "GET" 或 "POST"，当前: ${JSON.stringify(method)}）`
      )
    }
    endpoints[name] = { path, method }
  }
  return { baseUrl, endpoints }
}

let cached: ApiConfig | null = null

/** 加载并校验 api.config.json（失败抛 ApiConfigError；启动时应显式调用以便尽早报错） */
export function loadApiConfig(): ApiConfig {
  const candidates = candidatePaths()
  let found: string | null = null
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        found = p
        break
      }
    } catch {
      /* 继续尝试下一路径 */
    }
  }
  if (!found) {
    throw new ApiConfigError(
      `未找到 api.config.json。\n已尝试路径：\n${candidates
        .map((c) => `  - ${c}`)
        .join('\n')}\n请复制 api.config.example.json 为 api.config.json（可修改 baseUrl 指向自建服务端）。`
    )
  }
  let text: string
  try {
    text = readFileSync(found, 'utf8')
  } catch (err) {
    throw new ApiConfigError(`读取配置文件失败（${found}）: ${(err as Error).message}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ApiConfigError(`配置文件 JSON 解析失败（${found}）: ${(err as Error).message}`)
  }
  cached = validateApiConfig(raw)
  return cached
}

/** 获取已加载的配置（惰性加载，加载失败抛 ApiConfigError） */
export function getApiConfig(): ApiConfig {
  if (cached) return cached
  return loadApiConfig()
}

/** 取接口定义（path + 默认 method）；配置缺失该接口时抛 ApiConfigError 提示补全 */
export function endpoint(name: EndpointName): ApiEndpoint {
  const ep = getApiConfig().endpoints[name]
  if (!ep) {
    throw new ApiConfigError(
      `配置中缺少接口 "${name}"（${ENDPOINT_DESC[name] ?? '未知用途'}），请检查 api.config.json 的 endpoints 字段。`
    )
  }
  return ep
}

/** 荒启 API 基址（调用方拼完整 URL 用，如 multipart 上传） */
export function apiBaseUrl(): string {
  return getApiConfig().baseUrl
}

/** path → 完整 URL（基于配置的 baseUrl） */
export function apiUrl(path: string): string {
  return new URL(path, apiBaseUrl()).toString()
}
