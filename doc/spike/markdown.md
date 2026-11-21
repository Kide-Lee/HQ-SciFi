# SP-5：`mdToHtml` 迁 Rust 的可行性 spike（真实对拍报告）

> 状态：**已完成**，全部数字来自本仓真实运行（`spikes/md/` 下可复现）。
> 目标：后端主进程 `mdToHtml(markdown) → HTML`（发布文章/协议/摘要推送远端 API）迁到 Rust 后，输出必须与现有 markdown-it 实现**对等**；不接受临时例外。
> 结论（详见 §10）：**可对等**。86 个语料文件在「配置对齐 + 3 个自定义扩展」后达到 **L0（byte-identical）86 / 86，L1 0，L2 0**。

---

## 0. 一句话结论

`SP-5 结论：需 3 项自定义扩展后可对等（linkify-it 等价移植、项目特有 `$` 数学解析补丁、KaTeX 0.18.4 原样嵌入）—— 补齐后 86/86 文件 byte-identical，实测零 L1/L2。`

---

## 1. 现有实现（逐文件读源，事实清单）

### 1.1 主进程渲染入口

`src/main/infra/media/md2html.ts`（32 行；`src/main/md2html.ts` 只是 `export * from` 兼容 shim）：

```js
const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false })
const KAITI_RE = /^<\/?span class="kaiti">$/i
md.renderer.rules.html_inline = (tokens, idx) =>
  KAITI_RE.test(tokens[idx].content.trim()) ? tokens[idx].content : md.utils.escapeHtml(tokens[idx].content)
md.renderer.rules.html_block  = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content)
mathPlugin(md)
export function mdToHtml(markdown) { return md.render(markdown) }
```

配置清单（这是 Rust 侧必须逐项对齐的全部输入）：

| 项 | 值 | 含义 / Rust 对应 |
| --- | --- | --- |
| preset | 未指定 → `default` | 即 commonmark + 表格 + 删除线（`table`、`strikethrough` 默认开） |
| `html` | `true` | 允许 HTML token，但两条自定义 rule 把裸 HTML **全部转义**（见 1.2） |
| `linkify` | `true` | linkify-it 6.1.0，**`fuzzyLink: false`**、`fuzzyEmail: true`、`fuzzyIP: false` |
| `breaks` | `true` | 段落内软换行 → `<br>\n` |
| `typographer` | `false` | 不做引号/`--`/`...` 替换（comrak 默认也不做，`smart` 保持关） |
| 插件 | 仅 `mathPlugin`（项目自写，`src/shared/markdownItMath.ts`，93 行） | 见 1.3 |
| 标题 id | 无 | 不启用 markdown-it-anchor 之类 → 重复标题、无 `id` 属性 |
| 任务列表 / 脚注 / 上标 / 下划线 / 定义列表 | 均**不支持** | comrak 对应扩展必须保持关闭 |
| 图片 / 链接额外处理 | 主进程侧无 | 只有渲染层 `mdPreview.ts` 把 `https?://` 图片 src 改写成 `hqsf-img://`（见 1.4） |

### 1.2 HTML 转义策略（最容易抄错的地方）

- `html_block`：**整段** `escapeHtml` 后原样输出（无尾随换行）。例：`<div class="x">hi</div>` → `&lt;div class=&quot;x&quot;&gt;hi&lt;/div&gt;`。
- `html_inline`：默认 `escapeHtml`，唯一例外是 `KAITI_RE` 白名单命中（`.trim()` 后整 token 等于 `<span class="kaiti">` 或 `</span>`，大小写不敏感）。
- **已知怪癖（必须原样复现）**：楷体**开标签**原样输出，但闭标签 `</span>` **不匹配**该正则（正则要求带 `class="kaiti"`）→ 被转义。真值：`<span class="kaiti">楷</span>` → `<span class="kaiti">楷&lt;/span&gt;`。现有实现等于「楷体只开了标签、没有闭合标签」。
- 单引号写法 `<span class='kaiti'>` 不匹配 → 被转义；`<SPAN CLASS="KAITI">` 因 `/i` 匹配 → 原样。

### 1.3 数学插件（`src/shared/markdownItMath.ts`）逐行语义

- 行内规则：`md.inline.ruler.after('escape', 'math_inline', rule)`（**在 escape 之后、backticks/html_inline 之前**，故代码 span、`<...>` 优先）。
  - 当前字符 `$` 且**下一个字符不是 `$`** 才开；否则返回 false（该 `$` 当普通文本，解析继续）。
  - 闭合：从 `pos+1` 起第一个「`$` 且其后不是 `$`」；**不检查空格、数字、反斜杠**；找不到闭合 → 返回 false（整体当文本）。
  - 内容 = 原始源码切片（不做 normalize、不折叠空白）。
  - 渲染 `katex.renderToString(content, { throwOnError:false, displayMode:false })`，直接拼进输出（无包裹元素）。
- 块级规则：`md.block.ruler.after('blockquote', 'math_block', rule)`。
  - 首行 trim 后必须以 `$$` 开头；`content = firstLine.slice(2).trim()`。
  - 若 `content` 里还有 `$$` → **单行块**：内容取到第二个 `$$` 前并 trim，**行尾剩余文字被吞掉**（block token 吃整行）。
  - 否则逐行收集（每行 trim），遇某行 `endsWith('$$')` → 该行去掉末尾 `$$` 后 trim 入列，`content = parts.join('\n')`（**首尾空行会保留成 `\n`**）；收集不到闭合 → `return false`，**整块回退成普通段落文本**。
  - 渲染：`<div class="math-block">` + KaTeX HTML + `</div>\n`。
- `renderMath` catch 分支：`<span|div class="katex-error">escapeHtml(latex)</span|div>`。
- 真实副作用：正文里成对的 `$`（如「{d}」评语、`$100 与 $200`）会被当公式送进 KaTeX，stderr 刷 `LaTeX-incompatible input and strict mode is set to 'warn': Unicode text character "在" used in math mode [unicodeTextInMathMode]`（本语料实测 40 条）。**这不是 bug 而是当前线上行为，Rust 侧必须同样送入 KaTeX**（否则字节不同）。

### 1.4 渲染层 `src/renderer/src/lib/mdPreview.ts`

配置与主进程**完全一致**（同 4 个选项、同 2 条 html rule、同 `mathPlugin`），差异只有两点：

1. `if (!markdown) return ''`（空输入短路）；
2. 生成后把 `https?://` 图片 `src` 改写成 `cachedImageUrl(url)`（`hqsf-img://` 协议，走图片缓存）。

→ Rust 核心只负责「markdown → 与主进程一致的 HTML」；渲染层的 hqsf-img 改写属于 UI 层，迁 Tauri 时可留在前端或另起一层，**不在本次对等范围内**（但要在 L5 的接口设计里留出「图片 src 后处理钩子」，别写死在 core 里）。

### 1.5 由实现推导出的「对等 = 必须复刻的行为清单」

1. `<br>`（不带斜杠）、`<s>`（不是 `<del>`）、`<pre><code class="language-js">`（不是 `<pre lang="js">`）；
2. 表格 `style="text-align:left"`（不是 `align="left"`）；
3. 裸 HTML 全转义；楷体开标签例外、闭标签不例外；
4. 软换行 → `<br>\n`；列表项内文本紧接代码块时**不插换行**；
5. 无 BOM 处理（BOM 当正文输出）；
6. `$` / `$$` 按 1.3 的非标准规则解析 + KaTeX 0.18.4 的字节级输出；
7. linkify 按 linkify-it 6.1.0 的边界 + mdurl 的 percent-encode / IDN punycode / `mailto:` 文字剥前缀。

---

## 2. 语料（真实运行生成，非手挑）

### 2.1 规模

| 组成 | 文件数 | 字节 | 说明 |
| --- | --- | --- | --- |
| 仓库真实 md | 28 | 444 807 | 全仓 `git ls-files '*.md'` + gitignored 的 `doc/api-research.md`，含 `AGENTS.md`/`README.md`/`doc/**` 20 篇/`.dsh/skills/**` 3 篇 |
| 手写边界用例 | 58 | 11 487 | `spikes/md/cases.mjs` 定义，覆盖 1.5 全部行为与怪癖 |
| **合计** | **86** | **456 294** | 真实文档占 97.5%（按字节），避免「用玩具语料骗过对拍」 |

语料是 `node spikes/md/prepare-corpus.mjs` **运行时时点快照**（`spikes/md/corpus/repo/**` 是冻结副本）：之后仓库文档继续被别的 lane 修改，不影响已产出的 `oracle.jsonl` / `rust.jsonl` 与本文数字。要**逐字节复现本文数字**，直接用冻结的 `spikes/md/corpus/**` 从 §9 第 2 步开始跑（不要重跑第 1 步）；重跑第 1 步会拿到**当时**的仓库 md 集合（文件数可能不同，且本报告自身已从语料中排除，见 `prepare-corpus.mjs` 的「语料不能自指」）。

真实文档特性覆盖（`node spikes/md/feature-count.mjs` 实测，单位=文件数）：

| 特性 | repo | case | 特性 | repo | case |
| --- | --- | --- | --- | --- | --- |
| 围栏代码带语言 | 8 | 5 | 裸 URL | 9 | 10 |
| 围栏代码无语言 | 14 | 5 | `www.` 开头 | 6 | 2 |
| 删除线 `~~` | 0 | 3 | 角括号 autolink | 1 | 5 |
| 表格（任意） | 22 | 6 | 图片 | 2 | 2 |
| 表格带对齐 `:--` | 22 | 5 | 任务列表 `- [ ]` | 7 | 1 |
| 裸 HTML 标签 | 11 | 14 | 脚注 `[^x]` | 0 | 1 |
| 楷体 `class="kaiti"` | 1 | 4 | HTML 注释 | 0 | 1 |
| `$$` 块级公式 | 0 | 6 | YAML front matter | 3 | 2 |
| 行内 `$…$` | 4 | 7 | BOM / CRLF | 0 / 0 | 1 / 1 |

> 真实文档里「数学」几乎全是 `$` **误伤正文**（4 个文件），不是真公式；真公式只出现在手写用例里。这降低了数学 lane 的现实风险，但不改变「必须字节级复刻」的要求。

### 2.2 手写用例覆盖（58 条）

标题层级/无空格 `#Same`/无 id、强调·加粗·`***` 嵌套、下划线强调、删除线、表格（对齐/转义竖线/缺列/单元格内代码）、有序无序嵌套、松紧列表、任务列表、围栏语言·info 附加文字·波浪线·缩进代码、行内代码、引用嵌套+懒续行、水平线、链接（title/角括号/裸 URL/引用式/特殊字符）、图片（相对/远程/title）、裸 HTML 块与行内、楷体 4 种（含单引号、多 class、在围栏内）、脚注、数学 5+ 种（行内/单行块/多行块/混合/代码内/错误输入/转义）、CJK 标点紧邻 markdown 符号、`breaks` 软换行、超长段落、实体、转义、YAML front matter、CRLF、BOM、HTML 注释、列表内代码块/引用/表格、标题混合行内元素、深层混合嵌套、空文档、同段多楷体、linkify 边界 2 组、数学块/错误/转义、楷体边角、breaks CJK、围栏语言。

---

## 3. 比较方法（三级，实现见 `spikes/md/lib/html-diff.mjs`、`spikes/md/diff.mjs`）

### 3.1 TS 预言机（oracle）：跑**真实现**，不复制

`spikes/md/oracle.mjs` 每次运行先用仓库自带 esbuild 把**真实** `src/main/infra/media/md2html.ts`（含其 import 的 `markdownItMath.ts` / `kaiti.ts`）bundle 成 `spikes/md/out/md2html.bundle.mjs`：

```
node_modules/.bin/esbuild src/main/infra/media/md2html.ts --bundle --platform=node --format=esm --outfile=spikes/md/out/md2html.bundle.mjs
```

再 `import` 该 bundle 逐文件渲染 → `spikes/md/out/oracle.jsonl`（每行 `{"file","html"}`）。**任何对 `src/` 的改动都会自动进入 oracle**，不存在「抄一份实现然后自证」。

### 3.2 Rust 原型

独立 crate `spikes/md/rs/`（`Cargo.toml` 里保留空 `[workspace]`，否则被仓库根 workspace 收纳而报错），读同一个 `corpus/manifest.json` → `spikes/md/out/rust.jsonl`，与 oracle 同格式。

### 3.3 三级判定

| 级别 | 判定 | 实现 |
| --- | --- | --- |
| **L0** | 字节完全相同 | `oracle.html === rust.html` |
| **L1** | 归一化后相同 | tokenize 成 `{tag,text,comment}` 序列；实体解码（含数字/命名实体）、属性排序、自闭合统一、非 raw 文本（`pre/code/script/style/textarea` 之外）折叠空白并去两端空白、纯空白 token 丢弃；再整串比较。L1 存子类：`whitespace-only`（去掉所有空白后相同）/ `attr-or-entity` |
| **L2** | 结构级差异 | token 序列逐项比较，报告首个分歧位置 + 上下文；并按内置分类器归并 |

设计取舍：L1 把「空白差异」与「属性/实体写法差异」显式分开，是因为二者修复成本不同（前者多半是渲染器片段拼接处，后者多半是属性名/值格式）；L2 一旦命中就说明**语义不同**，必须修。

### 3.4 分类器

`diff.mjs` 内置 `CLASSIFIERS`（按序首个命中为 `primary`，全部命中进 `all`）：`math-katex-renderer`、`math-parse`、`table-align-attr`、`raw-html-escape`、`kaiti-span`、`self-closing`、`linkify`、`code-fence-meta`、`list-structure`、`other`。

---

## 4. 结果（真实数字）

### 4.1 终局

`node spikes/md/diff.mjs`（`out/diff.json`）：

```
total 86   L0 86   L1 0   L2 0
repo(28): L0 28 L1 0 L2 0
case(58): L0 58 L1 0 L2 0
```

即：**86/86 文件与现有 markdown-it 输出逐字节相同**，包括 28 篇真实文档（`doc/CHANGELOG.md` 67 KB、`doc/design/Tauri命令契约.md` 64 KB、`doc/design.md` 27 KB 等）与 58 条边界用例。

### 4.2 梯度实测（同一份代码，只换开关 —— 这是各差异类权重的直接证据）

| 配置 | L0 | L1 | L2 | 差异文件 |
| --- | --- | --- | --- | --- |
| **最终**（comrak 配置 + 3 扩展 + 后处理） | **86** | 0 | 0 | — |
| 不移植 linkify（用 comrak `autolink`） | 82 | 0 | 4 | `repo/doc/design.md`、`case/22-link-bare`、`51-linkify-boundaries`、`52-linkify-email` |
| KaTeX 用 `katex` crate 0.4.6（内嵌 0.16.4） | 77 | 0 | 9 | 含真实文档 `repo/doc/design/Tauri命令契约.md` |
| 不做 `$$` 块前置改写（用 comrak 原生块公式） | 81 | 2 | 3 | `case/32/33/34/54/55` 等 |
| comrak 原生行内 `$` 语义（不打补丁） | 84 | 0 | 2 | `case/31-math-inline`、`case/34-math-mixed` |
| 首轮原型（语料 77 文件时，仅配置对齐、未加后处理） | 53 | 0 | 24 | 围栏语言/删除线/表格/自闭合/BOM 等混杂 |

> 首轮那行语料是 77 个文件（后续扩到 86），只用于说明「配置对齐不够，必须做输出端对齐」，不与上面 86 文件的行直接相减。

### 4.3 专项实验一：KaTeX 必须与项目同版本（决定性）

| 方案 | 结果 |
| --- | --- |
| `katex` crate 0.4.6（内嵌 KaTeX **0.16.4**） | 与 oracle 结构性不同：class `base` → `katex-base`、`strut` → `katex-strut`、字宽 `margin-right:0.05764em` → `0.0576em`。9 个文件 L2，且其中一个**真实文档**（`Tauri命令契约.md`）。 |
| 自研 LaTeX 渲染 / katex-rs 0.3.0（纯 Rust） | 不追求字节级可行（KaTeX 输出含大量排版启发式与 class 结构）。 |
| **嵌入项目同一份 `katex.min.js`（0.18.4，272 179 B，MIT）在 JS 引擎里跑** | **字节一致**。spike 用 `quick-js` 0.4.1 验证通过（`spikes/md/rs/src/main.rs:183` `render_math_katex018`）；lead 另用 `rquickjs` 独立验证，同样逐字节一致。 |

结论：**数学渲染 = 调用嵌入的 KaTeX 0.18.4，不接受任何「等价实现」**；资产直接复用 `node_modules/katex/dist/katex.min.js`（生产放 `crates/hqsf-core/assets/katex.min.js`），依赖 `rquickjs`。版本必须与 `package.json` 的 `katex` 锁步（见 §7.6 风险 R2）。

### 4.4 专项实验二：linkify 的现成 crate 不可用，必须移植

`spikes/md/linkify-probe.txt`（26 行探针）+ `spikes/md/linkify-compare.mjs`（用真实 `markdown-it` 的 `md.linkify` 对拍）：

| 实现 | 26 行探针「href + 链接文字」完全一致 |
| --- | --- |
| `linkify` crate 0.10（Rust 生态最常用） | **4 / 26** |
| 自研移植（`spikes/md/rs/src/linkify.rs` + `mdurl.rs`，从真实 linkify-it/mdurl 导出正则与算法） | **26 / 26** |

`linkify` crate 的具体失配：把 CJK 标点（`。，、`、全角空格、全角括号）吞进 URL、`ahttps://x.com` 从 0 起算、漏检 `//protocol-relative`、`mailto:me@example.com` 只报 `me@example.com`、偏移用字节而 linkify-it 用 UTF-16。

与之对应，markdown-it 的裸 URL 有**两条**生成路径，必须同时复刻：

1. core rule：对 text token 跑 `md.linkify.match()`（要求文本内 ZPCc / `><｜` 边界）；
2. **inline rule**（`node_modules/markdown-it/dist/markdown-it.cjs.js:3144`）：当前字符是 `:` 且后跟 `//` 时，看 `state.pending` 末尾是否匹配 `SCHEME_RE = /(?:^|[^a-z0-9.+-])([a-z][a-z0-9.+-]*)$/i`，再 `md.linkify.matchAtStart(...)`。
   → 所以 `中文https://cn.com。结束` **会**被链接（CJK 不算 ASCII 边界），`ahttps://x.com` **不**会。
   → 只复刻 core 规则会漏掉一整类真实内容（`repo/doc/design.md` 里就有一处），这是 §4.2 里「不移植 linkify 就 4 个 L2」的主因。

---

## 5. 差异清单（施工单）

每条格式：**现象 / 计数 / 举例 / 成因 / 修法（Rust 落在哪）/ 状态**。所有条目均已在 spike 中实现并验证（86/86 L0）。

### C1 围栏代码语言标注位置（配置项）

- 现象：comrak 默认 `github_pre_lang=true` → `<pre lang="js"><code>…</code></pre>`；markdown-it 是 `<pre><code class="language-js">…</code></pre>`。
- 计数：带语言围栏 13 个文件（repo 8 / case 5），oracle 里 48 处 `class="language-*"`。
- 修法：`Options.render.github_pre_lang = false`。
- 状态：✅ 已验证（`spikes/md/rs/src/main.rs:72`）。

### C2 删除线标签名（后处理）

- 现象：comrak `~~x~~` → `<del>x</del>`；markdown-it → `<s>x</s>`。
- 计数：3 处 / 3 个 case 文件（真实文档无删除线）。
- 修法：输出后处理 `"<del>" → "<s>"`、`"</del>" → "</s>"`（`main.rs:336`）。**不要**用 comrak 的 `strikethrough` 关闭来绕（会变成普通文本）。
- 状态：✅ 已验证。

### C3 表格对齐属性写法（后处理）

- 现象：comrak `<th align="left">`；markdown-it `<th style="text-align:left">`。
- 计数：对齐表格 27 个文件（repo 22 / case 5），oracle 里 35 处 `style="text-align:"`。
- 修法：输出后处理把 ` align="{left,center,right}"` 换成 ` style="text-align:x"`（`main.rs:339-342`）。属性值固定三种，字符串替换足够安全（不会误伤正文里的 ` align="left"`？——会的极端情况极少，生产实现建议在渲染阶段处理而非全局替换，见 §7.2 说明）。
- 状态：✅ 已验证。

### C4 自闭合标签写法（后处理 / 影响面最大）

- 现象：comrak 输出 `<br />`、`<hr />`、`<img … />`；markdown-it 输出 `<br>`、`<hr>`、`<img …>`。
- 计数：oracle 中 `<br>` **74 处 / 28 个文件**（`breaks:true` 下几乎每个多行段落都有），另有 `<hr>`、`<img>`。
- 修法：仅对 `br hr img input wbr source area col embed` 去掉标签头部的 ` /`，实现须先确认「该标签头里没有 `>`」以免误伤属性值（`main.rs:344-369`）。更稳的做法：在 comrak 的渲染层改（comrak 的 html 输出统一在 `format_html`，可 fork 一个 `write!` 分支或做 AST→自写渲染），spike 用后处理已够。
- 状态：✅ 已验证。

### C5 文档开头 BOM（预处理 + 后处理）

- 现象：comrak 解析时会吞掉行首 `\u{FEFF}`（还会把它当标题/结构提示）；markdown-it 把它当正文输出。
- 计数：1 个 case（`case/43-bom`）。
- 修法：解析前把行首 BOM 替换成私用区占位 `\u{FEFE}`，输出后还原为 `\u{FEFF}`（`main.rs:95-99`、`:334`）。
- 状态：✅ 已验证。

### C6 列表项内「文本紧接块级代码块」的换行（后处理）

- 现象：markdown-it `<li>文字<pre>…`；comrak `<li>文字\n<pre>…`（差 1~4 字节）。
- 计数：3 个真实文档（`.dsh/skills/cdp-debugging/SKILL.md`、`doc/api-research.md`、`doc/design/Tauri迁移计划.md`），首轮表现为 L1 `whitespace-only`。
- 修法：`strip_newline_before_pre()`：仅当 `<pre` 前一个字符是**非 `>`** 时删掉该 `\n`（`main.rs:375`）。不能用「删除所有 `<pre` 前换行」，会破坏 `<li>\n<pre>` 的正确形态。
- 状态：✅ 已验证（此类清零后 L1 从 3 → 0）。

### C7 块级 `$$` 公式语义（项目自定义 block rule，comrak 无对应 API）

- 现象（4 条独立行为，全部来自 `markdownItMath.ts` 的非标准实现）：
  1. 单行 `$$E=mc^2$$` 在项目里是**块公式**，且「行尾后续文字被吞掉」；comrak 把它当**行内 display math**；
  2. 多行块的内容是逐行 `trim()` 后 `join('\n')`，**首尾空行会保留成 `\n`**；comrak 的 `MathBlock.literal` 会多带一个行尾 `\n`；
  3. 找不到闭合 `$$` 时项目**回退成普通段落文本**；comrak 会一路吃到 EOF；
  4. 块公式输出固定 `<div class="math-block">…</div>\n`。
- 计数：`$$` 块 6 个 case 文件 / oracle 8 处 `math-block`（真实文档 0 处）。
- 成因：comrak 的插件体系（`Plugins.render`）只有 `codefence_renderers` + `heading_adapter` + 语法高亮，**没有任意节点渲染钩子，也没有自定义 block rule API**。
- 修法（spike 采用，已通过）：`preprocess_project_math()` 在交给 comrak 前**改写源码**：
  - 单行 `$$x$$` 规范化为三行块，并给内容加哨兵 `\u{e003}`（渲染时 `split_once('\u{e003}')` 取前半，抵掉 comrak 多出的行尾 `\n`）；
  - 未闭合 `$$` 中和成 `\u{e004}` 且**保留该行剩余文字**（早期丢字导致 `case/35-math-in-code` 回归），输出后 `html.replace('\u{e004}', "$$")` 还原；
  - 多行块内容不做 trim（与 TS 的 `parts.join('\n')` 对齐）。
- 状态：✅ 已验证（`main.rs:218`）。
- 生产建议：这套「源码改写 + 哨兵」可以直接搬，但**必须配 4 条回归测试**（单行块吞尾文字、多行块首尾空行、未闭合回退、代码块内 `$$` 不动）。

### C8 行内 `$` 公式语义（必须 fork comrak 的 `handle_dollars`）

- 现象：
  1. 项目规则**无空格/数字限制**：`金额 $100 与 $200 不是公式` → 公式内容是 `100 与 `（闭合 `$` 只要求后一个字符不是 `$`）；comrak 的 pandoc 启发式要求「闭合 `$` 前不是空格、`$` 后不是数字、开 `$` 后不是空格」→ 不解算（`case/31-math-inline`）；
  2. 项目规则对 `$$` **不做行内 display math**：`> 引用里的 $$y$$` 里第一个 `$` 返回 false（下一个是 `$`），第二个 `$` 开启、闭合落在第 4 个 `$` → 内容 `y$` → KaTeX 报 `Can't use function '$' in math mode at position 2`；comrak 把它当 inline display math（literal `y`）（`case/34-math-mixed`）；
  3. 项目内容不做 `normalize_code`（不折叠空白/不 trim）；comrak 对单 `$` 会 `normalize_code`。
- 计数：2 个 case 文件（这是语料里最后两个 L2）；真实文档 0 处真公式，但 4 个真实文档存在 `$` 误伤，字节必须照样复刻。
- 修法（spike 采用，已通过）：vendor 一份 comrak 1.1.0 到 `spikes/md/rs/vendor/comrak/`，改 `src/parser/inlines.rs` 的 `handle_dollars`（原 1347 行起）+ 新增 `scan_to_closing_dollar_ts`：
  - 单 `$` 时**删掉** pandoc 三条启发式（空格/数字/反斜杠跳过）；
  - 内容用原始切片（不 `normalize_code`）；
  - `$$` 出现在行内时只输出一个 `$` 字面量并前进 1 字节，让后续解析按项目规则继续。
  改动 **约 60 行**（`inlines.rs:1348-1405` 区域，标记 `[spike patch]`）。
- 状态：✅ 已验证（补丁前 84/0/2 → 补丁后 86/0/0）。
- 生产建议：不要长期 vendor 3 MB 源码。二选一：(a) 向上游提 PR（这属于「可配置的数学解析策略」，接受度看维护者）；(b) 在 workspace 里登记 fork 分支（git dependency / `[patch.crates-io]`），改动仅这一个函数 + 4 条单测。

### C9 KaTeX 版本与嵌入方式（资产 + 运行时）

- 现象：kaTeX 不同版本输出结构不同（见 §4.3），无法用「等价实现」匹配。
- 计数：oracle 中 `class="katex"` 27 处 / 9 个文件；`katex-error` 1 处（`case/54-math-errors`）。
- 修法：`rquickjs` 加载 `assets/katex.min.js`（0.18.4，与仓库 `node_modules` 同源），调用 `katex.renderToString(latex, { throwOnError:false, displayMode })`；`thread_local` 复用 Context（spike 用 `quick-js` 0.4.1 验证，生产用 lead 已确认的 `rquickjs`）。KaTeX 的 `console.warn`（`unicodeTextInMathMode`）应收集/静默，别打到 stderr。
- 状态：✅ 已验证（spike `render_math_katex018`，`main.rs:183`）。

### C10 linkify 边界与链接归一化（最大的一块自研代码）

- 现象（对照实测，markdown-it 15 + linkify-it 6.1.0 真值）：
  1. `fuzzyLink:false` → `www.example.com`、`www.google.com/path`、`example.com/foo` **不链接**；comrak `autolink` 全都会链接；
  2. CJK 标点（`。，、`、全角空格、全角括号）是 URL 终止符；comrak 会吞进 URL 并 percent-encode（真实文档 `doc/design.md` 那一处就是 href 多吞了 `，如果`）；
  3. 但 CJK **字母**会被吞进 URL（linkify-it 只按 Unicode Z/P/Cc 切分）：`…/README.md探索定制` 整串进 href/text；
  4. `//protocol-relative.example.com/x` 会链接；comrak 不认；
  5. `mailto:me@example.com` → `href="mailto:me@example.com"`、**文字不带 `mailto:`**；`foo@中文.com` → `href="mailto:foo@xn--fiq228c.com"`（IDN punycode）、文字原样；
  6. href 用 `mdurl.encode`（`defaultChars=";/?:@&=+$,-_.!~*'()#"`，`%XX` 保留并大写），**文字**用 `normalizeLinkText`（punycode→unicode + `mdurl.decode`，`defaultChars=';/?:@&=+$,#'`，非 ASCII 3/4 字节序列该实现会退化成 U+FFFD）；
  7. 行内规则宽松边界（见 §4.4）：`中文https://…` 链接、`ahttps://…` 不链接。
- 计数：不移植时 4 个文件 L2（含 1 个真实文档）；语料里 URL 相关 19 个文件、oracle 中 81 处 `<a href=`、10 处 href 带 `%`、9 处 `mailto:`。
- 修法（spike 已做完，26/26 探针一致）：
  1. `spikes/md/gen-linkify-regex.mjs` 从**真实 linkify-it 的 REBuilder** 导出 30 条正则源（+ 1 条无边界前缀的 `schema_plain` 供 inline 规则）到 `spikes/md/rs/src/linkify-regex.json`；uc.micro 的 astral 代理对字符类替换成 `\p{Cc}`/`\p{Z}`/`\p{P}`/`[\s\S]`（Rust 正则不支持代理对字面量）；
  2. `spikes/md/rs/src/linkify.rs`（289 行）：JS→Rust 正则转换 + `fancy-regex` 编译 + 复刻 `match()` 循环（schema 与 fuzzy-email 候选取最早、同起点取更长、email 优先、sticky 校验 `m.start()==0`）+ inline 宽松边界的二次候选；
  3. `spikes/md/rs/src/mdurl.rs`（322 行）：`parse/format/encode/decode` + punycode（`idna` 1.1.0）；
  4. `main.rs` 的 `linkify_pass()`：在 `format_html` 前遍历 `NodeValue::Text`（跳过 Link/Image/Code/CodeBlock 祖先），按匹配切成 `Text` / `Link` 兄弟节点。**不要**改 comrak 的 inline 解析——markdown-it 也是在 text token 上做 core linkify，两条路径语义一致。
- 坑：JS 按 UTF-16 索引，Rust 按字节 → 两处切片必须回退到字符边界（`//` 前缀检查用字节比较；email 名字窗口 `start-65` 回退），否则 `start byte index 24 is not a char boundary; it is inside '批'` panic。
- 状态：✅ 已验证（`--linkify=port`；同期 comrak autolink 关闭）。

### C11 楷体白名单（AST 后处理）

- 现象：仅 `<span class="kaiti">`（大小写不敏感、`.trim()` 后整 token 相等）不转义；`</span>` 反而转义（见 §1.2 怪癖）。
- 计数：oracle 中 `<span class="kaiti">` 9 处 / 3 个文件。
- 修法：遍历 `NodeValue::HtmlInline`，命中白名单则替换成 `NodeValue::Raw(lit)`（原样输出），其余交给 `render.escape=true` 转义；判断函数 `is_kaiti_tag()`（`main.rs:76`，**必须显式返回 false for `</span>`**）。
- 状态：✅ 已验证。

### C12 裸 HTML 转义（配置）

- 现象：`html_inline`/`html_block` 全转义（楷体除外）；`<div class="x">hi</div>` 连引号一起 `&quot;`。
- 计数：oracle 中 `&lt;tag` 共 382 处 / 20 个文件（真实文档里大量协议模板示例）。
- 修法：`Options.render.escape = true`（comrak 的 escape 语义正好是「转义而非输出/丢弃」），且**不要**开 `render.unsafe_`；`html_block` 的「无尾随换行」由 comrak 默认行为匹配（实测一致）。
- 状态：✅ 已验证。

### C13 任务列表 / 脚注 / 其他扩展必须保持关闭（配置）

- 现象：markdown-it 无任务列表、无脚注、无上下标、无标题 id、无 front matter 特殊处理。
- 计数：任务列表 7 个真实文档、脚注 1 个 case、front matter 3 个真实文档（`---` 被当 hr + 段落）。
- 修法：comrak `extension.tasklist = false`、`footnotes = false`、`superscript/subscript/spoiler/underline = false`、`header_ids = None`、`front_matter_delimiter = None`（默认即如此，**明确写进配置注释防止后人手滑**）。
- 状态：✅ 已验证（默认值即可）。

### C14 软换行（配置）

- 现象：`breaks:true` → `<br>\n`；comrak `hardbreaks` 语义一致（但输出 `<br />`，见 C4）。
- 计数：oracle `<br>` 74 处 / 28 个文件。
- 修法：`Options.render.hardbreaks = true` + C4。
- 状态：✅ 已验证。

### C15 语料未覆盖但需注意的边界（预防性条目）

- 多字节安全：C10 的 UTF-16/字节索引问题、C6 的按字节遍历（`utf8_len`）——生产实现建议统一用 `char_indices()`。
- 属性值里出现 ` align="left"` / `<br` 字样的正文：spike 的全局字符串替换理论上可能误伤（当前语料未命中）。生产实现应在**渲染阶段**处理（自写 `format_html` 或 comrak 渲染钩子），而不是对最终 HTML 做全局替换。
- `mdPreview.ts` 的 `hqsf-img://` 改写不在 core 内（见 §1.4）。

---

## 6. 能否达到「归一化后零差异」

- **归一化零差异**：是，且已经**超出**该目标 —— 实测 **L0 字节级零差异 86/86**，L1、L2 均为 0。
- 达到零差异的代价（3 项扩展 + 1 个输出对齐层）：
  1. **linkify**：必须自研移植 linkify-it（现成 `linkify` crate 4/26 探针一致，不可用）；
  2. **数学解析**：必须 fork comrak `handle_dollars`（约 60 行）+ 自己的 `$$` 块前置改写（约 60 行）；
  3. **数学渲染**：必须嵌入 KaTeX 0.18.4（不能用任何 crate 内置版本）；
  4. 输出对齐层：6 条小后处理（C2/C3/C4/C5/C6 + C1 配置），约 120 行。
- 不满足以上任何一项时，实测差异见 §4.2 梯度表（4~24 个文件不等，且**包含真实文档**——`doc/design.md`（linkify）与 `doc/design/Tauri命令契约.md`（KaTeX 版本）都曾真实命中）。

---

## 7. 对 L5 的落地建议（把 spike 提进 `crates/hqsf-core/src/infra/markdown/`）

### 7.1 建议模块布局

```
crates/hqsf-core/src/infra/markdown/
├── mod.rs            // pub fn md_to_html(md: &str) -> String  ← 唯一入口，签名对齐 TS
├── options.rs        // comrak Options 构造（C1/C13/C14 + 注释说明每项对应哪条 TS 行为）
├── math.rs           // preprocess_project_math（C7）+ render_math（C9，rquickjs 封装）
├── math_patch/       // 或 fork 的 comrak（C8）
├── linkify.rs        // linkify-it 等价实现（C10，289 行）
├── mdurl.rs          // mdurl 等价实现（C10，322 行）
├── linkify_regex.json// 由 gen-linkify-regex.mjs 生成（32 KB，提交入库）
├── kaiti.rs          // is_kaiti_tag + HtmlInline→Raw 的 AST pass（C11）
├── postprocess.rs    // C2~C6 六条输出对齐（生产建议改为渲染期处理）
└── assets/katex.min.js   // 与 package.json 的 katex 版本锁步
```

### 7.2 哪些可以直接搬，哪些只是 spike 脚手架

| 文件 | 行数 | 可搬？ | 说明 |
| --- | --- | --- | --- |
| `spikes/md/rs/src/linkify.rs` | 289 | ✅ 直接搬 | 纯逻辑（正则 + match 循环），改一下 crate 内路径即可；建议把 `println!` 探针去掉 |
| `spikes/md/rs/src/mdurl.rs` | 322 | ✅ 直接搬 | parse/format/encode/decode + punycode，纯函数 |
| `spikes/md/rs/src/linkify-regex.json` | 32 KB | ✅ 直接搬 | 生成物；配 `gen-linkify-regex.mjs`（43 行）作为「升级 linkify-it 时重生成」的工具，可放 `scripts/` 或 spike 目录 |
| `spikes/md/rs/vendor/comrak/src/parser/inlines.rs` 的 `[spike patch]` 段 | ~60 | ✅ 搬补丁，不搬 vendor | 以 fork/PR 形式给 comrak；不建议长期 vendor 3 MB 源码 |
| `spikes/md/rs/src/main.rs` 的 `is_kaiti_tag` / `preprocess_project_math` / `render_math*` / `postprocess` / `linkify_pass` / `strip_newline_before_pre` / `options` | ~300（分散） | ✅ 主体可搬 | 但**要重写外壳**：manifest/CLI/`fs::write` 这些是 spike 脚手架，删掉；`render()` 里的 AST 遍历顺序与 `format_html` 调用要保留 |
| `spikes/md/lib/html-diff.mjs`、`diff.mjs`、`oracle.mjs`、`prepare-corpus.mjs`、`cases.mjs`、`feature-count.mjs`、`linkify-compare.mjs` | ~1000（JS） | ⚠ 不当产品代码，但当**回归测试资产** | 建议把 `diff.mjs` + `lib/html-diff.mjs` 移进 `scripts/` 作为 CI 对拍工具（Node 侧跑 oracle，Rust 侧出 JSONL，逐字节比较），`cases.mjs` 作为固定语料 |
| `spikes/md/rs/src/bin/linkprobe.rs`、`linkport.rs` | 55 | ⚠ 只作单测夹具 | 26 行探针 + 期望值可以固化成 Rust 单测 |

### 7.3 依赖与资产

| 依赖 | 用途 | 备注 |
| --- | --- | --- |
| `comrak`（fork 或 `[patch.crates-io]`） | md 解析 + HTML 渲染 | 仅 C8 一处补丁；关掉所有多余扩展 |
| `rquickjs` | 跑 `katex.min.js` | lead 已验证；注意 `thread_local` 复用 + 首次加载开销 |
| `fancy-regex` | linkify 正则（含 lookahead/后行断言） | 见 §7.5 性能注意 |
| `idna` | email/URL 的 IDN punycode | |
| 资产 `assets/katex.min.js` | 0.18.4，272 KB，MIT | 与 `node_modules/katex` 同源，版本锁步；许可证随资产保留 |
| 资产 `linkify_regex.json` | 32 KB 生成物 | 来源 linkify-it 6.1.0（MIT） |

### 7.4 测试与回归（这是对等门禁的抓手）

1. **golden 对拍（必须进 CI）**：Node 侧对 `src/main/infra/media/md2html.ts` 跑 oracle，Rust 侧跑 `md_to_html`，逐字节比较；语料 = `spikes/md/corpus/**`（建议冻结进 `tests/fixtures/markdown/`，而不是每次重扫仓库）。
2. **差异分级脚本**：保留 `diff.mjs` 的 L0/L1/L2 输出；CI 只允许 L0 全绿（L1 已证明清零，不应放宽）。
3. **单测**：C7 的 4 条块公式行为、C10 的 26 行 linkify 探针、C8 的 `$$` 行内字面量、C11 的楷体闭标签转义、C4 的 `<br />` 归一。
4. **版本升级守则**：`katex` 升级 → 同步替换 `assets/katex.min.js` 并重跑对拍；`linkify-it` 升级 → 重跑 `gen-linkify-regex.mjs` 并重跑探针；`comrak` 升级 → 重放 C8 补丁（给补丁写清上游文件行号锚点）。

### 7.5 性能与资源（实测，仅作量级参考）

| 实现 | 耗时（86 文件 / 456 KB，单线程） |
| --- | --- |
| Rust release（含 QuickJS + KaTeX 0.18.4） | 124–130 ms |
| Rust release（数学走占位、不启 JS） | 102–108 ms |
| Node oracle（含 esbuild bundle 的构建开销） | 153–159 ms |
| Node 真实现 render-only（bundle 已构建，含模块加载） | 93 ms |

结论：**性能不是阻塞项**（同一量级）；KaTeX/QuickJS 的固定开销约 20 ms（首次加载 + 27 个公式），生产建议：

- 复用 JS Context（`thread_local`），不要每次渲染新建；
- `linkify_regex.json` 的正则在启动时编译一次并缓存（`fancy-regex` 编译成本明显高于匹配）；
- 若并发渲染，`rquickjs::Context` 不是 `Sync` → 按线程持有；或把数学渲染串行化到专用 worker。

### 7.6 风险清单

| ID | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | comrak 升级导致 C8 补丁失配 | 数学行内解析回退到 pandoc 语义 → 2+ 类差异 | fork 分支 + 补丁旁写上游锚点 + CI 对拍兜底 |
| R2 | `katex` 版本漂移（`package.json` vs `assets/katex.min.js`） | KaTeX 输出字节不同 | 构建期校验：读 `node_modules/katex/package.json` 版本与资产旁 `KATEX-VERSION` 比对，不一致直接 fail |
| R3 | `linkify-it` 升级（边界规则变化） | URL 链接边界差异 | 生成器重跑 + 26 行探针 + golden 对拍 |
| R4 | 嵌入 JS 引擎带来的攻击面/崩溃风险 | 恶意文档导致 panic/内存 | KaTeX 调用包 `catch_unwind` 边界、限制输入长度、`throwOnError:false` 保留；QuickJS 内存上限可配 |
| R5 | 输出端「全局字符串替换」式后处理误伤正文 | 极端文档字节不一致 | 生产改为渲染期处理（自写 `format_html` / AST 钩子），或至少补 3 类对抗用例（属性值里含 ` align="left"`、正文含 `<br` 字样、代码块内含 `<del>`） |
| R6 | `mdPreview.ts` 的 hqsf-img 改写若一并下沉到 Rust | 渲染层行为耦合进 core | 保持 core 纯函数；图片 src 后处理留在前端或独立钩子 |
| R7 | 语料快照性 | 报告数字与「今天重跑」可能不同（仓库文档仍在被改） | 报告已注明；CI 用冻结 fixtures 而非实时扫仓库 |

---

## 8. 工作量与代码量估算（按差异类别拆）

单位：人日（1 人日 ≈ 6 小时有效编码，含自测）。「代码量」为实测行数（spike 已验证可用）。

| 类别 | 代码量（实测） | 估算 | 说明 |
| --- | --- | --- | --- |
| C1/C13/C14 配置对齐 | ~30 行 | 0.2 | 纯 `Options` 设置 + 注释 |
| C2/C3/C4/C5/C6 输出对齐 | ~120 行 | 0.5 | 若改为渲染期处理，估 1 人日（需自写/改 `format_html`） |
| C7 `$$` 块前置改写 | ~60 行 | 0.5 | 含 4 条回归测试 |
| C8 comrak `handle_dollars` 补丁 | ~60 行（fork） | 1.0 | 含 fork 流程/锚点/单测；若上游接受 PR 则 0.5 |
| C9 KaTeX 嵌入（rquickjs） | ~80 行 | 0.5 | 含资产同步校验；lead 已验证可行 |
| C10 linkify 移植 | **611 行**（289 + 322）+ 32 KB 生成物 + 43 行生成器 | 2.0 | 含 26 行探针单测；这是最大单项 |
| C11 楷体白名单 | ~30 行 | 0.1 | |
| C12 转义配置 | 1 行 + 注释 | 0.1 | |
| 模块外壳/入口/错误处理 | ~150 行 | 0.5 | `md_to_html` + `MathRenderer` 初始化 + 线程安全 |
| **golden 对拍测试（Node oracle + Rust JSONL + CI）** | ~250 行 JS/Rust | 1.0 | 对等门禁必须有 |
| **合计** | **≈ 1 150–1 300 行 Rust** + ~350 行测试/工具 | **≈ 6.5 人日** | 不含 `mdPreview`（渲染层）与 Tauri 接口改造 |

备选架构（若不愿维护 611 行 linkify/mdurl 移植）：在 Rust 里用 `rquickjs` 直接跑 **markdown-it + linkify-it + katex**（复用现有 bundle），数学已经必须嵌 JS 引擎，边际成本低。代价：单次渲染跨 JS 边界、性能与内存更差、依赖面更大（把「核心文本处理」交给 JS 运行时与上游版本漂移）。估算 2–3 人日 + 长期运行成本，**不推荐**作为默认方案，但可作为 R1/R3 频繁出问题时的逃生门。

---

## 9. 复现命令（全部真实可跑）

```bash
# 0) 前置：沙箱内 ~ 只读，CARGO_HOME 必须指到工作区
export CARGO_HOME=/home/kidelee/Projects/HQ-SciFi/spikes/md/.cargo

# 1) 语料（每次重跑会拿到当时的仓库 md 快照 + cases.mjs 的 58 条用例）
node spikes/md/prepare-corpus.mjs

# 2) oracle：esbuild 打包真实 md2html.ts 后逐文件渲染 → out/oracle.jsonl
node spikes/md/oracle.mjs

# 3) Rust 原型 → out/rust.jsonl（需要 --features katex018；首次会编译 quickjs）
cd spikes/md/rs
cargo run -q --features katex018 -- --math=project --katex018 --linkify=port
cd -

# 4) 三级对拍 → out/diff.json（期望 total 86 / L0 86 / L1 0 / L2 0）
node spikes/md/diff.mjs
node spikes/md/diff.mjs --debug            # L1 归一化后仍不同的位置
node spikes/md/diff.mjs --only=case/51     # 只跑某个文件

# 5) 各差异类的专项证据
node spikes/md/feature-count.mjs                          # 语料特性覆盖
node spikes/md/gen-linkify-regex.mjs                      # 从真实 linkify-it 重生成正则表
cd spikes/md/rs && cargo run -q --bin linkport && cd -     # 移植版 linkify 探针
node spikes/md/linkify-compare.mjs port                    # 26/26 一致
node spikes/md/linkify-compare.mjs crate                   # linkify crate 0.10：4/26

# 6) 梯度对照（§4.2 的数字来源）
cd spikes/md/rs
cargo run -q --features katex018 -- --math=project --katex018 --linkify=comrak --out=out/rust-comrak.jsonl
cargo run -q --features katex018 -- --math=project --katex --linkify=port     --out=out/rust-katex016.jsonl
cargo run -q --features katex018 -- --math=default --katex018 --linkify=port  --out=out/rust-mathdefault.jsonl
# 用 diff.mjs 依次比较：cp out/rust-<variant>.jsonl out/rust.jsonl && node ../diff.mjs
```

产物清单：`spikes/md/out/{oracle,rust,rust-final,rust-comrak,rust-katex016,rust-mathdefault}.jsonl`、`out/diff.json`、`out/linkify-compare*.json`。

---

## 10. 结论

- 现有实现的行为已全部摸清（§1），语料 86 文件（28 篇真实文档 + 58 条手写边界，456 KB，真实文档占 97.5% 字节）。
- 对拍方法三级（L0 字节 / L1 归一化 / L2 结构），oracle 由 esbuild 直接跑 `src/` 真实现，Rust 侧独立 crate，全部可复现。
- **最终实测：L0 86 / L1 0 / L2 0**（真实文档 28/28 字节级一致）。
- 达到该结果需要的三项自定义扩展：**linkify-it 等价移植（611 行）**、**comrak `handle_dollars` 补丁（约 60 行，复刻项目非标准 `$` 语义）**、**KaTeX 0.18.4 原样嵌入（rquickjs，资产 272 KB）**；其余为配置对齐与 6 条输出对齐小改。
- 工作量估算 ≈ **6.5 人日**（≈ 1 150–1 300 行 Rust + 对拍测试），性能与 Node 同量级。

`SP-5 结论：需 3 项自定义扩展后可对等（linkify-it 等价移植、项目特有 $ 数学解析补丁、KaTeX 0.18.4 原样嵌入）—— 补齐后 86/86 文件 byte-identical，实测零 L1/L2。`