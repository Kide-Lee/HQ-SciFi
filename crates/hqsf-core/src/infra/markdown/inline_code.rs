//! 未配对的反引号串「消毒」。
//!
//! ## 为什么要这一步
//!
//! CommonMark 里一段连续反引号（反引号串）只有在同段落内能找到**等长**的闭合串时才构成
//! 行内代码；否则它只是普通文本。markdown-it 与 comrak 对「未配对串」的处理不同：
//!
//! ```text
//! A（```js）、行内 `code`、行内公式 `$x^2$`。
//! ```
//!
//! markdown-it：```js 是字面量，后面两个单反引号正常配对成两个 `<code>`；
//! comrak：**一旦遇到未配对的长串，后续短串也不再配对**（整段退化为 Text），
//! 于是 `$x^2$` 落在 Text 里、被行内公式预处理当成公式渲染——发布出去的 HTML 与 1.x 不一致。
//!
//! ## 做法
//!
//! 先按 CommonMark 的配对规则自己扫一遍（`markdown-it` 的 `code_inline` 规则：
//! 从每个反引号串出发，向后找**等长**的串；找到就成对，找不到就是字面量），
//! 只把**未配对**的反引号逐个换成私有区哨兵 `\u{E004}`（渲染后由 `postprocess` 还原成 `` ` ``）。
//! 配对成功的串原样保留——它们的语义在 comrak 里一致，不需要我们重写。
//!
//! 围栏代码块（```/~~~）、缩进代码块内部不做处理：那里的反引号本来就是字面量。
//!
//! 局限（与语料/真实文档一致的取舍）：配对扫描按「段落块」进行（空行分隔的非围栏连续行），
//! 跨空行的行内代码在 CommonMark 里本来也不成立。

/// 未配对反引号的占位符（渲染后还原成 `` ` ``）。
pub(crate) const BACKTICK_SENTINEL: char = '\u{E004}';

/// 把未配对的反引号串换成哨兵，返回新源码。
pub(crate) fn sanitize_stray_backticks(src: &str) -> String {
    let lines: Vec<&str> = src.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    // 当前围栏（字符, 长度）；围栏内原样输出。
    let mut fence: Option<(u8, usize)> = None;
    // 当前段落块内已收集的行号区间（起, 止）。
    let mut para_start: Option<usize> = None;

    let flush = |out: &mut Vec<String>, start: usize, end: usize, lines: &[&str]| {
        let mut joined = String::new();
        for (k, line) in lines[start..end].iter().enumerate() {
            if k > 0 {
                joined.push('\n');
            }
            joined.push_str(line);
        }
        out.extend(sanitize_paragraph(&joined).split('\n').map(str::to_string));
    };

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some((ch, len)) = fence {
            if let Some(start) = para_start.take() {
                flush(&mut out, start, i, &lines);
            }
            out.push(line.to_string());
            if crate::infra::markdown::blockmath::is_closing_fence(line, ch, len) {
                fence = None;
            }
            i += 1;
            continue;
        }
        if let Some(opened) = crate::infra::markdown::blockmath::opening_fence(line) {
            if let Some(start) = para_start.take() {
                flush(&mut out, start, i, &lines);
            }
            fence = Some(opened);
            out.push(line.to_string());
            i += 1;
            continue;
        }
        let indented = line.starts_with("    ") || line.starts_with('\t');
        if line.trim().is_empty() || indented {
            if let Some(start) = para_start.take() {
                flush(&mut out, start, i, &lines);
            }
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if para_start.is_none() {
            para_start = Some(i);
        }
        i += 1;
    }
    if let Some(start) = para_start {
        flush(&mut out, start, lines.len(), &lines);
    }
    out.join("\n")
}

/// 段落块内的配对扫描：只改未配对的反引号。
///
/// 按 markdown-it 的 `code_inline` 语义顺序扫描：
/// 遇到一个未被转义的反引号串，就向后找**等长**的串作闭合；找到则两者都是代码定界符、
/// 扫描跳到闭合串之后；找不到则该串是字面量，继续向后扫。
/// 关键细节：**闭合串的搜索不看转义**（`` `a\`` 里的 `\`` 仍是闭合定界符，
/// 反斜杠只是代码内容的一部分），这与 markdown-it 一致；只有「扫描位置的串是否被转义」才看 `\`。
fn sanitize_paragraph(para: &str) -> String {
    let bytes = para.as_bytes();
    let n = bytes.len();
    // 代码定界符（保留原样）与被判定为字面量的串（换成哨兵）。
    let mut delimiters: Vec<(usize, usize)> = Vec::new();
    let mut literals: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < n {
        if bytes[i] == b'`' && !is_escaped(bytes, i) {
            let start = i;
            while i < n && bytes[i] == b'`' {
                i += 1;
            }
            let len = i - start;
            match find_run(bytes, i, len) {
                Some(close) => {
                    delimiters.push((start, len));
                    delimiters.push((close, len));
                    i = close + len;
                }
                None => literals.push((start, len)),
            }
            continue;
        }
        i += 1;
    }
    if literals.is_empty() {
        return para.to_string();
    }
    let mut out = String::with_capacity(para.len());
    let mut cursor = 0;
    for &(start, len) in &literals {
        out.push_str(&para[cursor..start]);
        for _ in 0..len {
            out.push(BACKTICK_SENTINEL);
        }
        cursor = start + len;
    }
    out.push_str(&para[cursor..]);
    out
}

/// 从 `from` 起找第一个长度恰为 `len` 的反引号串，返回起点。
fn find_run(bytes: &[u8], from: usize, len: usize) -> Option<usize> {
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if i - start == len {
                return Some(start);
            }
            continue;
        }
        i += 1;
    }
    None
}

/// 该位置的反引号是否被反斜杠转义（前面有奇数个 `\`）。
fn is_escaped(bytes: &[u8], pos: usize) -> bool {
    let mut k = pos;
    let mut count = 0;
    while k > 0 && bytes[k - 1] == b'\\' {
        count += 1;
        k -= 1;
    }
    count % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitize(src: &str) -> String {
        sanitize_stray_backticks(src).replace(BACKTICK_SENTINEL, "`")
    }

    /// 配对成功时输出与输入逐字节一致（这一步不该动合法代码块）。
    #[test]
    fn paired_runs_are_left_alone() {
        for src in [
            "a `code` b",
            "a ``x`y`` b",
            "`code` 和 `另一个`",
            "```js\nlet a = `tpl`;\n```",
        ] {
            assert_eq!(sanitize(src), src, "{src:?}");
        }
    }

    /// 未配对的长串被中和后，后面的短串仍然成对（这正是修 comrak 差异的关键）。
    #[test]
    fn stray_long_run_no_longer_breaks_later_pairs() {
        let src = "A（```js）、行内 `code`、行内公式 `$x^2$`。";
        let out = sanitize_stray_backticks(src);
        assert!(!out.contains("```"), "未配对的三反引号应被替换：{out:?}");
        assert!(out.contains("`code`"));
        assert!(out.contains("`$x^2$`"));
        assert_eq!(sanitize(src), src);
    }

    /// 段落被空行分隔：每段独立配对。
    #[test]
    fn paragraphs_are_paired_independently() {
        let src = "段一 `a`\n\n段二 ```x``` 与 `b`";
        assert_eq!(sanitize(src), src);
    }
}
