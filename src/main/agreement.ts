import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mdToHtml } from './md2html'
import { apiBaseUrl } from './net/apiconfig'
import { parseHuangqiAgreementChunk, EMAIL_PLACEHOLDER } from './agreement-parse'
import type { AgreementData } from '../shared/types'

/**
 * 用户协议加载层：
 * 1) 本应用协议：读取 doc/用户协议.md（打包后为 resources/agreement.md），
 *    解析版本号并用 markdown-it 渲染为 HTML，经 IPC 下发渲染层展示。
 *    版本号用于渲染层比对本地「已同意版本」，协议更新后强制用户重新阅读并同意。
 * 2) 荒启平台用户协议：运行时从网络抓取荒启 h5 协议页（正文为前端静态文本），
 *    解析重组后下发；获取失败时渲染层禁用勾选（不可同意）。
 *    正文解析为纯函数，见 agreement-parse.ts（可独立单测）。
 */

const VERSION_RE = /版本：\s*(v?\d[\d.]*)/

/** 荒启 h5 协议页地址（获取链路：页面 → index.js → 协议 chunk → 解析正文） */
const HUANGQI_H5 = 'https://www.huangqisf.com/h5/'

/** 协议文件候选路径：dev 读仓库 doc/；打包后读 resources/agreement.md（electron-builder extraResources 拷入） */
function agreementPaths(): string[] {
  const paths: string[] = [join(process.cwd(), 'doc', '用户协议.md')]
  if (process.resourcesPath) paths.push(join(process.resourcesPath, 'agreement.md'))
  return paths
}

/** 读取并渲染用户协议；文件缺失/版本号缺失时抛错（由 IPC 层包装为 ApiResult 失败） */
export function loadAgreement(): AgreementData {
  let file: string | null = null
  for (const p of agreementPaths()) {
    try {
      if (existsSync(p)) {
        file = p
        break
      }
    } catch {
      /* 尝试下一候选路径 */
    }
  }
  if (!file) {
    throw new Error(`未找到用户协议文件（已尝试: ${agreementPaths().join(', ')}）`)
  }
  const md = readFileSync(file, 'utf8')
  const versionMatch = md.match(VERSION_RE)
  if (!versionMatch) {
    throw new Error(`用户协议中未找到版本号（${file}，需在首部标注「版本：vX.Y」）`)
  }
  return { version: versionMatch[1], html: mdToHtml(md) }
}

/** 荒启 system/app 接口的应用邮箱（协议「十三、联系我们」末行的 email 变量来源，前端硬编码 key） */
async function fetchHuangqiEmail(): Promise<string> {
  try {
    const res = await fetch(`${apiBaseUrl()}system/app?key=QyAPIZKw`)
    const json = (await res.json()) as { code?: number; data?: { mail?: string } }
    if (json?.code === 1 && typeof json?.data?.mail === 'string' && json.data.mail) return json.data.mail
  } catch {
    /* 邮箱获取失败不阻塞协议展示，留空 */
  }
  return ''
}

/** 荒启协议抓取超时（ms）：超时视为获取失败，避免弱网下登录页长时间 loading */
const FETCH_TIMEOUT_MS = 15000

/**
 * 上游页面改版导致的解析失败提示：追加在解析类错误消息末尾，
 * 引导用户明白失败原因在荒启前端改版、需联系开发者更新解析逻辑（而非网络问题）。
 */
const UPSTREAM_HINT = '（若荒启页面改版，请联系开发者更新协议解析逻辑）'

/** 会话级缓存：同一进程生命周期内抓取成功一次即复用（每次启动重新抓取，协议更新可感知） */
let hqCache: string | null = null

/** 从荒启 h5 网络抓取协议正文 HTML；任一步失败抛错（渲染层据此禁用同意） */
export async function fetchHuangqiAgreement(): Promise<string> {
  if (hqCache) return hqCache

  // 用 Node 原生 fetch（undici，走系统 CA）而非 net.fetch：某些环境 Electron NSS
  // 证书库异常（SEC_ERROR_BAD_DATABASE -8018）会导致 net.fetch 的 HTTPS 失败
  const httpFetch = globalThis.fetch.bind(globalThis)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  const fetchWithTimeout = (url: string): Promise<Response> => httpFetch(url, { signal: ctrl.signal })

  try {
    // 1) 首页 HTML → 业务 JS 入口（index.<hash>.js）
    const homeRes = await fetchWithTimeout(HUANGQI_H5)
    const homeHtml = await homeRes.text()
    const indexMatch = homeHtml.match(/static\/js\/index\.[a-f0-9]+\.js/)
    if (!indexMatch) throw new Error(`未在荒启页面中找到业务脚本入口${UPSTREAM_HINT}`)

    // 2) index.js → 协议页 chunk 的 contenthash
    const indexRes = await fetchWithTimeout(new URL(indexMatch[0], HUANGQI_H5).toString())
    const indexJs = await indexRes.text()
    const chunkMatch = indexJs.match(/"pages-user-agreement":"([a-f0-9]{6,10})"/)
    if (!chunkMatch) throw new Error(`未在荒启脚本中找到用户协议 chunk${UPSTREAM_HINT}`)

    // 3) 协议 chunk → 解析正文
    const chunkUrl = new URL(`static/js/pages-user-agreement.${chunkMatch[1]}.js`, HUANGQI_H5).toString()
    const chunkRes = await fetchWithTimeout(chunkUrl)
    if (!chunkRes.ok) throw new Error(`荒启用户协议 chunk 获取失败（HTTP ${chunkRes.status}）`)
    const chunkSrc = await chunkRes.text()
    const html = parseHuangqiAgreementChunk(chunkSrc)
    if (!html.includes('<h2>')) throw new Error(`荒启用户协议解析失败：未找到协议章节${UPSTREAM_HINT}`)
    // 协议末行邮箱（e._s(e.email)）→ 用 system/app 接口返回的应用邮箱替换；获取失败留空
    const final = html.includes(EMAIL_PLACEHOLDER)
      ? html.split(EMAIL_PLACEHOLDER).join(await fetchHuangqiEmail())
      : html
    hqCache = final
    return final
  } finally {
    clearTimeout(timer)
  }
}
