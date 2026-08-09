import { net } from 'electron'
import type { ApiRequestOptions } from '../../shared/types'

/** 荒启 API 基址（已实测确认，详见 api-research.md） */
export const API_BASE = 'https://api.huangqisf.com/'

export interface ApiResponse<T = unknown> {
  code: number
  msg: string
  data: T
  total?: number
}

export { type ApiRequestOptions }

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
 * 通用请求封装：统一走 Chromium 网络栈（net.fetch，支持系统代理）。
 * 默认遵循荒启响应约定 { code, msg, data, total }（code:1 成功）；
 * options.raw 时跳过约定校验，直接返回解析后的 JSON（用于裸对象响应的接口，如 contentsInfo）。
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions & { raw: true }
): Promise<T>
export async function apiRequest<T = unknown>(
  path: string,
  options?: ApiRequestOptions
): Promise<ApiResponse<T>>
export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<ApiResponse<T> | T> {
  const { method = 'GET', query, body, headers, raw = false } = options
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
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`)
  }

  // raw 模式：不校验 code，直接返回解析后的对象
  if (raw) return json as T

  const typed = json as unknown as ApiResponse<T>
  if (typed.code !== 1) {
    // code 缺失或非 1：错误信息带响应原文片段，便于定位（contentsInfo 等裸对象接口会走到这）
    const snippet = text.slice(0, 200)
    throw new ApiError(
      typed.code ?? -1,
      typed.msg || `接口错误（code=${typed.code ?? 'undefined'}）: ${snippet}`
    )
  }
  return typed
}

/**
 * v0.0.6：下载二进制资源（文章配图拉取用；走 Chromium 网络栈）。
 * 失败抛错；返回 Buffer。
 */
export async function downloadBinary(url: string): Promise<Buffer> {
  let res: Response
  try {
    res = await net.fetch(url)
  } catch (err) {
    throw new Error(`图片下载失败: ${(err as Error).message}`)
  }
  if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('图片内容为空')
  return buf
}

/**
 * v0.0.6：multipart 上传文件（upload/full：file + token）。
 * 返回响应 JSON（荒启约定 code:1 成功，data.url 为图片地址）。
 */
export async function uploadMultipart(url: string, token: string, filename: string, buffer: Buffer): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)]), filename)
  form.append('token', token)
  let res: Response
  try {
    res = await net.fetch(url, { method: 'POST', body: form })
  } catch (err) {
    throw new Error(`上传请求失败: ${(err as Error).message}`)
  }
  const text = await res.text()
  let json: { code?: number; msg?: string; data?: { url?: string } }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`上传返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`)
  }
  if (json.code !== 1 || !json.data?.url) {
    throw new Error(json.msg || `上传失败（code=${json.code ?? 'undefined'}）`)
  }
  return json.data.url
}
