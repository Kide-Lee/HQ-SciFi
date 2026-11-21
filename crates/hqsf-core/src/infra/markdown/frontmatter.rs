//! `src/shared/frontmatter.ts` 的 Rust 对等实现：解析文章头部的 YAML frontmatter
//! （类型/标签/活动/是否公开），返回元信息与正文。
//!
//! 1.x 的业务背景（`src/shared/frontmatter.ts:1-6`）：v0.0.6 起元信息改由发布表单提供，
//! 本地 frontmatter 不再写入这些字段；解析只用于**兼容旧文档**——打开时剥离
//! frontmatter 块，正文进编辑器。
//!
//! 实现是逐行状态机，不是完整 YAML 解析器（1.x 也不是）。为了两端输出一致，
//! 这里逐条对齐 TS 的分支顺序与真理值判定，包括几个容易被"顺手修正"的怪癖：
//! - 首行必须 `trim()` 后精确等于 `---`，否则整篇原样当正文；
//! - `key:` 空值进入「列表模式」，后续 `- item` 行都归入该键；
//! - `[a, b]` 行内数组按逗号切分，每段 unquote 后**过滤空串**；
//! - unquote 只去掉**一个**前引号和一个后引号（`/^["']|["']$/g`）；
//! - 找不到闭合 `---` 时，正文为空字符串（TS 的 `lines.slice(i + 1)` 自然得到空）。

/// 1.x `ArticleMeta`：四个字段都可缺省。
#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterMeta {
    /// 文章类型（category 名称，如「原创作品」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 标签（tag 名称列表）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 参加的活动（active 名称；缺省 = 不参加）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    /// 是否公开阅读（缺省 true，与荒启默认一致）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isopen: Option<bool>,
}

/// `parseFrontmatter()` 的返回值。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedFrontmatter {
    pub meta: FrontmatterMeta,
    pub body: String,
}

/// 解析 md 全文 → `{ meta, body }`；无 frontmatter 时 meta 为空、body 原样返回。
pub fn parse(md: &str) -> ParsedFrontmatter {
    const FM_START: &str = "---";
    const FM_END: &str = "---";

    let lines: Vec<&str> = md.split('\n').collect();
    if lines.is_empty() || js_trim(lines[0]) != FM_START {
        return ParsedFrontmatter {
            meta: FrontmatterMeta::default(),
            body: md.to_string(),
        };
    }

    // raw 里存「字符串」或「字符串数组」两种形态（TS 的联合类型）。
    let mut raw: std::collections::HashMap<String, RawValue> = std::collections::HashMap::new();
    let mut list_key: Option<String> = None;
    let mut i = 1;
    while i < lines.len() {
        let line = lines[i];
        if js_trim(line) == FM_END {
            break;
        }
        let t = js_trim(line);
        if t.is_empty() || t.starts_with('#') {
            i += 1;
            continue;
        }
        // 列表项（缩进的 - 或 键: 后的 - 行）归入当前列表键。
        // `^-\s+` 要求 `-` 后至少一个空白；`replace(/^-\s+/, '')` 把这段空白整段去掉。
        if let Some(key) = &list_key
            && matches_list_item(t)
        {
            let item = unquote(t[1..].trim_start());
            let entry = raw
                .entry(key.clone())
                .or_insert_with(|| RawValue::List(Vec::new()));
            if let RawValue::List(items) = entry {
                items.push(item);
                i += 1;
                continue;
            }
        }
        let Some((key, val)) = split_key_value(t) else {
            i += 1;
            continue;
        };
        if val.is_empty() {
            raw.insert(key.clone(), RawValue::List(Vec::new()));
            list_key = Some(key);
        } else if val.starts_with('[') && val.ends_with(']') {
            let inner = &val[1..val.len() - 1];
            let items: Vec<String> = inner
                .split(',')
                .map(|s| unquote(js_trim(s)))
                .filter(|s| !s.is_empty())
                .collect();
            raw.insert(key, RawValue::List(items));
            list_key = None;
        } else {
            raw.insert(key, RawValue::Str(unquote(&val)));
            list_key = None;
        }
        i += 1;
    }

    // i 停在 FM_END 行：body 从其后一行开始（跳过多余空行）。
    let mut body = if i + 1 < lines.len() {
        lines[i + 1..].join("\n")
    } else {
        String::new()
    };
    body = body.trim_start_matches('\n').to_string();

    let mut meta = FrontmatterMeta::default();
    if let Some(RawValue::Str(category)) = raw.get("category")
        && !category.is_empty()
    {
        meta.category = Some(category.clone());
    }
    if let Some(RawValue::List(tags)) = raw.get("tags")
        && !tags.is_empty()
    {
        meta.tags = Some(tags.clone());
    }
    if let Some(RawValue::Str(active)) = raw.get("active")
        && !active.is_empty()
    {
        meta.active = Some(active.clone());
    }
    if let Some(value) = raw.get("isopen") {
        meta.isopen = match value {
            RawValue::Str(s) if s == "true" => Some(true),
            RawValue::Str(s) if s == "false" => Some(false),
            _ => None,
        };
    }
    ParsedFrontmatter { meta, body }
}

/// 剥离 frontmatter，仅返回正文（1.x `stripFrontmatter`）。
pub fn strip(md: &str) -> String {
    parse(md).body
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RawValue {
    Str(String),
    List(Vec<String>),
}

/// `^-\s+`：`-` 后至少一个空白。
fn matches_list_item(t: &str) -> bool {
    let Some(rest) = t.strip_prefix('-') else {
        return false;
    };
    rest.starts_with(char::is_whitespace)
}

/// ECMAScript 的 `String.prototype.trim()`：除了 Unicode 空白，还剥 U+FEFF（BOM）。
/// Rust 的 `str::trim()` 不把 BOM 当空白，旧文档里 `\uFEFF---` 开头的情况必须按 JS 处理。
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// `^([A-Za-z_]+)\s*:\s*(.*)$`，返回 `(key, val.trim())`。
fn split_key_value(t: &str) -> Option<(String, String)> {
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let key = t[..i].to_string();
    let rest = t[i..].trim_start();
    let rest = rest.strip_prefix(':')?;
    Some((key, js_trim(rest).to_string()))
}

/// `s.replace(/^["']|["']$/g, '')`：去掉一个前引号和一个后引号。
fn unquote(s: &str) -> String {
    let is_quote = |c: char| c == '"' || c == '\'';
    let s = s.strip_prefix(is_quote).unwrap_or(s);
    let s = s.strip_suffix(is_quote).unwrap_or(s);
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_frontmatter_returns_body_verbatim() {
        let parsed = parse("# 标题\n正文");
        assert_eq!(parsed.meta, FrontmatterMeta::default());
        assert_eq!(parsed.body, "# 标题\n正文");
    }

    #[test]
    fn parses_inline_arrays_and_booleans() {
        let parsed =
            parse("---\ncategory: 原创作品\ntags: [科幻, \"太空\", '']\nisopen: false\n---\n正文");
        assert_eq!(parsed.meta.category.as_deref(), Some("原创作品"));
        assert_eq!(parsed.meta.tags, Some(vec!["科幻".into(), "太空".into()]));
        assert_eq!(parsed.meta.isopen, Some(false));
        assert_eq!(parsed.body, "正文");
    }

    #[test]
    fn list_items_attach_to_previous_empty_key() {
        let parsed = parse("---\ntags:\n  - 科幻\n  - \"太空\"\ncategory: 活动\n---\nbody");
        assert_eq!(parsed.meta.tags, Some(vec!["科幻".into(), "太空".into()]));
        assert_eq!(parsed.meta.category.as_deref(), Some("活动"));
    }

    #[test]
    fn unclosed_frontmatter_swallows_the_body() {
        // 1.x 的 `lines.slice(i + 1)` 在 i == lines.length 时是空数组。
        let parsed = parse("---\ncategory: x\n正文");
        assert_eq!(parsed.meta.category.as_deref(), Some("x"));
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn leading_blank_lines_after_frontmatter_are_dropped() {
        let parsed = parse("---\ncategory: x\n---\n\n\n正文");
        assert_eq!(parsed.body, "正文");
    }

    #[test]
    fn comments_and_unknown_keys_are_ignored() {
        let parsed = parse("---\n# 注释\nauthor: 某某\ncategory: 原创\n---\n正文");
        assert_eq!(parsed.meta.category.as_deref(), Some("原创"));
        assert_eq!(parsed.meta.tags, None);
    }

    #[test]
    fn unquote_removes_one_quote_on_each_side() {
        assert_eq!(unquote("\"x\""), "x");
        assert_eq!(unquote("'x'"), "x");
        assert_eq!(unquote("\"x'"), "x");
        assert_eq!(unquote("x"), "x");
    }
}
