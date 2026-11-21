//! 块级 `$$…$$` 数学公式的预处理。
//!
//! 1.x 用 `src/shared/markdownItMath.ts` 注册的 `math_block` **块规则**识别块公式；
//! 这是插件行为、不是 CommonMark，comrak 原生没有等价物（它自己的 `math_dollars_block`
//! 语义、trim 与内容归一化都不同）。这里在 comrak 解析**之前**按行把公式摘出来，
//! 换成一行私有区占位符，等渲染阶段再把那一整段换回 `<div class="math-block">…</div>\n`。
//!
//! 复刻的规则（`markdownItMath.ts` 的 `md.block.ruler.after('blockquote','math_block', …)`）：
//! - 只在**块起始**位置生效（`$$` 不能打断段落：该规则没有 `alt` 数组，不在 paragraph 的
//!   terminatorRules 里）；
//! - 首行 `trim()` 后必须以 `$$` 开头；
//! - 单行形式 `$$latex$$ 行尾文字`：取第一个 `$$` 之前的内容（**行尾文字被吞掉**）；
//! - 多行形式：`parts[0]` = 首行 `$$` 之后 trim 的内容；中间行各自 trim；首个
//!   `endsWith("$$")` 的行贡献 `行[..len-2].trim()`（**即使为空也加入**，所以
//!   `$$\nE\n$$` 的 latex 是 `"\nE\n"`）；`parts.join("\n")`；
//! - 找不到闭合行 → 不是块公式，原样留作普通段落。
//!
//! 为什么用私有区（PUA）字符做占位符：它们既不是 ASCII 标点也不是空白，渲染期能被
//! 精确定位；占位符是**整行**内容（不含 markdown 记号），不会参与行内解析。

/// 块公式占位符的起止标记（`\u{E010}` + 十进制序号 + `\u{E011}`）。
pub(crate) const BLOCK_OPEN: char = '\u{E010}';
pub(crate) const BLOCK_CLOSE: char = '\u{E011}';

/// 一个被摘出来的块级公式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BlockMath {
    /// 传给 `katex.renderToString(content, {displayMode:true})` 的原文（已按 1.x 规则 trim）。
    pub latex: String,
}

/// 预处理结果：替换后的源码 + 块公式表（下标 = 占位符序号）。
#[derive(Debug, Clone, Default)]
pub(crate) struct BlockMathPrep {
    pub source: String,
    pub blocks: Vec<BlockMath>,
}

/// 逐行扫描源码，把块级 `$$` 公式换成占位符行。
pub(crate) fn preprocess(src: &str) -> BlockMathPrep {
    let lines: Vec<&str> = src.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut blocks: Vec<BlockMath> = Vec::new();
    // 当前打开的围栏（字符, 长度）；围栏内的行不参与块公式识别。
    let mut fence: Option<(u8, usize)> = None;
    // 解析器是否处在「块起始」位置（对应 markdown-it 每次 block ruler 的开头）。
    let mut block_start = true;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some((ch, len)) = fence {
            out.push(line.to_string());
            if is_closing_fence(line, ch, len) {
                fence = None;
                block_start = true;
            } else {
                block_start = false;
            }
            i += 1;
            continue;
        }
        if let Some(opened) = opening_fence(line) {
            fence = Some(opened);
            out.push(line.to_string());
            block_start = true;
            i += 1;
            continue;
        }
        if block_start && let Some((prefix, latex, end)) = match_block_math(&lines, i) {
            let id = blocks.len();
            blocks.push(BlockMath { latex });
            out.push(format!("{prefix}{BLOCK_OPEN}{id}{BLOCK_CLOSE}"));
            // 公式整体被这一行占位符替代，后面紧跟的又是块起始。
            i = end + 1;
            block_start = true;
            continue;
        }
        out.push(line.to_string());
        block_start = line.trim().is_empty() || ends_block(line);
        i += 1;
    }
    BlockMathPrep {
        source: out.join("\n"),
        blocks,
    }
}

/// 从第 `i` 行开始尝试识别一个块公式。返回 `(行前缀, latex, 闭合行下标)`。
fn match_block_math(lines: &[&str], i: usize) -> Option<(String, String, usize)> {
    let line = lines[i];
    let (content_start, spaces) = split_prefix(line);
    // 缩进 ≥ 4 空格是缩进代码块（markdown-it 里 code 规则排在 math_block 之前）。
    if spaces >= 4 {
        return None;
    }
    let content = &line[content_start..];
    if !content.starts_with("$$") {
        return None;
    }
    let prefix = line[..content_start].to_string();
    let rest = content[2..].trim();
    if let Some(pos) = rest.find("$$") {
        // 单行形式：`$$latex$$ 尾随文字`（尾随文字按 1.x 规则被丢弃）。
        return Some((prefix, rest[..pos].trim().to_string(), i));
    }
    // 多行形式：向后找第一行 `trim().ends_with("$$")`。
    let mut parts: Vec<String> = vec![rest.to_string()];
    let mut j = i + 1;
    while j < lines.len() {
        let (cs, _) = split_prefix(lines[j]);
        let content = lines[j][cs..].trim();
        if let Some(head) = content.strip_suffix("$$") {
            parts.push(head.trim().to_string());
            return Some((prefix, parts.join("\n"), j));
        }
        parts.push(content.to_string());
        j += 1;
    }
    // 没有闭合行 → 交给普通块解析（1.x 的 math_block 规则此时返回 false）。
    None
}

/// 剥掉容器前缀（缩进 / `>` 引用 / 列表标记），返回 `(内容起始字节下标, 最后一层缩进)`。
///
/// `spaces` 用来识别缩进代码块：顶层行 4 空格、列表项标记之后的 4 空格都算代码。
pub(crate) fn split_prefix(line: &str) -> (usize, usize) {
    let bytes = line.as_bytes();
    let mut i = 0;
    loop {
        let mut spaces = 0;
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
            spaces += 1;
        }
        if i >= bytes.len() {
            return (bytes.len(), spaces);
        }
        if bytes[i] == b'>' {
            i += 1;
            if i < bytes.len() && bytes[i] == b' ' {
                i += 1;
            }
            continue;
        }
        if let Some(len) = list_marker_len(&line[i..]) {
            i += len;
            continue;
        }
        return (i, spaces);
    }
}

/// 列表标记长度（`- ` / `* ` / `+ ` / `1. ` / `1) `），不匹配返回 `None`。
fn list_marker_len(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let first = *bytes.first()?;
    if matches!(first, b'-' | b'*' | b'+') {
        return match bytes.get(1) {
            Some(b' ') => Some(2),
            Some(_) => None,
            None => None,
        };
    }
    let mut digits = 0;
    while digits < bytes.len() && bytes[digits].is_ascii_digit() {
        digits += 1;
    }
    if digits == 0 || digits > 9 {
        return None;
    }
    match bytes.get(digits) {
        Some(b'.') | Some(b')') if bytes.get(digits + 1) == Some(&b' ') => Some(digits + 2),
        _ => None,
    }
}

/// 该行之后是否一定是新的块起始（标题 / 分隔线 / setext 下划线）。
///
/// 只覆盖「上一行非空、但块已经结束」的情形：普通段落行不能作为块起始，
/// 因为 `$$` 规则不参与段落打断。
fn ends_block(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    // ATX 标题（`#`…`######` 后跟空格或行尾）。
    let hashes = trimmed.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) {
        let rest = &trimmed[hashes..];
        if rest.is_empty() || rest.starts_with(' ') {
            return true;
        }
    }
    // 分隔线（`---` / `***` / `___`，允许中间空格）。
    let mut marks = trimmed.chars().filter(|c| !c.is_whitespace());
    if let Some(first) = marks.next()
        && matches!(first, '-' | '*' | '_')
    {
        let count = 1 + marks.clone().count();
        if count >= 3 && marks.all(|c| c == first) {
            return true;
        }
    }
    // setext 标题下划线（`===` / `---` 已在上面覆盖）。
    trimmed.bytes().all(|b| b == b'=') && !trimmed.is_empty()
}

/// 该行是否开启一个围栏代码块；返回 `(围栏字符, 长度)`。
fn opening_fence(line: &str) -> Option<(u8, usize)> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return None;
    }
    let ch = *trimmed.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = trimmed.bytes().take_while(|b| *b == ch).count();
    if len < 3 {
        return None;
    }
    // 反引号围栏的 info string 里不能再出现反引号（CommonMark）。
    if ch == b'`' && trimmed[len..].contains('`') {
        return None;
    }
    Some((ch, len))
}

/// 该行是否闭合当前围栏。
fn is_closing_fence(line: &str, ch: u8, len: usize) -> bool {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return false;
    }
    let count = trimmed.bytes().take_while(|b| *b == ch).count();
    count >= len && trimmed[count..].trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prep(src: &str) -> (String, Vec<String>) {
        let p = preprocess(src);
        (p.source, p.blocks.into_iter().map(|b| b.latex).collect())
    }

    #[test]
    fn single_line_block_drops_trailing_text() {
        let (source, blocks) = prep("$$E = mc^2$$ 行尾还有文字\n");
        assert_eq!(source, format!("{BLOCK_OPEN}0{BLOCK_CLOSE}\n"));
        assert_eq!(blocks, vec!["E = mc^2".to_string()]);
    }

    #[test]
    fn multi_line_block_keeps_empty_head_and_tail() {
        let (source, blocks) = prep("$$\nE = mc^2\n$$\n");
        assert_eq!(source, format!("{BLOCK_OPEN}0{BLOCK_CLOSE}\n"));
        assert_eq!(blocks, vec!["\nE = mc^2\n".to_string()]);
    }

    #[test]
    fn block_inside_blockquote_keeps_prefix_and_strips_quote_markers() {
        let (source, blocks) = prep("> $$\n> E = mc^2\n> $$\n");
        assert!(source.starts_with("> \u{E010}0"), "source={source:?}");
        assert_eq!(blocks, vec!["\nE = mc^2\n".to_string()]);
    }

    #[test]
    fn unclosed_block_math_is_left_alone() {
        let (source, blocks) = prep("$$未闭合\n\n结束\n");
        assert!(blocks.is_empty());
        assert_eq!(source, "$$未闭合\n\n结束\n");
    }

    #[test]
    fn math_inside_fence_is_not_extracted() {
        let (source, blocks) = prep("```\n$$\nE\n$$\n```\n");
        assert!(blocks.is_empty());
        assert!(source.starts_with("```\n$$\n"));
    }

    #[test]
    fn math_cannot_interrupt_a_paragraph() {
        let (source, blocks) = prep("段落\n$$E$$\n");
        assert!(blocks.is_empty());
        assert_eq!(source, "段落\n$$E$$\n");
    }

    #[test]
    fn math_starts_after_heading() {
        let (source, blocks) = prep("# 标题\n$$E$$\n");
        assert_eq!(blocks, vec!["E".to_string()]);
        assert!(source.starts_with("# 标题\n\u{E010}0"));
    }

    #[test]
    fn indented_four_spaces_is_code_not_math() {
        let (source, blocks) = prep("    $$E$$\n");
        assert!(blocks.is_empty());
        assert_eq!(source, "    $$E$$\n");
    }
}
