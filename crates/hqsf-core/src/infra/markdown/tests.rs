//! 金标准对拍：语料文件由 `scripts/gen-markdown-corpus.mjs` 用 Node 跑 1.x 真实现生成，
//! 每行 `{ "name", "input", "html" }`。CI 只跑这里（不需要 node）。
//!
//! 失败时打印 name 与**首个差异位置**（字节下标 + 上下文），不要只打印长度。

use std::path::PathBuf;

use super::*;

#[derive(Debug, serde::Deserialize)]
struct HtmlCase {
    name: String,
    input: String,
    html: String,
}

#[derive(Debug, serde::Deserialize)]
struct FrontmatterCase {
    name: String,
    input: String,
    meta: frontmatter::FrontmatterMeta,
    body: String,
}

fn testdata(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/markdown")
        .join(name)
}

fn load_jsonl<T: serde::de::DeserializeOwned>(name: &str) -> Vec<T> {
    let raw = std::fs::read_to_string(testdata(name)).unwrap_or_else(|e| {
        panic!(
            "读取语料 {} 失败：{e}（先跑 node scripts/gen-markdown-corpus.mjs）",
            testdata(name).display()
        )
    });
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|e| panic!("语料行不是合法 JSON：{e}"))
        })
        .collect()
}

/// 首个差异的字节下标。
fn first_diff(expected: &str, actual: &str) -> usize {
    let mut index = 0;
    for (a, b) in expected.bytes().zip(actual.bytes()) {
        if a != b {
            return index;
        }
        index += 1;
    }
    index
}

/// 把差异位置渲染成可读片段（前后各一小段，标出断点）。
fn diff_context(name: &str, expected: &str, actual: &str) -> String {
    let pos = first_diff(expected, actual);
    let start_e = floor_boundary(expected, pos.saturating_sub(60));
    let start_a = floor_boundary(actual, pos.saturating_sub(60));
    let end_e = ceil_boundary(expected, (pos + 80).min(expected.len()));
    let end_a = ceil_boundary(actual, (pos + 80).min(actual.len()));
    format!(
        "case {name}: 首差 @ 字节 {pos}\n    期望[{start_e}..]: {:?}\n    实际[{start_a}..]: {:?}\n    期望长度 {} / 实际长度 {}",
        &expected[start_e..end_e],
        &actual[start_a..end_a],
        expected.len(),
        actual.len()
    )
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_boundary(text: &str, mut index: usize) -> usize {
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn run_corpus(cases: &[HtmlCase], render: fn(&str) -> String) {
    let mut failures = Vec::new();
    for case in cases {
        let actual = render(&case.input);
        if actual != case.html {
            failures.push(diff_context(&case.name, &case.html, &actual));
        }
    }
    if !failures.is_empty() {
        let total = cases.len();
        let passed = total - failures.len();
        let shown: Vec<&String> = failures.iter().take(8).collect();
        panic!(
            "md_to_html 语料对拍失败：{passed}/{total} 通过（要求 100% L0）\n{}",
            shown
                .iter()
                .map(|f| f.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    eprintln!("md_to_html 语料对拍通过：{} 条（100% L0）", cases.len());
}

#[test]
fn md_to_html_matches_markdown_it_corpus() {
    let cases: Vec<HtmlCase> = load_jsonl("corpus.jsonl");
    // 语料随仓库 md 文档增删而变（`node scripts/gen-markdown-corpus.mjs` 重生成）；这里只防「生成失败/被截断」。
    assert!(
        cases.len() >= 120,
        "语料过少（{} 条），疑似生成失败",
        cases.len()
    );
    run_corpus(&cases, md_to_html);
}

#[test]
fn html_to_md_matches_turndown_corpus() {
    let cases: Vec<HtmlCase> = load_jsonl("html2md.jsonl");
    assert!(cases.len() >= 15, "语料应有 ≥15 条，实际 {}", cases.len());
    run_corpus(&cases, html_to_md);
}

#[test]
fn frontmatter_matches_ts_corpus() {
    let cases: Vec<FrontmatterCase> = load_jsonl("frontmatter.jsonl");
    assert!(!cases.is_empty());
    for case in &cases {
        let parsed = frontmatter::parse(&case.input);
        assert_eq!(
            parsed.meta, case.meta,
            "frontmatter meta 不一致：{}",
            case.name
        );
        assert_eq!(
            parsed.body, case.body,
            "frontmatter body 不一致：{}",
            case.name
        );
    }
    eprintln!("frontmatter 语料对拍通过：{} 条", cases.len());
}

// ---- 1.x 输出的已知怪癖：即使没有语料覆盖，也固定成显式断言 ----

#[test]
fn kaiti_open_tag_passes_through_but_close_tag_is_escaped() {
    // 1.x 的 KAITI_RE 只认开标签；`<span class="kaiti">楷体</span>` 的闭标签被转义。
    assert_eq!(
        md_to_html("<span class=\"kaiti\">楷体</span>"),
        "<p><span class=\"kaiti\">楷体&lt;/span&gt;</p>\n"
    );
}

#[test]
fn braces_kaiti_variants_are_escaped() {
    // class 属性必须精确等于 `kaiti`：多余空格、多 class 都不放行。
    assert_eq!(
        md_to_html("<span class=\"kaiti\" >x</span>"),
        "<p>&lt;span class=&quot;kaiti&quot; &gt;x&lt;/span&gt;</p>\n"
    );
}

#[test]
fn soft_break_becomes_bare_br() {
    // breaks:true + markdown-it 输出 `<br>`（无 XHTML 斜杠）。
    assert_eq!(md_to_html("一行\n二行\n"), "<p>一行<br>\n二行</p>\n");
}

#[test]
fn table_cells_use_style_instead_of_align() {
    let html = md_to_html("| a | b |\n| :- | -: |\n| 1 | 2 |\n");
    assert!(html.contains("<th style=\"text-align:left\">"), "{html}");
    assert!(html.contains("<th style=\"text-align:right\">"), "{html}");
}

#[test]
fn bare_url_and_email_are_linkified() {
    let html = md_to_html("访问 https://example.com/a?b=1 ，邮箱 me@example.com");
    assert!(
        html.contains("<a href=\"https://example.com/a?b=1\">https://example.com/a?b=1</a>"),
        "{html}"
    );
    assert!(
        html.contains("<a href=\"mailto:me@example.com\">me@example.com</a>"),
        "{html}"
    );
}

#[test]
fn code_span_keeps_dollar_literal() {
    assert_eq!(
        md_to_html("`$not math$`"),
        "<p><code>$not math$</code></p>\n"
    );
}

#[test]
fn block_math_renders_div_with_display_katex() {
    let html = md_to_html("$$\nE = mc^2\n$$\n");
    assert!(
        html.starts_with("<div class=\"math-block\"><span class=\"katex-display\">"),
        "{html}"
    );
    assert!(html.ends_with("</div>\n"), "{html}");
    assert!(
        html.contains("<annotation encoding=\"application/x-tex\">\nE = mc^2\n</annotation>"),
        "{html}"
    );
}

/// 未配对的反引号串不能让后面的行内代码/行内公式失灵
/// （comrak 在这里与 markdown-it 行为不同，见 `inline_code` 的模块文档）。
#[test]
fn stray_backticks_do_not_swallow_later_inline_code() {
    let html = md_to_html("A（```js）、行内 `code`、行内公式 `$x^2$`。");
    assert!(html.contains("<code>code</code>"), "{html}");
    assert!(html.contains("<code>$x^2$</code>"), "{html}");
    assert!(!html.contains("katex"), "行内公式必须留在代码里：{html}");
}
