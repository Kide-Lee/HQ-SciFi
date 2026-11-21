//! linkify-it 6.1.0 的移植（markdown-it 15 用它做裸链接识别，默认选项：fuzzyLink=false、fuzzyEmail=true、tlds 默认表、urlAuth=false）。
//!
//! 关键点在「正则源」：正则不是手写的，而是由 linkify-it 的 `REBuilder` 在运行时拼出来的。
//! 为了不靠猜，本文件的正则源由 `spikes/md/gen-linkify-regex.mjs` 从**真实的** linkify-it 实例
//! （markdown-it 内部 `new LinkifyIt()` 用的同一份 build）导出成 `linkify-regex.json`，
//! 这里只做 JS→Rust 正则语法的等价转换（`\uXXXX`→`\u{XXXX}`、`\0`→`\x00`、`\/`→`/`）再用 fancy-regex 编译。
//!
//! 匹配流程复刻 linkify-it 的 `match()`（fuzzyLink 关闭时该循环退化为「schema 候选 vs fuzzy email 候选取最早」），
//! 输出再走 markdown-it 的 `normalizeLink` / `normalizeLinkText`（见 mdurl.rs）。
use fancy_regex::Regex;
use serde_json::Value;

use super::mdurl;

#[derive(Debug, Clone)]
pub struct Found {
    pub start: usize,
    pub end: usize,
    #[allow(dead_code)]
    // 保留 linkify-it `match()` 的完整返回值（markdown-it 后处理里 schema 分支已内联到 text）。
    pub schema: String,
    pub url: String,
    pub text: String,
}

pub struct Linkifier {
    schema_search: Regex,
    schema_plain: Regex,
    mail_host_search: Regex,
    mail_name_validator: Regex,
    http_validator: Regex,
    relative_proto_validator: Regex,
    mailto_validator: Regex,
}

fn js_to_rust_re(src: &str, flags: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            match n {
                'u' => {
                    if i + 5 < chars.len()
                        && chars[i + 2..i + 6].iter().all(|c| c.is_ascii_hexdigit())
                    {
                        out.push_str("\\u{");
                        for k in 2..6 {
                            out.push(chars[i + k]);
                        }
                        out.push('}');
                        i += 6;
                        continue;
                    }
                    out.push_str("\\u");
                    i += 2;
                    continue;
                }
                '0' => {
                    out.push_str("\\x00");
                    i += 2;
                    continue;
                }
                '/' => {
                    out.push('/');
                    i += 2;
                    continue;
                }
                _ => {
                    out.push('\\');
                    out.push(n);
                    i += 2;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    if flags.contains('i') {
        format!("(?i){out}")
    } else {
        out
    }
}

fn build(table: &Value, name: &str) -> Regex {
    let e = &table[name];
    let src = js_to_rust_re(
        e["source"].as_str().unwrap_or(""),
        e["flags"].as_str().unwrap_or(""),
    );
    match Regex::new(&src) {
        Ok(r) => r,
        Err(err) => panic!(
            "linkify regex `{name}` 编译失败: {err}\n源: {}",
            &src[..src.len().min(200)]
        ),
    }
}

impl Linkifier {
    pub fn new() -> Self {
        let table: Value = serde_json::from_str(include_str!("linkify-regex.json"))
            .expect("linkify-regex.json 由 gen-linkify-regex.mjs 生成");
        Linkifier {
            schema_search: build(&table, "schema_search"),
            schema_plain: build(&table, "schema_plain"),
            mail_host_search: build(&table, "fuzzy_mail_host_search"),
            mail_name_validator: build(&table, "mail_name_validator"),
            http_validator: build(&table, "http_validator"),
            relative_proto_validator: build(&table, "relative_proto_validator"),
            mailto_validator: build(&table, "mailto_validator"),
        }
    }

    /// 相当于 linkify-it 的 `schema.validate(text, pos)`（`y` 标志 → 从 pos 起必须命中）。
    fn validate_at(&self, re: &Regex, text: &str, pos: usize) -> usize {
        if pos > text.len() {
            return 0;
        }
        match re.find(&text[pos..]) {
            Ok(Some(m)) if m.start() == 0 => m.end(),
            _ => 0,
        }
    }

    fn test_schema_at(&self, text: &str, schema: &str, pos: usize) -> usize {
        match schema.to_ascii_lowercase().as_str() {
            "http:" | "https:" | "ftp:" => self.validate_at(&self.http_validator, text, pos),
            "//" => {
                // JS 用 text[pos-3]（UTF-16 单位）比较；这里用字节比较，避免切在多字节字符中间
                if pos >= 3 {
                    let p3 = text.as_bytes()[pos - 3];
                    if p3 == b':' || p3 == b'/' {
                        return 0;
                    }
                }
                self.validate_at(&self.relative_proto_validator, text, pos)
            }
            "mailto:" => self.validate_at(&self.mailto_validator, text, pos),
            _ => 0,
        }
    }

    fn schema_candidates(&self, text: &str) -> Vec<(usize, usize, String)> {
        // schema_search = (^|(?!_)边界)(schema)：group1 是边界（可能为空），group2 是 schema 前缀
        let mut out: Vec<(usize, usize, String)> = vec![];
        let mut seen: Vec<usize> = vec![];
        for caps in self.schema_search.captures_iter(text).flatten() {
            if let Some(m2) = caps.get(2) {
                out.push((
                    m2.start(),
                    caps.get(0).unwrap().end(),
                    m2.as_str().to_string(),
                ));
                seen.push(m2.start());
            }
        }
        // markdown-it 的 inline linkify 规则更宽松：只要 scheme 前一个字符不是 [a-z0-9.+-] 也会生成链接
        // （例如 `中文https://cn.com` 在 core 规则下不成立，但 inline 规则成立）。
        for caps in self.schema_plain.captures_iter(text).flatten() {
            let Some(m) = caps.get(0) else { continue };
            let idx = m.start();
            if seen.contains(&idx) {
                continue;
            }
            let ok = idx == 0 || {
                let prev = text[..idx].chars().next_back().unwrap_or(' ');
                !(prev.is_ascii_alphanumeric() || matches!(prev, '.' | '+' | '-'))
            };
            if ok {
                out.push((idx, m.end(), m.as_str().to_string()));
                seen.push(idx);
            }
        }
        out.sort_by_key(|c| c.0);
        out
    }

    fn email_candidates(&self, text: &str) -> Vec<(usize, usize)> {
        let mut out = vec![];
        for m in self.mail_host_search.find_iter(text).flatten() {
            // JS 是 text.slice(max(0, index-65), index)（按 UTF-16 单位）；这里按字节回退并落到字符边界
            let mut win_start = m.start().saturating_sub(65);
            while win_start > 0 && !text.is_char_boundary(win_start) {
                win_start -= 1;
            }
            let win = &text[win_start..m.start()];
            if let Ok(Some(caps)) = self.mail_name_validator.captures(win)
                && let Some(name) = caps.get(1)
                && !name.as_str().is_empty()
            {
                out.push((m.start() - name.as_str().len(), m.end()));
            }
        }
        out
    }

    pub fn find(&self, text: &str) -> Vec<Found> {
        if text.is_empty() || !text.contains(':') && !text.contains('@') && !text.contains("//") {
            return vec![];
        }
        let schemas = self.schema_candidates(text);
        let emails = self.email_candidates(text);
        let mut result: Vec<Found> = vec![];
        let mut pos = 0usize;
        let mut si = 0usize;
        let mut ei = 0usize;
        loop {
            // 下一个有效 schema 候选（index >= pos 且尾部校验通过）
            let mut schema_cand: Option<(usize, usize, String)> = None;
            while si < schemas.len() {
                let (idx, last, schema) = schemas[si].clone();
                if idx < pos {
                    si += 1;
                    continue;
                }
                let len = self.test_schema_at(text, &schema, last);
                if len == 0 {
                    si += 1;
                    continue;
                }
                schema_cand = Some((idx, last + len, schema));
                break;
            }
            // 下一个 email 候选
            let mut email_cand: Option<(usize, usize)> = None;
            while ei < emails.len() {
                let (idx, last) = emails[ei];
                if idx < pos {
                    ei += 1;
                    continue;
                }
                email_cand = Some((idx, last));
                break;
            }

            let mut cand: Option<(usize, usize, String)> = schema_cand;
            if let Some((eidx, elast)) = email_cand {
                match &cand {
                    None => cand = Some((eidx, elast, "mailto:".into())),
                    Some((cidx, clast, _)) => {
                        if eidx < *cidx || (eidx == *cidx && elast > *clast) {
                            cand = Some((eidx, elast, "mailto:".into()));
                        }
                    }
                }
            }
            let Some((idx, last, schema)) = cand else {
                break;
            };
            // 消费被选中的候选
            while si < schemas.len() && schemas[si].0 <= idx {
                if schemas[si].0 == idx && schemas[si].1 == last {
                    si += 1;
                    break;
                }
                si += 1;
            }
            while ei < emails.len() && emails[ei].0 <= idx {
                ei += 1;
            }

            let raw = &text[idx..last];
            // 复刻 markdown-it rules_core/linkify：url 与 text 分开归一化
            let is_mailto = !schema.is_empty() && schema.eq_ignore_ascii_case("mailto:");
            let url = if is_mailto && !raw.to_ascii_lowercase().starts_with("mailto:") {
                format!("mailto:{raw}")
            } else {
                raw.to_string()
            };
            let full_url = mdurl::normalize_link(&url);
            // markdown-it 的 linkify core rule 会做 validateLink；本项目配置下不会命中 BAD_PROTO
            let text_out = if is_mailto && !raw.to_ascii_lowercase().starts_with("mailto:") {
                mdurl::normalize_link_text(&url)
                    .strip_prefix("mailto:")
                    .unwrap_or_default()
                    .to_string()
            } else {
                mdurl::normalize_link_text(raw)
            };
            result.push(Found {
                start: idx,
                end: last,
                schema,
                url: full_url,
                text: text_out,
            });
            pos = last;
            if pos >= text.len() {
                break;
            }
        }
        result
    }
}

impl Default for Linkifier {
    fn default() -> Self {
        Self::new()
    }
}
