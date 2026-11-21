//! mdurl 的等价移植（markdown-it 15 的依赖，版本 2.1.0）。
//!
//! 只做 `normalizeLink` / `normalizeLinkText` 用得到的那部分：
//! `parse(url, slashesDenoteHost=true)`、`format`、`encode(defaultChars)`、`decode(defaultChars + '%')`。
//! 主机名的 punycode 走 idna（JS 侧是 punycode.js 的 toASCII/toUnicode）。

/// mdurl 的 encode.defaultChars
const ENCODE_CHARS: &str = ";/?:@&=+$,-_.!~*'()#";
/// mdurl 的 decode.defaultChars + '%'（normalizeLinkText 的用法）
const DECODE_CHARS: &str = ";/?:@&=+$,#%";

#[derive(Debug, Default)]
pub struct Url {
    pub protocol: Option<String>,
    pub slashes: bool,
    pub auth: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<String>,
    pub pathname: Option<String>,
    pub search: Option<String>,
    pub hash: Option<String>,
}

fn is_slashed_proto(p: &str) -> bool {
    matches!(
        p.to_ascii_lowercase().as_str(),
        "http:"
            | "https:"
            | "ftp:"
            | "gopher:"
            | "file:"
            | "http"
            | "https"
            | "ftp"
            | "gopher"
            | "file"
    )
}

fn is_hostless_proto(p: &str) -> bool {
    matches!(
        p.to_ascii_lowercase().as_str(),
        "javascript:" | "javascript"
    )
}

/// 复刻 `urlParse(url, true)`；主机名合法性校验（mdurl 里那段用 'x' 探测的分支）省略，
/// 因为它只在 host 含非 ASCII 时改写 hostname，而 punycode 之前 mdurl 保留原文（见 mdurl 源码 456-500 行）。
pub fn parse(url: &str) -> Url {
    let mut u = Url::default();
    let mut rest = url.trim().to_string();

    // protocolPattern = /^([a-z0-9.+-]+:)/i
    if let Some(colon) = rest.find(':') {
        let cand = &rest[..colon];
        if !cand.is_empty()
            && cand
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
        {
            u.protocol = Some(rest[..=colon].to_string());
            rest = rest[colon + 1..].to_string();
        }
    }

    let lower_proto = u.protocol.as_deref().map(|p| p.to_ascii_lowercase());

    // slashes = rest.substr(0,2) === '//'，且 (proto && hostlessProtocol[proto]) 时不算
    let hostless = lower_proto
        .as_deref()
        .map(is_hostless_proto)
        .unwrap_or(false);
    if rest.starts_with("//") && !hostless {
        rest = rest[2..].to_string();
        u.slashes = true;
    }

    let slashed = lower_proto
        .as_deref()
        .map(is_slashed_proto)
        .unwrap_or(false);
    let has_host = !hostless && (u.slashes || (u.protocol.is_some() && !slashed));

    if has_host {
        // hostEndingChars = ['/', '?', '#']
        let host_end = ['/', '?', '#'].iter().filter_map(|c| rest.find(*c)).min();

        // atSign：hostEnd 之前（含）最后一个 '@'；没有 hostEnd 则是全文最后一个 '@'
        let at_sign = match host_end {
            None => rest.rfind('@'),
            Some(he) => rest[..=he.min(rest.len().saturating_sub(1))].rfind('@'),
        };
        if let Some(at) = at_sign {
            u.auth = Some(rest[..at].to_string());
            rest = rest[at + 1..].to_string();
        }

        // nonHostChars = ['%','/','?',';','#'] + autoEscape（unwise + 单引号）
        let mut non_host: Vec<char> = vec!['%', '/', '?', ';', '#', '\''];
        non_host.extend(['<', '>', '"', '`', ' ', '{', '}', '|', '\\', '^', '[', ']']);
        let host_end2 = rest
            .char_indices()
            .find(|(_, c)| non_host.contains(c))
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let mut host = rest[..host_end2].to_string();
        rest = rest[host_end2..].to_string();
        if host.ends_with(':') {
            host.pop();
        }
        // parseHost：portPattern = /:[0-9]*$/
        if let Some(colon) = host.rfind(':') {
            let port_cand = &host[colon + 1..];
            if port_cand.chars().all(|c| c.is_ascii_digit()) {
                if !port_cand.is_empty() {
                    u.port = Some(port_cand.to_string());
                }
                host.truncate(colon);
            }
        }
        if !host.is_empty() {
            let ipv6 = host.starts_with('[') && host.ends_with(']');
            if ipv6 {
                u.hostname = Some(host[1..host.len() - 1].to_string());
            } else {
                u.hostname = Some(host);
            }
        } else {
            u.hostname = Some(String::new());
        }
    }

    // hash → search → pathname
    if let Some(h) = rest.find('#') {
        u.hash = Some(rest[h..].to_string());
        rest.truncate(h);
    }
    if let Some(q) = rest.find('?') {
        u.search = Some(rest[q..].to_string());
        rest.truncate(q);
    }
    if !rest.is_empty() {
        u.pathname = Some(rest);
    }
    u
}

pub fn format(u: &Url) -> String {
    let mut result = String::new();
    if let Some(p) = &u.protocol {
        result.push_str(p);
    }
    if u.slashes {
        result.push_str("//");
    }
    if let Some(a) = &u.auth {
        result.push_str(a);
        result.push('@');
    }
    if let Some(h) = &u.hostname {
        if h.contains(':') {
            result.push('[');
            result.push_str(h);
            result.push(']');
        } else {
            result.push_str(h);
        }
    }
    if let Some(p) = &u.port {
        result.push(':');
        result.push_str(p);
    }
    if let Some(p) = &u.pathname {
        result.push_str(p);
    }
    if let Some(s) = &u.search {
        result.push_str(s);
    }
    if let Some(h) = &u.hash {
        result.push_str(h);
    }
    result
}

fn hex2(b: u8) -> String {
    format!("%{:02X}", b)
}

/// `mdurl.encode(string)`：保留已在 escape 序列里的 %XX，ASCII 只放行字母数字 + defaultChars。
pub fn encode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            let a = bytes[i + 1];
            let c = bytes[i + 2];
            if a.is_ascii_hexdigit() && c.is_ascii_hexdigit() {
                out.push_str(&s[i..i + 3].to_ascii_uppercase());
                i += 3;
                continue;
            }
        }
        if b.is_ascii() {
            let ch = b as char;
            if ch.is_ascii_alphanumeric() || ENCODE_CHARS.contains(ch) {
                out.push(ch);
            } else {
                out.push_str(&hex2(b));
            }
            i += 1;
            continue;
        }
        // 非 ASCII：按 UTF-8 逐字符 percent-encode（JS 侧是 encodeURIComponent，等价）
        let ch_len = utf8_len(b);
        for k in 0..ch_len {
            out.push_str(&hex2(bytes[i + k]));
        }
        i += ch_len;
    }
    out
}

/// `mdurl.decode(string, decode.defaultChars + '%')`：多字节序列（3/4 字节）按 mdurl 的实现退化为 U+FFFD。
pub fn decode_keep(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // 收集连续的 %XX 序列
            let mut j = i;
            let mut seq: Vec<u8> = vec![];
            while j + 2 < bytes.len() && bytes[j] == b'%' {
                let h = &s[j + 1..j + 3];
                match u8::from_str_radix(h, 16) {
                    Ok(v) => seq.push(v),
                    Err(_) => break,
                }
                j += 3;
            }
            if !seq.is_empty() {
                let mut k = 0;
                while k < seq.len() {
                    let b1 = seq[k];
                    if b1 < 0x80 {
                        let ch = b1 as char;
                        if DECODE_CHARS.contains(ch) {
                            out.push_str(&hex2(b1));
                        } else {
                            out.push(ch);
                        }
                        k += 1;
                        continue;
                    }
                    if b1 & 0xE0 == 0xC0 && k + 1 < seq.len() && seq[k + 1] & 0xC0 == 0x80 {
                        let b2 = seq[k + 1];
                        let cp = (((b1 as u32) << 6) & 0x7C0) | ((b2 as u32) & 0x3F);
                        if cp < 0x80 {
                            out.push('\u{fffd}');
                            out.push('\u{fffd}');
                        } else if let Some(c) = char::from_u32(cp) {
                            out.push(c);
                        } else {
                            out.push('\u{fffd}');
                        }
                        k += 2;
                        continue;
                    }
                    out.push('\u{fffd}');
                    k += 1;
                }
                i = j;
                continue;
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&s[i..i + ch_len]);
        i += ch_len;
    }
    out
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// punycode.js 的 `toASCII`/`toUnicode`：逐标签处理，纯 ASCII 标签**原样保留**
/// （包括大小写），只有非 ASCII 标签才编码成 `xn--…` / 解回 unicode。
/// 不能直接用 `idna::domain_to_ascii(&host)`：IDNA 会把 `UPPER.CASE` 小写成
/// `upper.case`，而 1.x（punycode.toASCII）不改 ASCII 标签的大小写。
fn recode_host(host: &str, to_ascii: bool) -> String {
    if to_ascii && host.is_ascii() {
        return host.to_string();
    }
    if !to_ascii
        && !host
            .split('.')
            .any(|l| l.len() >= 4 && l.as_bytes()[..4].eq_ignore_ascii_case(b"xn--"))
    {
        return host.to_string();
    }
    let mut labels = Vec::new();
    for label in host.split('.') {
        if label.is_ascii() {
            labels.push(label.to_string());
            continue;
        }
        let mapped = if to_ascii {
            idna::domain_to_ascii(label).unwrap_or_else(|_| label.to_string())
        } else {
            idna::domain_to_unicode(label).0
        };
        labels.push(mapped);
    }
    labels.join(".")
}

/// `md.normalizeLink(url)` = encode(format(parse(url, true))) + hostname punycode。
pub fn normalize_link(url: &str) -> String {
    let mut u = parse(url);
    let recode = match u.protocol.as_deref() {
        None => true,
        Some(p) => matches!(
            p.to_ascii_lowercase().as_str(),
            "http:" | "https:" | "mailto:"
        ),
    };
    if recode
        && let Some(h) = u.hostname.clone()
        && !h.is_empty()
    {
        u.hostname = Some(recode_host(&h, true));
    }
    encode(&format(&u))
}

/// `md.normalizeLinkText(url)` = decode(format(parse(url, true)), defaultChars + '%') + hostname punycode→unicode。
pub fn normalize_link_text(url: &str) -> String {
    let mut u = parse(url);
    let recode = match u.protocol.as_deref() {
        None => true,
        Some(p) => matches!(
            p.to_ascii_lowercase().as_str(),
            "http:" | "https:" | "mailto:"
        ),
    };
    if recode
        && let Some(h) = u.hostname.clone()
        && !h.is_empty()
    {
        u.hostname = Some(recode_host(&h, false));
    }
    decode_keep(&format(&u))
}
