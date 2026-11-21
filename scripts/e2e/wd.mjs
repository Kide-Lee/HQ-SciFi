/**
 * 零依赖的 W3C WebDriver 客户端（只用到 tauri-driver 需要的那几个端点）。
 *
 * 为什么不用 selenium-webdriver：本仓没有 npm 全局安装，CI 里加依赖会动
 * package-lock.json；而 WebDriver 就是普通 HTTP + JSON，Node 22 自带 fetch 足够。
 */

const BASE = process.env.WD_URL ?? 'http://127.0.0.1:4444'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`WebDriver 返回非 JSON（${res.status}）：${text.slice(0, 400)}`)
  }
  if (!res.ok) {
    const message = json.value?.message ?? JSON.stringify(json).slice(0, 400)
    throw new Error(`WebDriver ${method} ${path} 失败（${res.status}）：${message}`)
  }
  return json.value
}

/** 等 WebDriver 服务起来（tauri-driver 启动后端口很快可用，但 Xvfb 下可能慢一点）。 */
export async function waitForDriver(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      await request('GET', '/status')
      return
    } catch (error) {
      lastError = error
      await sleep(300)
    }
  }
  throw new Error(`WebDriver 端口 ${BASE} 未就绪：${lastError?.message ?? '超时'}`)
}

/** 建会话（tauri-driver 用 `tauri:options.application` 指定要启动的可执行文件）。 */
export async function startApp(application) {
  const value = await request('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application } } }
  })
  const id = value.sessionId
  if (!id) throw new Error(`WebDriver 没有返回 sessionId：${JSON.stringify(value).slice(0, 400)}`)
  return {
    id,
    exec: (script) => request('POST', `/session/${id}/execute/sync`, { script, args: [] }),
    // 异步脚本：用来「同一条命令里派发事件 + 等 React 渲染」，避免两次 WebDriver 命令
    // 之间窗口失焦（会触发 blur → 菜单 onDismiss）把菜单关掉。
    execAsync: (script) => request('POST', `/session/${id}/execute/async`, { script, args: [] }),
    title: () => request('GET', `/session/${id}/title`),
    screenshot: async () => Buffer.from(await request('GET', `/session/${id}/screenshot`), 'base64'),
    quit: async () => {
      try {
        await request('DELETE', `/session/${id}`)
      } catch {
        /* 会话已断开时忽略 */
      }
    }
  }
}

/** 轮询直到 `predicate` 返回真值（页面加载、React 首帧、异步菜单都要等）。 */
export async function waitFor(description, predicate, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastValue
  while (Date.now() < deadline) {
    try {
      lastValue = await predicate()
      if (lastValue) return lastValue
    } catch {
      /* 页面还没就绪时 execute/sync 可能报错，继续等 */
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${description}（最后取值：${JSON.stringify(lastValue)?.slice(0, 200)}）`)
}

export { sleep }
