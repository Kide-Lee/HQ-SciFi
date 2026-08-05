import { app, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 图片本地缓存（hqsf-img:// 自定义协议）。
 * 渲染层 <img> 的 src 换成 hqsf-img://fetch?url=<encodeURIComponent(远端图)> 后，
 * 主进程首次用 net.fetch 下载并落盘到 userData/cache/images/，之后直接读本地文件——
 * 离线可用 + 减少重复下载。文件名 = sha1(url)，天然去重。
 * 首次下载时把响应 Content-Type 写入 <sha1>.meta，后续命中缓存照常返回正确类型。
 * 缓存有总量上限（16MB），超限按文件 mtime 从旧到新删除（含 .meta）。
 *
 * 性能优化：
 * - 内存缓存（LRU 上限 8MB）：重复访问同一图直接返回，不再读盘
 * - in-flight 去重：同一 URL 并发请求只下载一次，其余等待同一 Promise
 * - 全部异步 fs（fs/promises），不阻塞主进程
 *
 * 安全：协议 handler 只接受 http(s) URL；渲染层不会直接接触文件系统。
 */

const CACHE_ROOT = 'cache/images'
/** 单图最大缓存字节（10MB，防超大图刷盘） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** 图片缓存总容量上限（16MB） */
const CACHE_MAX_BYTES = 16 * 1024 * 1024
/** 清理目标水位（低于上限 80%，避免频繁清理） */
const CACHE_TARGET_BYTES = Math.floor(CACHE_MAX_BYTES * 0.8)
/** 内存缓存上限（8MB）：LRU 淘汰最久未用 */
const MEM_MAX_BYTES = 8 * 1024 * 1024

interface MemEntry {
  buf: Buffer
  ct: string
  lastUsed: number
}

/** 内存缓存：hash → 图片数据（LRU） */
const memCache = new Map<string, MemEntry>()
let memBytes = 0

/** in-flight 去重：hash → 下载 Promise（同一 URL 并发只下载一次） */
const inflight = new Map<string, Promise<{ buf: Buffer; ct: string }>>()

function cacheDir(): string {
  return join(app.getPath('userData'), CACHE_ROOT)
}

function fileNameFor(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

function metaFileFor(file: string): string {
  return `${file}.meta`
}

/** 读取缓存图片的 Content-Type（.meta 文件，缺省 octet-stream 让 Chromium 嗅探） */
async function readContentType(file: string): Promise<string> {
  try {
    const meta = JSON.parse(await readFile(metaFileFor(file), 'utf8')) as { ct?: string }
    return typeof meta.ct === 'string' && meta.ct ? meta.ct : 'application/octet-stream'
  } catch {
    return 'application/octet-stream'
  }
}

/** 写入内存缓存（LRU：超出 MEM_MAX_BYTES 时淘汰最久未用） */
function memSet(hash: string, entry: MemEntry): void {
  const prev = memCache.get(hash)
  if (prev) memBytes -= prev.buf.length
  memCache.set(hash, entry)
  memBytes += entry.buf.length
  while (memBytes > MEM_MAX_BYTES && memCache.size > 1) {
    // 淘汰最久未用（Map 迭代顺序 = 插入序，此处用 lastUsed 找最旧）
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of memCache) {
      if (v.lastUsed < oldestTs) {
        oldestTs = v.lastUsed
        oldestKey = k
      }
    }
    if (!oldestKey || oldestKey === hash) break
    memBytes -= memCache.get(oldestKey)!.buf.length
    memCache.delete(oldestKey)
  }
}

/** 命中内存缓存（更新 lastUsed 实现 LRU） */
function memGet(hash: string): MemEntry | null {
  const e = memCache.get(hash)
  if (!e) return null
  e.lastUsed = Date.now()
  // 移动到末尾（Map 迭代序=最近使用在尾部，淘汰时从头部近似 LRU）
  memCache.delete(hash)
  memCache.set(hash, e)
  return e
}

/**
 * 总字节超限时按 mtime 从旧到新删除图片（连同 .meta），直到水位以下。
 * 图片文件是 sha1 文件名、无扩展名；.tmp 是下载临时文件，不参与统计也不清理。
 */
async function trimCacheIfOverLimit(dir: string): Promise<void> {
  let entries: Array<{ file: string; mtimeMs: number; size: number }> = []
  let total = 0
  try {
    for (const name of await readdir(dir)) {
      if (name.endsWith('.tmp') || name.endsWith('.meta')) continue
      const file = join(dir, name)
      const st = await stat(file)
      if (!st.isFile()) continue
      entries.push({ file, mtimeMs: st.mtimeMs, size: st.size })
      total += st.size
    }
  } catch {
    return
  }
  if (total <= CACHE_TARGET_BYTES) return
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const e of entries) {
    if (total <= CACHE_TARGET_BYTES) break
    try {
      await rm(e.file, { force: true })
      await rm(metaFileFor(e.file), { force: true })
      total -= e.size
    } catch {
      /* 删除失败跳过 */
    }
  }
}

/** 下载图片并落盘（失败抛错由调用方兜底） */
async function downloadImage(target: string, file: string): Promise<{ buf: Buffer; ct: string }> {
  const resp = await net.fetch(target, { method: 'GET' })
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large')
  const ct = resp.headers.get('content-type') || 'application/octet-stream'
  const dir = cacheDir()
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, buf)
  try {
    await rename(tmp, file)
  } catch {
    // 目标已存在（并发）则丢弃临时文件，用已落盘内容
  }
  try {
    await writeFile(metaFileFor(file), JSON.stringify({ ct }))
  } catch {
    /* meta 写入失败不影响图片本身 */
  }
  // 落盘后异步清理超限缓存（不阻塞本次响应）
  void trimCacheIfOverLimit(dir)
  return { buf, ct }
}

/** 取图：内存缓存 → in-flight 去重 → 磁盘 → 下载 */
async function resolveImage(target: string): Promise<{ buf: Buffer; ct: string }> {
  const hash = fileNameFor(target)
  const file = join(cacheDir(), hash)

  // 1. 内存缓存（LRU）
  const mem = memGet(hash)
  if (mem) return { buf: mem.buf, ct: mem.ct }

  // 2. in-flight 去重：同一 URL 并发只下载一次
  const pending = inflight.get(hash)
  if (pending) return pending

  const task = (async () => {
    // 3. 磁盘缓存
    try {
      const buf = await readFile(file)
      const ct = await readContentType(file)
      memSet(hash, { buf, ct, lastUsed: Date.now() })
      return { buf, ct }
    } catch {
      // 磁盘未命中或损坏：下载
    }
    // 4. 下载
    const result = await downloadImage(target, file)
    memSet(hash, { buf: result.buf, ct: result.ct, lastUsed: Date.now() })
    return result
  })()
  inflight.set(hash, task)
  try {
    return await task
  } finally {
    inflight.delete(hash)
  }
}

/** 注册 hqsf-img:// 协议（app ready 后调用一次） */
export function registerImageProtocol(): void {
  protocol.handle('hqsf-img', async (request) => {
    try {
      const u = new URL(request.url)
      // searchParams.get 已做一次 percent 解码，切勿再 decodeURIComponent（会二次解码破坏 %25 等）
      const target = u.searchParams.get('url')
      if (!target) return new Response('missing url', { status: 400 })
      if (!/^https?:\/\//i.test(target)) return new Response('invalid url', { status: 400 })

      const { buf, ct } = await resolveImage(target)
      return new Response(buf, {
        headers: { 'Content-Type': ct, 'Cache-Control': 'max-age=31536000' }
      })
    } catch (err) {
      return new Response(`cache error: ${(err as Error).message}`, { status: 500 })
    }
  })
}
