//! 行内 `$…$` 数学公式的替换。
//!
//! 1.x 用 `src/shared/markdownItMath.ts` 的 `math_inline` **行内规则**识别公式：
//! 在 `$` 处触发；下一个字符还是 `$` 就放弃（交给块规则/字面量）；否则在**原始行内
//! 源**里向后找第一个「`$` 且其后字符不是 `$`」作为闭合，内容取两 `$` 之间的原始切片。
//! 这条规则既不检查空格、也不检查转义、也不归一化内容——直接交给 KaTeX。
//!
//! 我们的做法（不改 comrak）：
//! 1. **探测 pass**：用同一套 comrak 选项先解析一遍（此时源码里的 `$` 还没替换），
//!    收集每个 `Text` 节点的字节范围与它所属的**行内块**（Paragraph / Heading /
//!    TableCell）范围。`$` 只有落在某个 `Text` 里才可达——落在 Code（行内代码）、
//!    HtmlInline（标签属性）、autolink 文本、fence 里的 `$` 都不可达，与 markdown-it
//!    的规则顺序（math_inline 在 backticks / html_inline / autolink 之前但 `$` 必须
//!    先由 text 规则产出）一致。
//! 2. **配对**：按源码顺序扫描可达的 `$` 作为开标记，在**同一个行内块**内找闭合
//!    （`\$` 不能做开标记，但按 1.x 的 naive 扫描可以做闭标记）。
//! 3. **替换**：只把两 `$` **之间的内容**换成私有区占位符，保留两侧 `$`——
//!    这样 CommonMark 的 emphasis flanking 判定看到的仍是 `$`（Sc 标点），不会因为
//!    占位符变成别的字符类而改变相邻 `*` / `_` 的解析结果。
//!
//! 行内公式的 markdown-it content 是「行内块内原始切片」；comrak 的 `Subject.input`
//! 会把容器前缀/缩进剥掉再解析，所以跨行的行内公式在这里会多带 `> ` 之类的前缀。
//! 语料里行内公式全部是单行，这个偏差对现有语料无影响（见交付报告）。

use comrak::nodes::{NodeValue, Sourcepos};
use comrak::{Arena, Options, parse_document};

/// 行内公式占位符的起止标记（`\u{E000}` + 十进制序号 + `\u{E001}`）。
pub(crate) const INLINE_OPEN: char = '\u{E000}';
pub(crate) const INLINE_CLOSE: char = '\u{E001}';

/// 一个被摘出来的行内公式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InlineMath {
    /// 传给 `katex.renderToString(content, {displayMode:false})` 的原文。
    pub latex: String,
}

/// 预处理结果：替换后的源码 + 行内公式表（下标 = 占位符序号）。
#[derive(Debug, Clone, Default)]
pub(crate) struct InlineMathPrep {
    pub source: String,
    pub maths: Vec<InlineMath>,
}

/// 一个 `Text` 节点覆盖的字节区间，以及它所在行内块的结束位置（闭合扫描上界）。
#[derive(Debug, Clone, Copy)]
struct Reach {
    start: usize,
    end: usize,
    host_end: usize,
}

/// 把可达的 `$…$` 内容替换成占位符。
pub(crate) fn preprocess(src: &str, options: &Options) -> InlineMathPrep {
    let line_starts = LineStarts::new(src);
    let reaches = collect_reaches(src, &line_starts, options);
    let candidates: Vec<usize> = src
        .bytes()
        .enumerate()
        .filter_map(|(i, b)| (b == b'$').then_some(i))
        .collect();

    let mut out: Vec<(usize, usize, String)> = Vec::new();
    let mut maths: Vec<InlineMath> = Vec::new();
    let mut k = 0;
    while k < candidates.len() {
        let pos = candidates[k];
        k += 1;
        let Some(host_end) = reachable_end(&reaches, pos) else {
            continue;
        };
        // `\$` 会被 escape 规则吃掉：不作开标记（但按 1.x 的 naive 扫描仍可作闭标记）。
        if is_escaped(src.as_bytes(), pos) {
            continue;
        }
        // 下一个字符还是 `$`：1.x 的 math_inline 直接放弃，交给后续规则/字面量。
        if pos + 1 < host_end && src.as_bytes()[pos + 1] == b'$' {
            continue;
        }
        // 在同一个行内块内找第一个「`$` 且其后字符不是 `$`」。
        let mut closer = None;
        let mut j = pos + 1;
        while j < host_end {
            if src.as_bytes()[j] == b'$' && (j + 1 >= host_end || src.as_bytes()[j + 1] != b'$') {
                closer = Some(j);
                break;
            }
            j += 1;
        }
        let Some(j) = closer else {
            continue;
        };
        let id = maths.len();
        maths.push(InlineMath {
            latex: src[pos + 1..j].to_string(),
        });
        // 只替换两 `$` 之间的内容：两侧 `$` 保留在源码里，CommonMark 的
        // emphasis flanking 判定看到的仍是 `$`（Sc 标点），解析结果与 1.x 一致。
        out.push((pos + 1, j, format!("{INLINE_OPEN}{id}{INLINE_CLOSE}")));
        // 公式内容里的 `$` 已经被吃掉了，不能再当开标记。
        while k < candidates.len() && candidates[k] <= j {
            k += 1;
        }
    }

    if out.is_empty() {
        return InlineMathPrep {
            source: src.to_string(),
            maths,
        };
    }
    let mut rebuilt = String::with_capacity(src.len() + out.len() * 4);
    let mut cursor = 0;
    for (start, end, replacement) in out {
        rebuilt.push_str(&src[cursor..start]);
        rebuilt.push_str(&replacement);
        cursor = end;
    }
    rebuilt.push_str(&src[cursor..]);
    InlineMathPrep {
        source: rebuilt,
        maths,
    }
}

/// 位置 `pos` 是否落在某个 `Text` 节点内；是则返回所属行内块的结束字节下标。
fn reachable_end(reaches: &[Reach], pos: usize) -> Option<usize> {
    let idx = reaches.partition_point(|r| r.start <= pos);
    if idx == 0 {
        return None;
    }
    let reach = &reaches[idx - 1];
    (pos < reach.end).then_some(reach.host_end)
}

/// `pos` 之前紧邻的反斜杠个数为奇数 → 该 `$` 被转义。
fn is_escaped(bytes: &[u8], pos: usize) -> bool {
    let mut count = 0;
    let mut i = pos;
    while i > 0 && bytes[i - 1] == b'\\' {
        count += 1;
        i -= 1;
    }
    count % 2 == 1
}

/// 先解析一遍，收集所有 `Text` 的字节范围与所属行内块范围。
fn collect_reaches(src: &str, line_starts: &LineStarts, options: &Options) -> Vec<Reach> {
    let arena = Arena::new();
    let root = parse_document(&arena, src, options);
    let mut reaches = Vec::new();
    walk(root, None, src, line_starts, &mut reaches);
    reaches.sort_by_key(|r| r.start);
    reaches
}

fn walk<'a>(
    node: comrak::Node<'a>,
    host_end: Option<usize>,
    src: &str,
    line_starts: &LineStarts,
    reaches: &mut Vec<Reach>,
) {
    let (value, sourcepos) = {
        let data = node.data();
        (data.value.clone(), data.sourcepos)
    };
    let next_host = match value {
        NodeValue::Paragraph | NodeValue::Heading(_) | NodeValue::TableCell => {
            Some(sourcepos_end(sourcepos, src, line_starts))
        }
        _ => host_end,
    };
    if let NodeValue::Text(literal) = &value
        && !is_autolink_text(node, literal)
        && let Some(host_end) = next_host
    {
        let start = sourcepos_start(sourcepos, line_starts);
        let end = sourcepos_end(sourcepos, src, line_starts);
        if start < end {
            reaches.push(Reach {
                start,
                end,
                host_end: host_end.max(end),
            });
        }
    }
    let mut child = node.first_child();
    while let Some(current) = child {
        walk(current, next_host, src, line_starts, reaches);
        child = current.next_sibling();
    }
}

/// autolink 的可见文本（`<https://x>` / `<me@example.com>`）被 autolink 规则整体吃掉，
/// 里面的 `$` 在 markdown-it 里永远到不了 math_inline。
fn is_autolink_text(node: comrak::Node<'_>, literal: &str) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let data = parent.data();
    match &data.value {
        NodeValue::Link(link) => link.url == literal || link.url == format!("mailto:{literal}"),
        _ => false,
    }
}

fn sourcepos_start(sourcepos: Sourcepos, line_starts: &LineStarts) -> usize {
    line_starts.offset(sourcepos.start.line, sourcepos.start.column)
}

/// 结束位置换算成**排他**字节下标：`LineColumn::column` 是最后一个字符的 1 基
/// 字节列，转成下标后再推进到字符边界之外（多字节字符时 column 可能指向字符首字节）。
fn sourcepos_end(sourcepos: Sourcepos, src: &str, line_starts: &LineStarts) -> usize {
    let start = sourcepos_start(sourcepos, line_starts);
    let mut end = line_starts.offset(sourcepos.end.line, sourcepos.end.column) + 1;
    if end > src.len() {
        end = src.len();
    }
    while end < src.len() && !src.is_char_boundary(end) {
        end += 1;
    }
    end.max(start)
}

/// 每行的起始字节下标（行号 1 基）。
struct LineStarts(Vec<usize>);

impl LineStarts {
    fn new(src: &str) -> Self {
        let mut starts = vec![0];
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self(starts)
    }

    fn offset(&self, line: usize, column: usize) -> usize {
        let base = if line == 0 {
            0
        } else {
            self.0.get(line - 1).copied().unwrap_or(0)
        };
        base + column.saturating_sub(1)
    }
}
