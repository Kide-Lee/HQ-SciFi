//! Markdown → HTML：对内逐字节对等 1.x 的 `markdown-it` 渲染结果。
//!
//! 为什么必须逐字节对等：这段 HTML 会经 `contentsAdd` / `contentsUpdate` 写进服务端
//! （`src/main/services/sync-service.ts:488`、`:563`），就是发布出去的内容本身；
//! 差一个空格或换行都会让服务端存下两份不同快照，用户看到"已修改但内容没变"。
//!
//! 1.x 的实现（`src/main/infra/media/md2html.ts` + `src/shared/markdownItMath.ts`）是：
//!
//! ```js
//! const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });
//! md.renderer.rules.html_inline = kaiti 白名单 / escapeHtml;
//! md.renderer.rules.html_block  = escapeHtml;
//! md.use(mathPlugin);   // $…$ 与 $$…$$ → katex.renderToString
//! ```
//!
//! 也就是 markdown-it preset "default"：table、strikethrough 开；anchor、tasklist、
//! footnote、上下标、定义列表全关；软换行变 `<br>`；裸 HTML 转义；linkify 用
//! linkify-it 6.1.0 的边界规则。
//!
//! 管线（见 `doc/spike/markdown.md` 的施工单）：
//! 1. BOM 占位（1.x 无 BOM 处理，BOM 当正文；占位只为绕开 comrak 的 frontmatter 识别）；
//! 2. 块级 `$$…$$` → 行级占位符（`blockmath`）；
//! 3. 行内 `$…$` → 内容占位符（`inline_math`）；
//! 4. 用 comrak 解析（选项对齐 markdown-it preset，关闭 math/autolink/unsafe）；
//! 5. AST 手术：占位符 → KaTeX 的 `NodeValue::Raw`；楷体开标签放行；
//! 6. linkify（在 `Text` 节点上跑 linkify-it 6.1.0 的移植版）；
//! 7. 渲染 + 后处理，抹平 comrak 与 markdown-it 的输出差异（`<s>`、表格 style、
//!    自闭合标签、`<pre>` 前换行）。

mod blockmath;
pub mod frontmatter;
mod inline_code;
mod inline_math;
mod js;
mod linkify;
pub mod math;
mod mdurl;

use comrak::nodes::{AstNode, NodeLink, NodeValue};
use comrak::{Arena, Options, format_html, parse_document};

use blockmath::{BLOCK_CLOSE, BLOCK_OPEN};
use inline_math::{INLINE_CLOSE, INLINE_OPEN};

/// 与 1.x `new MarkdownIt({html:true, linkify:true, breaks:true, typographer:false})` 对齐。
fn options() -> Options<'static> {
    let mut options = Options::default();
    // markdown-it preset "default" 只开 table + strikethrough（GFM 表格与删除线）。
    options.extension.table = true;
    options.extension.strikethrough = true;
    // linkify 由我们自己移植 linkify-it（`linkify` 模块），关掉 comrak 的 GFM autolink 扩展；
    // 但保留 CommonMark 的 `<https://x>` 尖括号 autolink（那是标准语法，markdown-it 也认）。
    options.extension.autolink = false;
    // markdown-it 不认 comrak 的 math / tasklist / footnote / 上下标 等扩展。
    options.extension.math_dollars = false;
    options.extension.math_code = false;
    options.extension.tasklist = false;
    options.extension.footnotes = false;
    options.extension.superscript = false;
    options.extension.subscript = false;
    options.extension.spoiler = false;
    options.extension.underline = false;
    options.extension.description_lists = false;
    // 裸 HTML 一律转义（1.x 的 html_block / html_inline 规则就是 escapeHtml，楷体开标签除外）。
    options.render.escape = true;
    options.render.r#unsafe = false;
    // breaks: true —— 软换行渲染成 `<br>`。
    options.render.hardbreaks = true;
    // markdown-it 的代码围栏输出 `<code class="language-js">`，不是 pre 上的 lang 属性。
    options.render.github_pre_lang = false;
    options
}

/// Markdown → HTML（与 1.x 的 markdown-it 输出逐字节一致）。
///
/// 这是发布内容本身，调用方（`contentsAdd` / `contentsUpdate` 等）依赖字节稳定性，
/// 不要"顺手"加空行或换行。
pub fn md_to_html(markdown: &str) -> String {
    // 1.x 没有 BOM 处理：BOM 是正文的一部分（渲染成一个零宽字符）。
    // comrak 会把文首 `---\n` 识别成 frontmatter，占位成 U+FEFF 即可避免，输出时还原。
    let src = markdown.replace('\u{FEFF}', "\u{FEFE}");
    let options = options();
    let block_prep = blockmath::preprocess(&src);
    // comrak 遇到未配对的反引号串后不再配对后续行内代码，与 markdown-it 不同；
    // 先把未配对的反引号串换成哨兵（postprocess 还原），见 inline_code 的模块文档。
    let code_prep = inline_code::sanitize_stray_backticks(&block_prep.source);
    let inline_prep = inline_math::preprocess(&code_prep, &options);
    let arena = Arena::new();
    let root = parse_document(&arena, &inline_prep.source, &options);
    rewrite_inline_math(&arena, root, &inline_prep.maths);
    rewrite_block_math(root, &block_prep.blocks);
    rewrite_kaiti(root);
    linkify_pass(&arena, root);
    let mut html = String::with_capacity(inline_prep.source.len() * 2);
    format_html(root, &options, &mut html).expect("comrak HTML 渲染到 String 不会失败");
    postprocess(&html)
}

/// HTML → Markdown：1.x `sync-service.ts:135` 的 turndown 实例（同版本 7.2.4，跑同一份 JS）。
///
/// 用于拉取远端 `markdown: 0`（Quill HTML）的旧文档后落盘。
/// 引擎异常（内嵌脚本损坏/OOM）时 panic：与 1.x 的 `htmlToMd` 抛异常等价，不静默写坏文件。
pub fn html_to_md(html: &str) -> String {
    js::turndown(html).unwrap_or_else(|err| panic!("{err}"))
}

/// 把 `Text` 节点里的行内公式占位符换成 KaTeX 的 `NodeValue::Raw`。
///
/// 占位符形如 `$\u{E000}<id>\u{E001}$`（两侧 `$` 是解析期保留的 flanking 锚点），
/// 连同两侧 `$` 一起被替换——最终 HTML 里不会出现这两个 `$`。
fn rewrite_inline_math<'a>(
    arena: &'a Arena<'a>,
    root: comrak::Node<'a>,
    maths: &[inline_math::InlineMath],
) {
    let targets: Vec<comrak::Node<'a>> = root
        .descendants()
        .filter(
            |node| matches!(&node.data().value, NodeValue::Text(lit) if lit.contains(INLINE_OPEN)),
        )
        .collect();
    for node in targets {
        let literal = match &node.data().value {
            NodeValue::Text(lit) => lit.clone(),
            _ => continue,
        };
        let Some(segments) = split_inline_math(&literal, maths) else {
            continue;
        };
        for segment in segments {
            let value = match segment {
                Segment::Text(text) => NodeValue::Text(text.into()),
                Segment::Math(id) => {
                    let latex = maths.get(id).map(|m| m.latex.as_str()).unwrap_or("");
                    NodeValue::Raw(protect_raw_quotes(math::render_or_fallback(latex, false)))
                }
            };
            let new_node = arena.alloc(AstNode::from(value));
            node.insert_before(new_node);
        }
        node.detach();
    }
}

enum Segment {
    Text(String),
    Math(usize),
}

/// 按占位符切分文本；没有占位符返回 `None`（不需要改 AST）。
fn split_inline_math(literal: &str, maths: &[inline_math::InlineMath]) -> Option<Vec<Segment>> {
    let mut segments = Vec::new();
    let mut text_start = 0;
    let mut i = 0;
    let mut found = false;
    while let Some(rel) = literal[i..].find('$') {
        let pos = i + rel;
        if let Some((id, end)) = parse_inline_placeholder(literal, pos)
            && id < maths.len()
        {
            {
                found = true;
                if text_start < pos {
                    segments.push(Segment::Text(literal[text_start..pos].to_string()));
                }
                segments.push(Segment::Math(id));
                text_start = end;
                i = end;
                continue;
            }
        }
        i = pos + 1;
    }
    if !found {
        return None;
    }
    if text_start < literal.len() {
        segments.push(Segment::Text(literal[text_start..].to_string()));
    }
    Some(segments)
}

/// 解析 `$ OPEN <id> CLOSE $`，返回 `(id, 结束字节下标)`。
fn parse_inline_placeholder(literal: &str, pos: usize) -> Option<(usize, usize)> {
    let rest = literal[pos..].strip_prefix('$')?;
    let rest = rest.strip_prefix(INLINE_OPEN)?;
    let close_rel = rest.find(INLINE_CLOSE)?;
    let id: usize = rest[..close_rel].parse().ok()?;
    let after = &rest[close_rel + INLINE_CLOSE.len_utf8()..];
    let after = after.strip_prefix('$')?;
    let end = literal.len() - after.len();
    Some((id, end))
}

/// 把「整段就是一个块公式占位符」的 `Paragraph` 换成 `<div class="math-block">…</div>\n`。
fn rewrite_block_math(root: comrak::Node<'_>, blocks: &[blockmath::BlockMath]) {
    let targets: Vec<comrak::Node<'_>> = root
        .descendants()
        .filter(|node| matches!(node.data().value, NodeValue::Paragraph))
        .collect();
    for node in targets {
        let children: Vec<comrak::Node<'_>> = node.children().collect();
        if children.len() != 1 {
            continue;
        }
        let id = match &children[0].data().value {
            NodeValue::Text(lit) => parse_block_placeholder(lit),
            _ => None,
        };
        let Some(id) = id else { continue };
        let Some(block) = blocks.get(id) else {
            continue;
        };
        let html = format!(
            "<div class=\"math-block\">{}</div>\n",
            math::render_or_fallback(&block.latex, true)
        );
        while let Some(child) = node.first_child() {
            child.detach();
        }
        node.data_mut().value = NodeValue::Raw(protect_raw_quotes(html));
    }
}

/// 整段文本恰好是 `\u{E010}<id>\u{E011}`。
fn parse_block_placeholder(lit: &str) -> Option<usize> {
    let rest = lit.strip_prefix(BLOCK_OPEN)?;
    let close_rel = rest.find(BLOCK_CLOSE)?;
    if close_rel + BLOCK_CLOSE.len_utf8() != rest.len() {
        return None;
    }
    rest[..close_rel].parse().ok()
}

/// 1.x 的 `html_inline` 规则：内容 `trim()` 后精确等于 `<span class="kaiti">`（大小写不敏感）
/// 时原样放行，否则转义。`</span>` 不会被匹配（1.x 的 KAITI_RE 要求带 class 属性），
/// 所以闭标签仍然被转义——这是 1.x 的既有怪癖，必须原样保留。
fn rewrite_kaiti(root: comrak::Node<'_>) {
    let targets: Vec<comrak::Node<'_>> = root
        .descendants()
        .filter(
            |node| matches!(&node.data().value, NodeValue::HtmlInline(lit) if is_kaiti_tag(lit)),
        )
        .collect();
    for node in targets {
        let literal = match &node.data().value {
            NodeValue::HtmlInline(lit) => lit.clone(),
            _ => continue,
        };
        node.data_mut().value = NodeValue::Raw(literal);
    }
}

/// 1.x `KAITI_RE = /^<\/?span class="kaiti">$/i` 的等价判断——但要排除闭标签、
/// 精确匹配属性文本（`<span class="kaiti" >`、多 class 都不算）。
fn is_kaiti_tag(literal: &str) -> bool {
    let trimmed = literal.trim();
    trimmed.eq_ignore_ascii_case("<span class=\"kaiti\">")
}

/// linkify：在 `Text` 节点上跑 linkify-it 6.1.0 的移植版，把裸 URL / 裸邮箱拆成
/// `Text` + `Link(Text)` 兄弟节点。
///
/// 跳过规则对齐 1.x：`Link` / `Image` / `Code` / `CodeBlock` 里的文本不参与
/// （1.x 的后处理只处理内联 token 流里未被链接包住、也不是代码的 `text` 子 token）。
fn linkify_pass<'a>(arena: &'a Arena<'a>, root: comrak::Node<'a>) {
    let linkifier = linkifier();
    let targets: Vec<comrak::Node<'a>> = root
        .descendants()
        .filter(|node| matches!(node.data().value, NodeValue::Text(_)))
        .collect();
    for node in targets {
        if has_skipped_ancestor(node) {
            continue;
        }
        let literal = match &node.data().value {
            NodeValue::Text(lit) => lit.clone(),
            _ => continue,
        };
        let matches = linkifier.find(&literal);
        if matches.is_empty() {
            continue;
        }
        let mut cursor = 0;
        for found in matches {
            if found.start > cursor {
                let text = arena.alloc(AstNode::from(NodeValue::Text(
                    literal[cursor..found.start].to_string().into(),
                )));
                node.insert_before(text);
            }
            let link = arena.alloc(AstNode::from(NodeValue::Link(Box::new(NodeLink::new(
                found.url.as_str(),
                "",
            )))));
            let label = arena.alloc(AstNode::from(NodeValue::Text(found.text.clone().into())));
            link.append(label);
            node.insert_before(link);
            cursor = found.end;
        }
        if cursor < literal.len() {
            let text = arena.alloc(AstNode::from(NodeValue::Text(
                literal[cursor..].to_string().into(),
            )));
            node.insert_before(text);
        }
        node.detach();
    }
}

/// `Link` / `Image` / `Code` / `CodeBlock` 的子孙文本不参与 linkify。
fn has_skipped_ancestor(node: comrak::Node<'_>) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.data().value {
            NodeValue::Link(_)
            | NodeValue::Image(_)
            | NodeValue::Code(_)
            | NodeValue::CodeBlock(_) => return true,
            _ => {}
        }
        current = parent.parent();
    }
    false
}

fn linkifier() -> &'static linkify::Linkifier {
    use std::sync::OnceLock;
    static LINKIFIER: OnceLock<linkify::Linkifier> = OnceLock::new();
    LINKIFIER.get_or_init(linkify::Linkifier::new)
}

/// KaTeX 生成的 HTML 里本来就含 `&#x27;`（annotation 内容、katex-error 的
/// `title=` 属性），而 postprocess 要把 comrak 转义出来的 `&#x27;`（源文本的单引号）
/// 还原成 `'`。插入 Raw 时先换成哨兵，postprocess 最后再换回来，两端互不误伤。
const QUOTE_SENTINEL: char = '\u{E012}';

fn protect_raw_quotes(html: String) -> String {
    html.replace("&#x27;", &QUOTE_SENTINEL.to_string())
}

/// 渲染后的字节级修补：comrak 与 markdown-it 的输出差异都在这里抹平。
fn postprocess(html: &str) -> String {
    let mut out = html
        .replace('\u{FEFE}', "\u{FEFF}")
        // comrak 的文本转义（html crate）会把 `'` 转成 `&#x27;`，markdown-it 的
        // escapeHtml 只转 `& < > "`，单引号原样输出。
        .replace("&#x27;", "'")
        .replace(QUOTE_SENTINEL, "&#x27;")
        // markdown-it 的删除线是 `<s>`，comrak 是 `<del>`。
        .replace("<del>", "<s>")
        .replace("</del>", "</s>")
        // 未配对的反引号串在预处理阶段换成了哨兵，这里还原成字面量反引号。
        .replace(inline_code::BACKTICK_SENTINEL, "`");
    // markdown-it 15 的表格对齐输出 `style="text-align:left"`，comrak 用的是 `align="left"`。
    for align in ["left", "center", "right"] {
        out = out.replace(
            &format!(" align=\"{align}\""),
            &format!(" style=\"text-align:{align}\""),
        );
    }
    // markdown-it 的空元素不带 XHTML 斜杠（`<br>` 而不是 `<br />`）。
    out = strip_self_closing(&out);
    strip_newline_before_pre(&out)
}

const VOID_TAGS: [&str; 9] = [
    "br", "hr", "img", "input", "wbr", "source", "area", "col", "embed",
];

/// `<br />` → `<br>`：只动空元素，且确认标签名之后到 ` />` 之间没有别的 `>`。
fn strip_self_closing(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let mut matched = false;
            for tag in VOID_TAGS {
                let open = format!("<{tag}");
                if html[i..].starts_with(&open) {
                    let after_tag = i + open.len();
                    let rest = &html[after_tag..];
                    if let Some(rel) = rest.find(" />") {
                        let between = &rest[..rel];
                        if !between.contains('>') {
                            out.push_str(&html[i..after_tag]);
                            out.push_str(between);
                            out.push('>');
                            i = after_tag + rel + 3;
                            matched = true;
                        }
                    }
                    break;
                }
            }
            if matched {
                continue;
            }
        }
        let ch = html[i..].chars().next().expect("索引在字符边界上");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 列表项里「文本后紧跟代码块」时，comrak 会在 `<pre>` 前留一个换行，markdown-it 不留。
fn strip_newline_before_pre(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' && html[i + 1..].starts_with("<pre") && !out.ends_with('>') {
            i += 1;
            continue;
        }
        let ch = html[i..].chars().next().expect("索引在字符边界上");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests;
