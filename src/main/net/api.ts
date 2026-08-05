import { net } from 'electron'

/** 荒启 API 基址（已实测确认，详见 api-research.md） */
export const API_BASE = 'https://api.huangqisf.com/'

export interface ApiResponse<T = unknown> {
  code: number
  msg: string
  data: T
  total?: number
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST'
  /** GET 查询参数（searchParams/limit/page/order/searchKey 等） */
  query?: Record<string, unknown>
  /** POST form 表单字段（params/token 等，值会被 String() 序列化） */
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 通用请求封装：统一走 Chromium 网络栈（net.fetch，支持系统代理），
 * 遵循荒启响应约定 { code, msg, data, total }（code:1 成功）。
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<ApiResponse<T>> {
  const { method = 'GET', query, body, headers } = options
  const url = new URL(path, API_BASE)

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'HuangqiSciFi-Client/0.1.0',
    ...headers
  }

  let requestBody: string | undefined
  if (method === 'GET' && query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      qs.set(k, String(v))
    }
    url.search = qs.toString()
  } else if (method === 'POST' && body) {
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue
      form.set(k, String(v))
    }
    requestBody = form.toString()
  }

  let res: Response
  try {
    res = await net.fetch(url.toString(), { method, headers: finalHeaders, body: requestBody })
  } catch (err) {
    throw new Error(`网络请求失败: ${(err as Error).message}`)
  }

  const text = await res.text()
  let json: ApiResponse<T>
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`)
  }

  if (json.code !== 1) {
    throw new ApiError(json.code ?? -1, json.msg || `接口错误（code=${json.code}）`)
  }
  return json
}
