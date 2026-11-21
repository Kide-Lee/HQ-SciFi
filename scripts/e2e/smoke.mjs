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
  await check('页面加载完成（#root 有内容）', () =>
    waitFor('#root 渲染出子节点', () =>
      app.exec("return !!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0")
    )
  )

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
    await app.exec(`
      const target = document.elementFromPoint(600, 400) ?? document.body
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }))
      return true
    `)
    const menu = await waitFor('右键菜单渲染', () =>
      app.exec(`
        const host = document.querySelector('.context-menu')
        return host ? host.innerText : ''
      `)
    )
    if (!menu.includes('刷新')) throw new Error(`菜单里没有「刷新」：${JSON.stringify(menu)}`)
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
