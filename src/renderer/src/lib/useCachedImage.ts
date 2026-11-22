import { useEffect, useState } from 'react'

/**
 * 图片字节的渲染层缓存。
 *
 * Wry 在 Android 上会强制把自定义协议的响应头改成 `Cache-Control: no-store`
 * （RustWebViewClient.kt），内核磁盘缓存因此每次都要重新走一遍协议 + 解码。
 * 这里把首次取到的字节转成 blob URL 留在内存里：同一张图再次挂载时直接用
 * blob URL，不再经过协议。
 */
const blobCache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

function load(src: string): Promise<string | null> {
  const running = pending.get(src)
  if (running) return running
  const task = fetch(src)
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => {
      if (!blob) return null
      const url = URL.createObjectURL(blob)
      blobCache.set(src, url)
      return url
    })
    .catch(() => null)
    .finally(() => pending.delete(src))
  pending.set(src, task)
  return task
}

/** 返回可直接给 `<img src>` 的地址：命中缓存用 blob URL，否则先用原地址并后台预热。 */
export function useCachedImage(src?: string): string | undefined {
  const [cached, setCached] = useState<string | undefined>(() => (src ? blobCache.get(src) : undefined))

  useEffect(() => {
    if (!src) {
      setCached(undefined)
      return
    }
    const hit = blobCache.get(src)
    if (hit) {
      setCached(hit)
      return
    }
    setCached(undefined)
    let alive = true
    void load(src).then((url) => {
      if (alive && url) setCached(url)
    })
    return () => {
      alive = false
    }
  }, [src])

  return cached ?? src
}
