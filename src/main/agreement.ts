import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mdToHtml } from './md2html'
import { apiBaseUrl } from './net/apiconfig'
import type { AgreementData } from '../shared/types'

/**
 * 用户协议加载层：
 * 1) 本应用协议：读取 doc/用户协议.md（打包后为 resources/agreement.md），
 *    解析版本号并用 markdown-it 渲染为 HTML，经 IPC 下发渲染层展示。
 *    版本号用于渲染层比对本地「已同意版本」，协议更新后强制用户重新阅读并同意。
 * 2) 荒启平台用户协议：运行时从网络抓取荒启 h5 协议页（正文为前端静态文本），
 *    解析重组后下发；获取失败时渲染层禁用勾选（不可同意）。
 */

const VERSION_RE = /版本：\s*(v?\d[\d.]*)/

/** 荒启 h5 协议页地址（获取链路：页面 → index.js → 协议 chunk → 解析正文） */
const HUANGQI_H5 = 'https://www.huangqisf.com/h5/'
/** 荒启协议 chunk 中的平台名变量（e.appname）填充值 */
const HUANGQI_APP_NAME = '荒启科幻'

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

// ---------- 荒启平台用户协议（网络获取） ----------

/** chunk 中章节标题/正文的模板模式（Vue 渲染函数产物） */
const TITLE_RE = /staticClass:"agreement-title"\},\[e\._v\("([^"]*)"\)\]\)/g
/**
 * 正文有三种形态：
 * - `e._v("文本...")`（组 1）
 * - `e._v(e._s(e.appname)+"文本...")`（组 2，平台名开头，如「一、关于我们」的正文）
 * - `e._v("邮箱："+e._s(e.email))`（组 1 + 末尾 email 变量，协议末行联系方式）
 */
const TEXT_RE =
  /staticClass:"agreement-text"\},\[e\._v\((?:"((?:[^"]|"\+e\._s\(e\.appname\)\+")*)"(?:\+e\._s\(e\.email\))?|e\._s\(e\.appname\)\+"((?:[^"]|"\+e\._s\(e\.appname\)\+")*)")\)\]\)/g

/** 邮箱占位符：解析时标记 `e._s(e.email)` 拼接处，运行时用荒启 system/app 接口返回的 mail 替换 */
const EMAIL_PLACEHOLDER = '__HQSF_EMAIL__'
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

/** 数字开头的条目（如 5.1 / 8.1.1.1 / 11.2）：组 1 = 序数，组 2 = 条目内容 */
const LIST_ITEM_RE = /^(\d+(?:\.\d+)*\.?)\s*(.*)$/

/**
 * 把协议 chunk 源码解析为 HTML：按出现顺序流式渲染（一个标题后可能跟多条正文），
 * 平台名变量替换为「荒启科幻」；数字开头的正文渲染为 <ul><li> 列表项。
 */
export function parseHuangqiAgreementChunk(src: string): string {
  // 收集 title/text 事件并按源码位置排序，保证顺序与原文一致
  const events: Array<{ pos: number; kind: 'title' | 'text'; value: string }> = []
  for (const m of src.matchAll(TITLE_RE)) {
    events.push({ pos: m.index ?? 0, kind: 'title', value: m[1] })
  }
  for (const m of src.matchAll(TEXT_RE)) {
    const raw = m[1] != null ? m[1] : HUANGQI_APP_NAME + (m[2] ?? '')
    let value = raw.split('"+e._s(e.appname)+"').join(HUANGQI_APP_NAME)
    // 末尾 email 变量（「邮箱：xxx」）→ 占位符，运行时替换为 system/app 返回的 mail
    if ((m[0] ?? '').includes('e._s(e.email)')) value += EMAIL_PLACEHOLDER
    events.push({ pos: m.index ?? 0, kind: 'text', value })
  }
  events.sort((a, b) => a.pos - b.pos)

  const html: string[] = []
  let inList = false
  const closeList = (): void => {
    if (inList) {
      html.push('</ul>')
      inList = false
    }
  }

  for (const ev of events) {
    if (ev.kind === 'title') {
      closeList()
      html.push(`<h2>${ev.value}</h2>`)
    } else if (LIST_ITEM_RE.test(ev.value)) {
      // 数字开头条目：提取序数（如 8.1）作 marker（无顿号）；按层级缩进（8.1.1 相对 8.1 缩进，以此类推）
      const [, marker, rest] = ev.value.match(LIST_ITEM_RE) ?? []
      if (!inList) {
        html.push('<ul class="hq-list">')
        inList = true
      }
      const body = rest || marker || ''
      // 层级：点数 1（如 8.1）为一级与正文对齐，8.1.1 二级缩进 1 级，8.1.1.1 三级缩进 2 级…
      const level = Math.max(0, ((marker ?? '').match(/\./g) ?? []).length - 1)
      html.push(`<li class="lv-${level}"><span class="m">${marker ?? ''}</span><span class="t">${body}</span></li>`)
    } else {
      closeList()
      html.push(`<p>${ev.value}</p>`)
    }
  }
  closeList()
  return html.join('\n')
}

/** 荒启协议抓取超时（ms）：超时视为获取失败，避免弱网下登录页长时间 loading */
const FETCH_TIMEOUT_MS = 15000

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
    if (!indexMatch) throw new Error('未在荒启页面中找到业务脚本入口')

    // 2) index.js → 协议页 chunk 的 contenthash
    const indexRes = await fetchWithTimeout(new URL(indexMatch[0], HUANGQI_H5).toString())
    const indexJs = await indexRes.text()
    const chunkMatch = indexJs.match(/"pages-user-agreement":"([a-f0-9]{6,10})"/)
    if (!chunkMatch) throw new Error('未在荒启脚本中找到用户协议 chunk')

    // 3) 协议 chunk → 解析正文
    const chunkUrl = new URL(`static/js/pages-user-agreement.${chunkMatch[1]}.js`, HUANGQI_H5).toString()
    const chunkRes = await fetchWithTimeout(chunkUrl)
    if (!chunkRes.ok) throw new Error(`荒启用户协议 chunk 获取失败（HTTP ${chunkRes.status}）`)
    const chunkSrc = await chunkRes.text()
    const html = parseHuangqiAgreementChunk(chunkSrc)
    if (!html.includes('<h2>')) throw new Error('荒启用户协议解析失败：未找到协议章节')
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

