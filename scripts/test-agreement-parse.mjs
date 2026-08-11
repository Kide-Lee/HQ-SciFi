#!/usr/bin/env node
/**
 * parseHuangqiAgreementChunk 快照式回归测试（防 TITLE_RE/TEXT_RE 正则回归）。
 *
 * 纯函数模块 src/main/agreement-parse.ts 无 Node/Electron 依赖，用 esbuild
 * （devDependencies 传递依赖）打包为临时 ESM 后动态 import 执行——
 * 不引入测试框架、不在仓库留产物。
 *
 * 运行：npm run test:agreement-parse（或 node scripts/test-agreement-parse.mjs）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const esbuildBin = join(root, 'node_modules', '.bin', 'esbuild')
const tmpDir = mkdtempSync(join(tmpdir(), 'hqsf-agr-test-'))
const outFile = join(tmpDir, 'agreement-parse.mjs')

try {
  execFileSync(
    esbuildBin,
    [join(root, 'src', 'main', 'agreement-parse.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${outFile}`],
    { stdio: 'pipe' }
  )

  const { parseHuangqiAgreementChunk, EMAIL_PLACEHOLDER, HUANGQI_APP_NAME } = await import(pathToFileURL(outFile).href)

  // —— 用例 1：完整快照（标题/正文/appname 拼接/数字条目/email 变量，按源码顺序渲染）——
  const sample = [
    'e.c("div",{staticClass:"agreement-item"},[e.c("h4",{staticClass:"agreement-title"},[e._v("一、平台说明")])]),',
    'e.c("div",{staticClass:"agreement-text"},[e._v("欢迎使用荒启科幻平台服务。")])]),',
    'e.c("div",{staticClass:"agreement-text"},[e._v(e._s(e.appname)+"官方网址为 www.huangqisf.com。")])]),',
    'e.c("div",{staticClass:"agreement-text"},[e._v("5.1 注册用户应遵守法律法规。")])]),',
    'e.c("div",{staticClass:"agreement-text"},[e._v("8.1.1 具体实施细则。")])]),',
    'e.c("div",{staticClass:"agreement-text"},[e._v("邮箱："+e._s(e.email))])]),'
  ].join('')

  const expected = [
    '<h2>一、平台说明</h2>',
    '<p>欢迎使用荒启科幻平台服务。</p>',
    `<p>${HUANGQI_APP_NAME}官方网址为 www.huangqisf.com。</p>`,
    '<ul class="hq-list">',
    '<li class="lv-0"><span class="m">5.1</span><span class="t">注册用户应遵守法律法规。</span></li>',
    '<li class="lv-1"><span class="m">8.1.1</span><span class="t">具体实施细则。</span></li>',
    '</ul>',
    `<p>邮箱：${EMAIL_PLACEHOLDER}</p>`
  ].join('\n')

  assert.equal(parseHuangqiAgreementChunk(sample), expected)

  // —— 用例 2：标题/正文按源码出现顺序保持（不按类型分组）——
  const seq = parseHuangqiAgreementChunk(
    'e.c("div",{staticClass:"agreement-text"},[e._v("正文在前")])]),' +
    'e.c("div",{staticClass:"agreement-item"},[e.c("h4",{staticClass:"agreement-title"},[e._v("二、在后")])])),'
  )
  assert.ok(seq.indexOf('正文在前') < seq.indexOf('二、在后'))

  // —— 用例 3：空输入 / 无匹配输入 ——
  assert.equal(parseHuangqiAgreementChunk(''), '')
  assert.equal(parseHuangqiAgreementChunk('var x = 1;'), '')

  // —— 用例 4：数字条目列表在新标题处正确闭合 ——
  const mixed = parseHuangqiAgreementChunk(
    'e.c("div",{staticClass:"agreement-text"},[e._v("3.1 甲条目")])]),' +
    'e.c("div",{staticClass:"agreement-text"},[e._v("3.2 乙条目")])]),' +
    'e.c("div",{staticClass:"agreement-item"},[e.c("h4",{staticClass:"agreement-title"},[e._v("三、新章")])])),'
  )
  assert.ok(mixed.includes('</ul>\n<h2>三、新章</h2>'))

  console.log(`✔ agreement-parse 快照测试全部通过（${sample.length} 字节样例 + 3 组补充断言）`)
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
