import { app, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 图片本地缓存（hqsf-img:// 自定义协议）。
 * 渲染层 <img> 的 src 换成 hqsf-img://fetch?url=<encodeURIComponent(远端图)> 后，
 * 主进程首次用 net.fetch 下载并落盘到 userData/cache/images/，之后直接读本地文件——
 * 离线可用 + 减少重复下载。文件名 = sha1(url)，天然去重。
 * 首次下载时把响应 Content-Type 写入 <sha1>.meta，后续命中缓存照常返回正确类型。
 * 缓存有总量上限（16MB），超限按文件 mtime 从旧到新删除（含 .meta）。
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
function readContentType(file: string): string {
  try {
    const meta = JSON.parse(readFileSync(metaFileFor(file), 'utf8')) as { ct?: string }
    return typeof meta.ct === 'string' && meta.ct ? meta.ct : 'application/octet-stream'
  } catch {
    return 'application/octet-stream'
  }
}

/**
 * 总字节超限时按 mtime 从旧到新删除图片（连同 .meta），直到水位以下。
 * 图片文件是 sha1 文件名、无扩展名；.tmp 是下载临时文件，不参与统计也不清理。
 */
function trimCacheIfOverLimit(dir: string): void {
  let entries: Array<{ file: string; mtimeMs: number; size: number }> = []
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.tmp') || name.endsWith('.meta')) continue
      const file = join(dir, name)
      const st = statSync(file)
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
      rmSync(e.file, { force: true })
      rmSync(metaFileFor(e.file), { force: true })
      total -= e.size
    } catch {
      /* 删除失败跳过 */
    }
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

      const dir = cacheDir()
      mkdirSync(dir, { recursive: true })
      const hash = fileNameFor(target)
      const file = join(dir, hash)

      // 命中本地缓存
      if (existsSync(file)) {
        const buf = readFileSync(file)
        return new Response(buf, {
          headers: { 'Content-Type': readContentType(file), 'Cache-Control': 'max-age=31536000' }
        })
      }

      // 未命中：下载到临时文件后原子改名，避免中断留下半文件坏缓存
      const resp = await net.fetch(target, { method: 'GET' })
      if (!resp.ok) return new Response(`fetch failed: ${resp.status}`, { status: 502 })
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > MAX_IMAGE_BYTES) return new Response('image too large', { status: 413 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, buf)
      try {
        renameSync(tmp, file)
      } catch {
        // 目标已存在（并发）则丢弃临时文件，用已落盘内容
      }
      // 记录 Content-Type（缓存文件名是 sha1，无扩展名可推断；下载响应头保留图片类型）
      const ct = resp.headers.get('content-type') || 'application/octet-stream'
      try {
        writeFileSync(metaFileFor(file), JSON.stringify({ ct }))
      } catch {
        /* meta 写入失败不影响图片本身 */
      }
      // 新图落盘后检查总量，超限清理最旧
      trimCacheIfOverLimit(dir)
      return new Response(buf, {
        headers: { 'Content-Type': ct, 'Cache-Control': 'max-age=31536000' }
      })
    } catch (err) {
      return new Response(`cache error: ${(err as Error).message}`, { status: 500 })
    }
  })
}
