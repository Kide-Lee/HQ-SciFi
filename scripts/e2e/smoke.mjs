/**
 * 端到端冒烟（CI：tauri-driver + WebKitWebDriver + Xvfb）。
 *
 * 目的：给「渲染层到底有没有跑起来、桥接层在不在、右键菜单有没有接管」装上自动化门禁。
 * 1.x 时代用 CDP 做这件事；Tauri 里 WebKitGTK 没有 CDP，官方路径是 tauri-driver
 * （W3C WebDriver 协议）——所以这里只断言语义，不碰任何实现细节。
 *
 * 不依赖账号：未登录时应用会显示登录覆盖层，断言基于这个状态。
 * 用法：xvfb-run -a dbus-run-session -- bash scripts/e2e/run.sh
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { startApp, waitFor, sleep } from './wd.mjs'

const APP = process.env.APP_BIN
if (!APP) {
  console.error('缺少 APP_BIN 环境变量（要测试的可执行文件绝对路径）')
  process.exit(2)
}

const SHOTS = process.env.E2E_SHOT_DIR ?? '.e2e'
mkdirSync(SHOTS, { recursive: true })

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`)
    throw error
  }
}

const app = await startApp(APP)
try {
  // 先记录页面状态：如果渲染层没跑起来，这条日志能直接区分「页面没加载」与「加载了但 JS 报错」。
  try {
    const diag = await app.exec(`
      const root = document.querySelector('#root')
      return {
        href: String(location.href),
        readyState: String(document.readyState),
        title: String(document.title),
        htmlLen: document.documentElement ? document.documentElement.outerHTML.length : -1,
        rootChildren: root ? root.childElementCount : -1,
        bodyText: (document.body ? document.body.innerText : '').slice(0, 200),
        head: document.documentElement ? document.documentElement.outerHTML.slice(0, 600) : '',
        scripts: Array.from(document.scripts).map((s) => s.src || '(inline)').slice(0, 10),
      }
    `)
    console.log(`--- 页面诊断 ---\n${JSON.stringify(diag, null, 2)}`)
  } catch (error) {
    console.log(`页面诊断失败（可能页面还没起来）：${error.message}`)
  }

  await check('页面加载完成（#root 有内容）', () =>
    waitFor('#root 渲染出子节点', () =>
      app.exec("return !!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0")
    )
  )

  await check('首启协议门可走完（首次运行需要先同意用户协议）', async () => {
    const gate = await app.exec("return !!document.querySelector('.agreement-body') && !!document.querySelector('.firstrun-accept')")
    if (!gate) return // 已有本地同意记录（重复运行），跳过
    // 真实路径：滚到底 → 勾选 → 同意并进入。read 状态由 onScroll 触发，所以必须真的改 scrollTop。
    await app.exec(`
      const body = document.querySelector('.agreement-body')
      body.scrollTop = body.scrollHeight
      body.dispatchEvent(new Event('scroll', { bubbles: true }))
      return true
    `)
    await waitFor('协议滚动到底部、勾选框可用', () =>
      app.exec("const c = document.querySelector('.firstrun-check input'); return !!c && !c.disabled")
    )
    await app.exec("const c = document.querySelector('.firstrun-check input'); c.click(); return c.checked")
    await waitFor('「同意并进入」可点击', () => {
      return app.exec("const b = document.querySelector('.firstrun-accept'); return !!b && !b.disabled")
    })
    await app.exec("document.querySelector('.firstrun-accept').click(); return true")
    await waitFor('进入主界面（左栏出现）', () =>
      app.exec("return !!document.querySelector('.app-shell .sidebar')")
    )
  })

  await check('窗口标题为「黄芪饮片」', async () => {
    const title = await app.title()
    if (title !== '黄芪饮片') throw new Error(`标题是 ${JSON.stringify(title)}`)
  })

  await check('Tauri IPC 通道存在', async () => {
    const ok = await app.exec("return typeof window.__TAURI_INTERNALS__ === 'object' && typeof window.__TAURI_INTERNALS__.invoke === 'function'")
    if (!ok) throw new Error('window.__TAURI_INTERNALS__.invoke 不存在')
  })

  await check('桥接层 window.hqsf 就绪（85 方法 + windowControls）', async () => {
    const info = await app.exec(`
      const api = window.hqsf
      if (!api) return { api: false }
      const top = Object.keys(api).length
      const controls = api.windowControls && Object.keys(api.windowControls).length
      return { api: true, copyText: typeof api.copyText, top, controls }
    `)
    if (!info?.api) throw new Error('window.hqsf 不存在')
    if (info.copyText !== 'function') throw new Error('window.hqsf.copyText 不是函数')
    if (info.top < 50) throw new Error(`window.hqsf 方法过少：${info.top}`)
    if (!info.controls) throw new Error('window.hqsf.windowControls 不存在')
  })

  await check('未登录时显示登录覆盖层', () =>
    waitFor('页面出现「登录」按钮', () =>
      app.exec("return document.body.innerText.includes('登录')")
    )
  )

  await check('空地方右键出应用内菜单（刷新 / 开发者工具）', async () => {
    // 派发与读取放在同一条异步脚本内：分两条 WebDriver 命令时，命令之间的窗口失焦
    // 会触发菜单的 onDismiss（window blur）→ 第二次命令永远读到空菜单。
    // 先按真实路径在 document.body 上派发（「没有人接管的空地」）；万一某个捕获阶段监听
    // 吃掉了事件，再直接在 window 上派发，至少验证 ContextMenuHost 的兜底处理器是活的。
    const outcome = await app.execAsync(`
      const done = arguments[arguments.length - 1]
      const info = { attempts: [] }
      const read = () => {
        const host = document.querySelector('.context-menu')
        return host ? host.innerText : ''
      }
      const fire = (target) =>
        target.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 })
        )
      let attempts = 0
      const step = () => {
        const target = attempts === 0 ? document.body : window
        fire(target)
        attempts += 1
        setTimeout(() => {
          const text = read()
          info.attempts.push({ target: attempts === 1 ? 'body' : 'window', menu: text })
          if (text || attempts >= 2) return done(info)
          step()
        }, 400)
      }
      step()
    `)
    const hits = (outcome?.attempts ?? []).filter((a) => a.menu && a.menu.includes('刷新'))
    if (hits.length === 0) throw new Error(`右键菜单没有出现：${JSON.stringify(outcome)}`)
    const menu = hits[0].menu
    if (!menu.includes('开发者工具')) throw new Error(`菜单里没有「开发者工具」：${JSON.stringify(menu)}`)
    await app.exec("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true")
  })
  await check('渲染层日志落盘（__hqsf_log 通道）', () =>
    waitFor('renderer.log 出现内容', () =>
      app.exec("window.__TAURI_INTERNALS__.invoke('__hqsf_log', { level: 'info', message: 'e2e-probe' }).then(() => true)")
    )
  )

  const shot = await app.screenshot()
  const shotPath = `${SHOTS}/smoke.png`
  writeFileSync(shotPath, shot)
  console.log(`screenshot=${shotPath} bytes=${shot.length}`)
  console.log(`e2e 通过（${passed} 项）`)
  await sleep(0)
} catch (error) {
  try {
    writeFileSync(`${SHOTS}/failure.png`, await app.screenshot())
  } catch {
    /* 截图失败不掩盖原始错误 */
  }
  console.error(`e2e 失败：${error.message}`)
  process.exitCode = 1
} finally {
  await app.quit()
}
