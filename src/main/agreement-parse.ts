/**
 * 荒启 h5 协议页正文解析（纯函数模块：无 Node/Electron 依赖，可独立单测）。
 *
 * 荒启协议页是 Vue 渲染函数的产物（contenthash 化的 chunk），正文以
 * `e._v("文本")` 形态内嵌在 `staticClass:"agreement-title"/"agreement-text"`
 * 节点里。本模块对上游结构强耦合：若荒启前端改版导致解析失败，
 * 修改 TITLE_RE/TEXT_RE 后务必运行 `npm run test:agreement-parse` 回归。
 */

/** 荒启协议 chunk 中的平台名变量（e.appname）填充值 */
export const HUANGQI_APP_NAME = '荒启科幻'

/** chunk 中章节标题的模板模式（Vue 渲染函数产物） */
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
export const EMAIL_PLACEHOLDER = '__HQSF_EMAIL__'

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
