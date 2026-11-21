// 生成 L5 markdown 金标准语料：用 Node 跑**真实现**（src/ 下的 TS，非副本），
// 产出 crates/hqsf-core/testdata/markdown/{corpus.jsonl,frontmatter.jsonl,html2md.jsonl}。
//
// 为什么这样生成：`md_to_html` 必须与 1.x markdown-it(+KaTeX) 的输出**逐字节一致**
// （见 crates/hqsf-core/src/infra/markdown/mod.rs 的 doc 注释），
// 所以金标准只能是那个实现本身。语料提交进仓库，CI 只跑 Rust 测试、不依赖 Node。
//
// 用法：node scripts/gen-markdown-corpus.mjs
//   - 仓库全部 .md（git 视角：已跟踪 + 未忽略的新文件，排除依赖/构建目录）
//   - spikes/md/corpus/cases/ 下复用的边界用例（上一轮 SP-5 spike 已备好）
//   - 本脚本内联的边界用例（表格/嵌套列表/任务列表/代码块含 $/linkify/图片/裸 HTML/
//     楷体/CJK 标点/软换行/内联与块级公式/混合 等）
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TESTDATA = join(ROOT, 'crates/hqsf-core/testdata/markdown')
const CORPUS = join(TESTDATA, 'corpus.jsonl')
const FRONTMATTER = join(TESTDATA, 'frontmatter.jsonl')
const HTML2MD = join(TESTDATA, 'html2md.jsonl')
const SPIKE_CASES = join(ROOT, 'spikes/md/corpus/cases')

// TS 源码是无扩展名的相对 import（`../../../shared/kaiti`），Node 的 ESM 解析要求
// 显式扩展名。这里注册一个只在解析失败时补 `.ts` 的钩子——仍然是**直接 import 真实现**，
// 不打包、不复制、不改 src/。
const resolveHook = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      return next(specifier + '.ts', context)
    }
    throw err
  }
}
`
register('data:text/javascript,' + encodeURIComponent(resolveHook))

const { mdToHtml } = await import(pathToFileURL(join(ROOT, 'scripts/markdown-oracle/md2html.ts')).href)
const { parseFrontmatter } = await import(pathToFileURL(join(ROOT, 'src/shared/frontmatter.ts')).href)
// turndown 实例：与 1.x `src/main/services/sync-service.ts:135` 的构造参数逐字一致
// （那边 `const turndown = new TurndownService({...})`，`htmlToMd = html => turndown.turndown(html)`；
//  1.x 的 sync-service 已删除；turndown 的 option 按 1.x 取值（见 scripts/markdown-oracle/README 说明）。
const { default: TurndownService } = await import(pathToFileURL(join(ROOT, 'node_modules/turndown/lib/turndown.cjs.js')).href)

// ---------------------------------------------------------------------------
// 1) 仓库全部 .md
// ---------------------------------------------------------------------------
// git 视角最权威：tracked + untracked-but-not-ignored；-z 避免中文路径被转义。
const EXCLUDE = [
  /^node_modules\//,
  /^\.devtools\//,
  /^dist\//,
  /^out\//,
  /^vendor\//,
  /^spikes\//, // spike 产物不是仓库文档
  /^doc\/spike\/markdown\.md$/ // 语料不自指（否则每次重跑多一条）
]
const repoFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'],
  { cwd: ROOT, encoding: 'utf8' }
)
  .split('\0')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((p) => !EXCLUDE.some((re) => re.test(p)))
  .sort()

// 明确存在但被 gitignore 的本地文档也纳入（它们同样是仓库里的 md）
if (existsSync(join(ROOT, 'doc/api-research.md')) && !repoFiles.includes('doc/api-research.md')) {
  repoFiles.push('doc/api-research.md')
  repoFiles.sort()
}

// ---------------------------------------------------------------------------
// 2) 边界用例：复用 SP-5 spike 的 cases + 本脚本内联用例
// ---------------------------------------------------------------------------
const EXTRA_CASES = [
  // 表格
  ['x01-table-basic', '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |\n| d | e | f |\n'],
  ['x02-table-inline', '| 名称 | 说明 |\n| --- | --- |\n| `a|b` | **粗** *斜* [链](https://x.com) |\n'],
  // 列表
  ['x03-nested-list', '- 一\n  - 一一\n    - 一一一\n- 二\n\n1. 甲\n   1. 甲一\n2. 乙\n'],
  ['x04-task-list', '- [ ] 未完成\n- [x] 已完成\n- [X] 大写完成\n'],
  ['x05-list-with-block', '- 列表项\n\n  ```js\n  const a = 1\n  ```\n\n- 下一项\n'],
  ['x06-tight-vs-loose', '- a\n- b\n\n- c\n\n- d\n'],
  // 代码块 / 行内代码里的 $ 与 markdown 记号
  ['x07-fence-dollar', '```bash\n$ echo $HOME\nif [ -n "$X" ]; then echo "$Y"; fi\n```\n'],
  ['x08-indented-code', '    缩进代码 $not math$ *不斜* <不转义>\n\n普通段落\n'],
  ['x09-inline-code-specials', '行内 `$x$` `*a*` `<b>` `a|b` ``a`b`` 结束\n'],
  // linkify
  ['x10-linkify-bare', '看 https://example.com/a/b?x=1&y=2 和 www.example.org 以及 HTTP://UPPER.CASE 结束。\n'],
  ['x11-linkify-email', '联系 me@example.com 或 a.b+tag@sub.example.co，不是 not@an 也不是 @handle。\n'],
  ['x12-linkify-cjk', '中文https://example.com/中文路径中文，标点（https://a.com）与「https://b.com」。\n'],
  // 图片
  ['x13-image', '![替代文本](https://cdn.example.com/a%20b.png "标题")\n\n![](/local/path.png)\n'],
  ['x14-image-in-link', '[![徽标](https://x.com/i.svg)](https://x.com)\n'],
  // 裸 HTML
  ['x15-html-inline', '前 <b>粗</b> 中 <span class="x">span</span> 后 <br> 与 <img src="a.png"> 结束\n'],
  ['x16-html-block', '<div class="note">\n  块级 html *不解析*\n</div>\n\n普通段落\n'],
  ['x17-html-comment', '前 <!-- 注释 *不解析* --> 后\n\n<!-- 块级注释\n多行 -->\n'],
  // 楷体
  ['x18-kaiti', '前 <span class="kaiti">楷体</span> 后\n'],
  ['x19-kaiti-quirks', '<SPAN CLASS="kaiti">大写</SPAN>\n\n<span class="kaiti" >多余空格</span>\n\n<span class="kaiti font-x">多 class</span>\n'],
  // CJK 与软换行
  ['x20-cjk-softbreak', '第一行中文\n第二行中文（应换行）\n第三行 English mixed 中文\n'],
  ['x21-hardbreak', '第一行  \n第二行（两空格硬换行）\n第三行\\\n第四行（反斜杠硬换行）\n'],
  ['x22-cjk-punctuation', '标题：值；列表，逗号。「引号」《书名》——破折号…省略号\n\n**加粗：中文。** *斜体，中文。*\n'],
  // 数学
  ['x23-inline-math', '质能方程 $E=mc^2$，以及 $\\frac{a}{b}$ 与 $\\sqrt{x+1}$。\n'],
  ['x24-block-math-single', '$$\nE = mc^2\n$$\n'],
  ['x25-block-math-inline-form', '$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n'],
  ['x26-block-math-multiline', '$$\n\\begin{aligned}\na &= b + c \\\\\nd &= e - f\n\\end{aligned}\n$$\n'],
  ['x27-math-edge-dollars', '价格 $100 与 $200 不是公式；连写 $$ 也不是；转义 \\$5 是字面量。\n'],
  ['x28-math-in-list-quote', '- 列表里的 $x^2$\n- 第二项 $a+b$\n\n> 引用里的 $y_1$\n>\n> > 嵌套引用 $z^3$\n'],
  ['x29-math-in-heading-table', '## 标题 $x^2$\n\n| 公式 | 说明 |\n| --- | --- |\n| $a^2$ | 平方 |\n'],
  ['x30-math-error', '非法 $\\notacommand$ 与未闭合 $abc 结尾\n\n未闭合块级：\n\n$$\n未闭合\n\n普通段落 $ok$\n'],
  ['x31-math-emphasis', '混合 *$x$* 与 **$y$** 以及 *a $z* b$ c*\n'],
  ['x32-math-code-skip', '代码 `$a$` 与链接 [x](https://e.com/$b$) 不解析；裸 $c$ 解析。\n'],
  // 其它行内语法
  ['x33-emphasis-strike', '**粗体** *斜体* ***粗斜*** ~~删除线~~ __下划线式斜体__ 结束\n'],
  ['x34-entity-autolink', '实体 &amp; &#65; &copy; 与自动链接 <https://example.com/a?b=1&c=2> 和 <me@example.com>\n'],
  ['x35-hr-blockquote', '> 引用第一段\n>\n> 第二段\n\n---\n\n> - 引用里的列表\n> - 第二项\n'],
  ['x36-mixed-doc', '# 标题\n\n段落带 $x$、https://e.com 与 <span class="kaiti">楷体</span>。\n\n- 列表\n  1. 嵌套\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = `$b$`\n```\n\n> 引用\n\n$$y^2$$\n']
]

const cases = []
if (existsSync(SPIKE_CASES)) {
  for (const file of readdirSync(SPIKE_CASES).filter((f) => f.endsWith('.md')).sort()) {
    cases.push([file.slice(0, -3), readFileSync(join(SPIKE_CASES, file), 'utf8')])
  }
}
for (const [name, md] of EXTRA_CASES) cases.push([name, md])

// ---------------------------------------------------------------------------
// 3) 生成 corpus.jsonl（name/input/html）
// ---------------------------------------------------------------------------
mkdirSync(TESTDATA, { recursive: true })
const lines = []
for (const rel of repoFiles) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  lines.push(JSON.stringify({ name: `repo/${rel}`, input: src, html: mdToHtml(src) }))
}
for (const [name, md] of cases) {
  lines.push(JSON.stringify({ name: `case/${name}`, input: md, html: mdToHtml(md) }))
}
writeFileSync(CORPUS, lines.join('\n') + '\n')

// ---------------------------------------------------------------------------
// 4) 生成 frontmatter.jsonl（name/input/meta/body）——两端对拍 parseFrontmatter
// ---------------------------------------------------------------------------
const FRONTMATTER_CASES = [
  ['fm-basic', '---\ncategory: 原创作品\nactive: 征文\ntags: [科幻, 太空]\nisopen: false\n---\n正文第一行\n正文第二行'],
  ['fm-list', '---\ntags:\n  - 科幻\n  - "太空"\n  - \'时间\'\ncategory: 原创作品\n---\n正文'],
  ['fm-empty-body', '---\ncategory: 活动\n---'],
  ['fm-no-frontmatter', '# 标题\n\n正文，无 frontmatter。'],
  ['fm-unclosed', '---\ncategory: 未闭合\n\n正文还在继续'],
  ['fm-comments-blank', '---\n# 注释行\n\ncategory: 原创作品\n# 又一个注释\nisopen: true\n---\n\n\n正文'],
  ['fm-quotes', '---\ncategory: "原创作品"\nactive: \'活动\'\ntags: ["a", \'b\', "c"]\nisopen: "false"\n---\n正文'],
  ['fm-array-quoted-commas', '---\ntags: [a, "b,c", \'d\']\n---\n正文'],
  ['fm-bool-variants', '---\nisopen: TRUE\n---\n正文'],
  ['fm-isopen-garbage', '---\nisopen: maybe\ncategory: ""\ntags: []\n---\n正文'],
  ['fm-key-charset', '---\ncat-egory: 不合法键\n_ok: 合法键\ntags: [x]\n---\n正文'],
  ['fm-leading-bom', '\uFEFF---\ncategory: BOM 开头\n---\n正文'],
  ['fm-crlf', '---\r\ncategory: 回车换行\r\ntags: [a, b]\r\n---\r\n正文\r\n第二行'],
  ['fm-leading-blank', '\n---\ncategory: 空行开头\n---\n正文'],
  ['fm-indented-dashes', '---\n  category: 前置空格\n    tags: [a]\n  - b\n---\n正文'],
  ['fm-no-trailing-newline', '---\ncategory: 无尾换行\n---\n正文'],
  ['fm-dash-in-value', '---\ncategory: 原创-作品\ntags: [a-b, c]\n---\n正文'],
  ['fm-short-body', '---\nisopen: false\n---\n'],
  ['fm-nested-colon', '---\ncategory: 前缀: 后缀\ntags: [a:b]\n---\n正文'],
  ['fm-hash-value', '---\nactive: #不是注释\ncategory: ok\n---\n正文']
]
const fmLines = []
for (const [name, input] of FRONTMATTER_CASES) {
  const { meta, body } = parseFrontmatter(input)
  fmLines.push(JSON.stringify({ name, input, meta, body }))
}
// 复用带 frontmatter 的边界用例，一起对拍
for (const [name, md] of cases) {
  if (!md.startsWith('---')) continue
  const { meta, body } = parseFrontmatter(md)
  fmLines.push(JSON.stringify({ name: `case/${name}`, input: md, meta, body }))
}
writeFileSync(FRONTMATTER, fmLines.join('\n') + '\n')

// ---------------------------------------------------------------------------
// 5) 生成 html2md.jsonl（name/input/html）——两端对拍 htmlToMd（Quill HTML → md）
// ---------------------------------------------------------------------------
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
})
const HTML2MD_CASES = [
  ['h2m-heading', '<h1>标题</h1><h2>二级</h2><h3>三级</h3>'],
  ['h2m-paragraph-emphasis', '<p>段落<strong>粗</strong>与<em>斜</em>与<code>代码</code></p>'],
  ['h2m-unordered-list', '<ul><li>一</li><li>二<ul><li>嵌套</li></ul></li></ul>'],
  ['h2m-ordered-list', '<ol><li>第一</li><li>第二</li></ol>'],
  ['h2m-code-block-js', '<pre><code class="language-js">const x = 1\nconsole.log(x)</code></pre>'],
  ['h2m-code-block-plain', '<pre><code>plain\ncode</code></pre>'],
  ['h2m-inline-code', '<p>用 <code>npm run dev</code> 启动</p>'],
  ['h2m-table', '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'],
  ['h2m-span-class-kaiti', '<p><span class="kaiti">楷体</span>正文</p>'],
  ['h2m-inline-style', '<p style="color:red;font-weight:bold">红色加粗</p>'],
  ['h2m-hard-break', '<p>第一行<br>第二行</p>'],
  ['h2m-two-paragraphs', '<p>a<br>b</p><p>c</p>'],
  ['h2m-empty', ''],
  ['h2m-cjk-punct', '<p>「引用」、破折号——省略号……（括号）</p>'],
  ['h2m-blockquote', '<blockquote><p>引用段落</p></blockquote>'],
  ['h2m-link', '<p>访问 <a href="https://example.com/x">链接文字</a></p>'],
  ['h2m-image', '<p><img src="https://cdn.example.com/x.png" alt="图"></p>'],
  ['h2m-hr', '<hr><p>分隔线后</p>'],
  ['h2m-entities', '<p>&amp; &lt; &gt; &quot; &#39;</p>'],
  ['h2m-quill-mixed', '<p>第一段<strong>重点</strong></p><ul><li>项一</li></ul><p><br></p><p>第二段</p>'],
  ['h2m-nested-inline', '<p><strong>粗<em>斜</em></strong>与 <span class="kaiti">楷</span></p>'],
  ['h2m-multiline-python', '<pre><code class="language-python">def f():\n    return 1</code></pre>']
]
const h2mLines = HTML2MD_CASES.map(([name, input]) =>
  JSON.stringify({ name, input, html: turndown.turndown(input) })
)
writeFileSync(HTML2MD, h2mLines.join('\n') + '\n')

const bytes = lines.reduce((n, l) => n + Buffer.byteLength(l), 0)
console.log(
  `corpus: ${lines.length} entries (repo ${repoFiles.length} + case ${cases.length}), ${bytes} B -> ${CORPUS}`
)
console.log(`frontmatter: ${fmLines.length} entries -> ${FRONTMATTER}`)
console.log(`html2md: ${h2mLines.length} entries -> ${HTML2MD}`)