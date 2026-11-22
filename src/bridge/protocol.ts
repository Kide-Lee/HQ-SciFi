/**
 * 图片缓存协议 URL 的平台适配（纯函数，无副作用、不依赖 bridge 的其它模块）。
 *
 * 迁移来源：1.x `src/renderer/src/lib/sanitize.ts` 的 `cachedImageUrl()`（硬编码
 * `hqsf-img://fetch?url=…`）与 Electron 主进程 `src/main/infra/media/imgcache.ts`
 * 的 `protocol.handle('hqsf-img', …)`。
 *
 * 与 Electron 的行为差异：
 * - Electron：自定义协议 URL 形如 `hqsf-img://fetch?url=…`（`fetch` 是 host，主进程用
 *   `new URL(request.url).searchParams.get('url')` 解析）——保持不变；
 * - Tauri 2：Windows / Android 的 WebView 只能通过 `http://<scheme>.localhost/<path>`
 *   访问自定义协议，macOS / Linux 用 `<scheme>://localhost/<path>`（Tauri 官方规则）；
 *   故 Tauri 下改成 `http://hqsf-img.localhost/fetch?url=…` 或
 *   `hqsf-img://localhost/fetch?url=…`。壳层需把缓存协议注册为 `hqsf-img`、路径 `/fetch`。
 *
 * 渲染层业务文件不直接拼协议 URL，统一调用本函数（`sanitize.ts` 的 `cachedImageUrl` 与
 * `mdPreview.ts` 的图片改写都走这里）。
 */

/** Windows 与 Android 只接受 http(s) 形式的自定义协议 URL（大小写不敏感匹配 UA）。 */
const HTTP_PROTOCOL_PLATFORM_RE = /Windows|Android/i

/** 是否运行在 Tauri WebView 里；非 Tauri（Electron / 浏览器 / 测试环境）沿用 Electron 的旧 URL。 */
function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 当前平台的自定义协议是否必须用 http(s) 形式。 */
function usesHttpProtocolUrl(): boolean {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return HTTP_PROTOCOL_PLATFORM_RE.test(userAgent)
}

/**
 * 把远端 http(s) 图片地址转成图片缓存协议 URL（非 http(s) 原样返回。
 * - Electron：`hqsf-img://fetch?url=…`（与 1.x 完全一致）
 * - Tauri + Windows/Android：`http://hqsf-img.localhost/fetch?url=…`
 * - Tauri + macOS/Linux：`hqsf-img://localhost/fetch?url=…`
 */
const IMAGE_CACHE_EPOCH_KEY = 'hqsf-img-cache-epoch'

/** 图片缓存代次：清除缓存 / 换图后递增，让 WebView 丢弃旧 URL 的字节缓存。 */
function imageCacheEpoch(): string {
  try {
    return localStorage.getItem(IMAGE_CACHE_EPOCH_KEY) ?? '0'
  } catch {
    return '0'
  }
}

/** 设置里的「清除缓存」成功后调用：下一次渲染的图片 URL 带新代次。 */
export function bumpImageCacheEpoch(): void {
  try {
    localStorage.setItem(IMAGE_CACHE_EPOCH_KEY, String(Date.now()))
  } catch {
    // 隐私模式 / 无 localStorage：退化为不缓存 URL 版本，不影响功能
  }
}

export function imageCacheUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url
  const query = `?url=${encodeURIComponent(url)}&v=${imageCacheEpoch()}`
  if (!hasTauriRuntime()) return `hqsf-img://fetch${query}`
  const origin = usesHttpProtocolUrl() ? 'http://hqsf-img.localhost' : 'hqsf-img://localhost'
  return `${origin}/fetch${query}`
}