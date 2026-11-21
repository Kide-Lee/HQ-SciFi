//! 同步领域规则（1.x `src/main/services/sync-service.ts` 的纯规则部分）。
//!
//! 这里只放**不碰 IO** 的东西：四态映射与文件名、内容哈希、正文标题提取、配图引用
//! 收集与本地图片文件名推导、提交参数的 JSON 编码。需要文件/网络的部分在
//! `services::sync` 与 `adapters::sync`。
//!
//! 逐字对齐的 1.x 锚点见每个函数的文档注释；与 1.x 的偏差都写在函数上（目前只有
//! 图片文件名兜底哈希：1.x 用 md5，Rust 依赖里没有 md5，改用 sha256 前 8 位，
//! 只影响「远端图片 URL 没有可用 basename」时的本地文件名，不影响发布内容）。

use std::sync::LazyLock;

use fancy_regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

use crate::domain::article::{ArticleRow, ArticleType};

/// `contentsList` 的每页条数（1.x `sync-service.ts:33`）。
pub const PAGE_SIZE: i64 = 50;

/// 远端状态 → 本地文件名的前缀（1.x `TYPE_FILE_PREFIX`）。
///
/// 草稿（`post_draft`）与本地（`local`）没有前缀。
pub fn type_file_prefix(article_type: ArticleType) -> Option<&'static str> {
    match article_type {
        ArticleType::Waiting => Some("待审核"),
        ArticleType::Post => Some("已发布"),
        ArticleType::Reject => Some("已拒绝"),
        ArticleType::PostDraft | ArticleType::Local => None,
    }
}

/// 本地文件名（1.x `localFileName(type,title)`）：`[待审核] 标题`；草稿/本地用纯标题。
pub fn local_file_name(article_type: ArticleType, title: &str) -> String {
    match type_file_prefix(article_type) {
        Some(prefix) => format!("[{prefix}] {title}"),
        None => title.to_string(),
    }
}

/// 一次拉取要枚举的远端「态」（1.x `pullRemote` 里的 `types` 表）。
///
/// 注意 `remote_type` 只是 `contentsList` 的 `type` 参数：待审/已发布/已拒绝在服务端
/// 都是 `type=post` + `status`，只有草稿是 `type=post_draft`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncKind {
    /// 落地到本地索引的文章态。
    pub article_type: ArticleType,
    /// `contentsList` 的 `type` 参数。
    pub remote_type: &'static str,
    /// `contentsList` 的 `status` 参数（草稿没有）。
    pub remote_status: Option<&'static str>,
}

/// 1.x `pullRemote` 的四态顺序：草稿 → 待审核 → 已发布 → 已拒绝（顺序决定 `errors` 与
/// `total` 的累加顺序，保持原样）。
pub const SYNC_KINDS: [SyncKind; 4] = [
    SyncKind {
        article_type: ArticleType::PostDraft,
        remote_type: "post_draft",
        remote_status: None,
    },
    SyncKind {
        article_type: ArticleType::Waiting,
        remote_type: "post",
        remote_status: Some("waiting"),
    },
    SyncKind {
        article_type: ArticleType::Post,
        remote_type: "post",
        remote_status: Some("publish"),
    },
    SyncKind {
        article_type: ArticleType::Reject,
        remote_type: "post",
        remote_status: Some("reject"),
    },
];

/// 拉取结果（1.x `PullResult`，`src/shared/domain/index.ts:125-133`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    /// 新建或覆盖的本地文件数。
    pub pulled: u32,
    /// 远端有更新但本地已修改、保留本地的冲突数。
    pub conflicts: u32,
    /// 拉取的远端条目总数（四类之和）。
    pub total: u32,
    /// 单条失败信息；1.x 用 `${remote}: ${msg}` 与 `${title}: ${msg}` 两种形态。
    pub errors: Vec<String>,
}

/// 推送结果（1.x `PushResult`）：**失败也是成功载荷**（`ok:false` + `error`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub ok: bool,
    /// 无 cid 的极端情况下 1.x 的 `cid` 是 undefined → 序列化时省略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    /// 推送后文章所处状态：`post_draft`（存草稿）或 `waiting`（已发布待审）。
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub article_type: Option<ArticleType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 远端文章转存草稿结果（1.x `ConvertDraftResult`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConvertDraftResult {
    /// `false` = 远端/本地索引本来就是草稿，没有调服务端转存。
    pub converted: bool,
}

/// 编辑远端文章结果（1.x `EditRemoteResult`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditRemoteResult {
    /// 同步到本地存档后的 md 文件绝对路径（编辑器直接打开）。
    pub file_path: String,
    /// 是否发生了服务端转存草稿（`false` = 原本就是草稿）。
    pub converted: bool,
}

/// 发布表单元数据（1.x `src/shared/frontmatter.ts:8-17` 的 `ArticleMeta`）。
///
/// v0.0.6 起 frontmatter 不再记录元数据，只由 `hqsf:sync-push` 的 `meta` 入参提供。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleMeta {
    /// 文章类型（category 名称，如「原创作品」）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 标签（tag 名称列表）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// 参加的活动（active 名称；缺省 = 不参加）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    /// 是否公开阅读（缺省 true，与荒启默认一致）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isopen: Option<bool>,
}

/// 元数据名称解析成 mid 之后的提交参数（`resolveMetaParams` 的返回值）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushMetaParams {
    pub category: Option<String>,
    /// 逗号分隔的 tag mid 串（服务端约定）。
    pub tag: Option<String>,
    pub active: Option<String>,
    pub isopen: Option<bool>,
}

/// 内容哈希（1.x `contentHash`）：sha256 hex，用于判断本地是否已修改。
pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 正文标题（1.x `resolveTitle` 的标题分支）：
/// 第一条匹配 `/^#\s+\S/` 的行，去掉 `#` 与前导空白后再 trim。
///
/// 没有标题行时返回 `None`，调用方回退到文件名（`sanitizeFileName(titleFromPath(...))`）。
pub fn heading_title(content: &str) -> Option<String> {
    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix('#') else {
            continue;
        };
        // JS `/^#\s+\S/`：`#` 后面必须至少一个空白，再至少一个非空白。
        let mut chars = rest.chars();
        let Some(first) = chars.next() else { continue };
        if !first.is_whitespace() {
            continue;
        }
        if chars.next().is_none() {
            continue;
        }
        // `replace(/^#\s+/,'').trim()`：去掉 `#` 与紧随的空白，再整体 trim。
        return Some(rest.trim_start().trim().to_string());
    }
    None
}

/// 是否 http(s) 图片（1.x `isHttpImage = /^https?:\/\//i`）。
pub fn is_http_image(reference: &str) -> bool {
    let lower = reference.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 是否本地配图引用（1.x `isLocalImageRef`）。
pub fn is_local_image_ref(reference: &str) -> bool {
    reference.contains("/.image/")
        || reference.starts_with(".image/")
        || reference.starts_with("./.image/")
}

/// md 图片语法（1.x `IMG_MD_RE`）。
const IMG_MD_PATTERN: &str = r"!\[[^\]]*\]\(([^)\s]+)\)";
/// 正文里残留的 `<img src="...">`（1.x `IMG_HTML_RE`）。
const IMG_HTML_PATTERN: &str = r#"<img[^>]+src="([^"]+)""#;

/// 收集正文里的图片引用（1.x `collectImageRefs`）：先 md 语法，再 `<img>`，
/// 去重且保持首次出现顺序。
pub fn collect_image_refs(markdown: &str) -> Vec<String> {
    static IMG_MD_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(IMG_MD_PATTERN).expect("IMG_MD_PATTERN 必须是合法正则"));
    static IMG_HTML_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(IMG_HTML_PATTERN).expect("IMG_HTML_PATTERN 必须是合法正则"));

    let mut refs: Vec<String> = Vec::new();
    let mut push = |reference: &str| {
        if !refs.iter().any(|existing| existing == reference) {
            refs.push(reference.to_string());
        }
    };
    for captures in IMG_MD_RE.captures_iter(markdown).flatten() {
        if let Some(found) = captures.get(1) {
            push(found.as_str());
        }
    }
    for captures in IMG_HTML_RE.captures_iter(markdown).flatten() {
        if let Some(found) = captures.get(1) {
            push(found.as_str());
        }
    }
    refs
}

/// 远端图片落盘时的文件名（1.x `pullArticleImages` 内的 `filename` 推导）：
/// `basename(decodeURIComponent(new URL(url).pathname))` 把 `\/:*?"<>|` 换成 `_`。
///
/// 兜底：结果为空时 1.x 用 `img-${md5(url).slice(0,8)}`；Rust 无 md5 依赖，
/// 改用 `img-${sha256(url)[..8]}`（偏差：仅文件名不同，引用与内容不受影响）。
pub fn image_file_name(url: &str) -> String {
    let pathname = url_pathname(url);
    let decoded = percent_decode(&pathname);
    let base = decoded.rsplit('/').next().unwrap_or_default();
    let sanitized: String = base
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    if !sanitized.is_empty() {
        return sanitized;
    }
    let hash = content_hash(url);
    format!("img-{}", &hash[..8])
}

/// `new URL(url).pathname` 的近似：去掉 `scheme://host`，截到 `?`/`#` 之前。
fn url_pathname(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return String::new();
    };
    let rest = &url[scheme_end + 3..];
    let path = match rest.find('/') {
        Some(index) => &rest[index..],
        None => "/",
    };
    let end = path.find(['?', '#']).unwrap_or(path.len());
    path[..end].to_string()
}

/// `decodeURIComponent` 的近似：`%XX` 逐步解码成 UTF-8；非法序列保留原样字符。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 提交（`contentsAdd`/`contentsUpdate`）的 `params` 字段：`JSON.stringify(params)`。
///
/// 字段顺序逐字对齐 1.x：`title` → `cid`（有才传）→ `category` → `tag` → `active`
/// → `isopen`（`true`→1、`false`→0 的数字，不是布尔）。
pub fn push_params_json(title: &str, cid: Option<&str>, meta: &PushMetaParams) -> String {
    let mut parts: Vec<String> = vec![format!("\"title\":{}", json_string(title))];
    if let Some(cid) = cid {
        parts.push(format!("\"cid\":{}", json_string(cid)));
    }
    if let Some(category) = &meta.category {
        parts.push(format!("\"category\":{}", json_string(category)));
    }
    if let Some(tag) = &meta.tag {
        parts.push(format!("\"tag\":{}", json_string(tag)));
    }
    if let Some(active) = &meta.active {
        parts.push(format!("\"active\":{}", json_string(active)));
    }
    if let Some(isopen) = meta.isopen {
        parts.push(format!("\"isopen\":{}", if isopen { 1 } else { 0 }));
    }
    format!("{{{}}}", parts.join(","))
}

/// 转存草稿（`updateToDraft`）的 `params`：只含 `cid` 与 `title`。
pub fn update_draft_params_json(cid: &str, title: &str) -> String {
    format!(
        "{{\"cid\":{},\"title\":{}}}",
        json_string(cid),
        json_string(title)
    )
}

/// `JSON.stringify(string)`（不含外层引号差异）。
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// 空 `PullResult`（便于测试与默认值语义显式化）。
pub fn empty_pull_result() -> PullResult {
    PullResult::default()
}

/// 索引态与远端态是否一致（1.x `existing.type!==type||existing.status!==status`）。
pub fn state_differs(row: &ArticleRow, article_type: ArticleType, status: &str) -> bool {
    row.article_type != article_type || row.status != status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_file_name_matches_type_prefixes() {
        assert_eq!(
            local_file_name(ArticleType::Waiting, "标题"),
            "[待审核] 标题"
        );
        assert_eq!(local_file_name(ArticleType::Post, "标题"), "[已发布] 标题");
        assert_eq!(
            local_file_name(ArticleType::Reject, "标题"),
            "[已拒绝] 标题"
        );
        assert_eq!(local_file_name(ArticleType::PostDraft, "标题"), "标题");
        assert_eq!(local_file_name(ArticleType::Local, "标题"), "标题");
    }

    #[test]
    fn sync_kinds_match_1x_pull_table() {
        let names: Vec<_> = SYNC_KINDS
            .iter()
            .map(|kind| (kind.article_type, kind.remote_type, kind.remote_status))
            .collect();
        assert_eq!(
            names,
            vec![
                (ArticleType::PostDraft, "post_draft", None),
                (ArticleType::Waiting, "post", Some("waiting")),
                (ArticleType::Post, "post", Some("publish")),
                (ArticleType::Reject, "post", Some("reject")),
            ]
        );
    }

    #[test]
    fn content_hash_is_sha256_hex() {
        assert_eq!(
            content_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn heading_title_picks_first_level_one_heading() {
        assert_eq!(
            heading_title("前言\n# 标题一  \n## 子标题\n正文"),
            Some("标题一".to_string())
        );
        assert_eq!(heading_title("## 不是一级\n正文"), None);
        assert_eq!(heading_title("#\n正文"), None);
        assert_eq!(heading_title("无标题"), None);
        // `#标题` 没有空白，不算（JS `/^#\s+\S/`）。
        assert_eq!(heading_title("#标题"), None);
        // CRLF 也要认。
        assert_eq!(heading_title("# 标题\r\n正文"), Some("标题".to_string()));
    }

    #[test]
    fn collect_image_refs_dedupes_md_then_html_order() {
        let md = "![a](http://x/a.png) <img src=\"http://x/b.png\"> ![b](http://x/a.png)";
        assert_eq!(
            collect_image_refs(md),
            vec!["http://x/a.png".to_string(), "http://x/b.png".to_string()]
        );
    }

    #[test]
    fn image_helpers_match_1x_checks() {
        assert!(is_http_image("HTTP://x/a.png"));
        assert!(!is_http_image("/local/a.png"));
        assert!(is_local_image_ref("./.image/1/a.png"));
        assert!(is_local_image_ref(".image/1/a.png"));
        assert!(is_local_image_ref("x/.image/1/a.png"));
        assert!(!is_local_image_ref("http://x/a.png"));
    }

    #[test]
    fn image_file_name_uses_basename_and_sanitizes() {
        assert_eq!(
            image_file_name("https://cdn.example.com/pics/a%20b.png?x=1"),
            "a b.png"
        );
        assert_eq!(
            image_file_name("https://cdn.example.com/pics/a:b*c.png"),
            "a_b_c.png"
        );
        // 没有 basename（URL 以 / 结尾）→ img-<hash8>。
        let fallback = image_file_name("https://cdn.example.com/pics/");
        assert!(fallback.starts_with("img-"), "{fallback}");
        assert_eq!(fallback.len(), 12);
    }

    #[test]
    fn push_params_json_keeps_1x_field_order() {
        let meta = PushMetaParams {
            category: Some("1".to_string()),
            tag: Some("2,3".to_string()),
            active: Some("4".to_string()),
            isopen: Some(false),
        };
        assert_eq!(
            push_params_json("标题", Some("99"), &meta),
            r#"{"title":"标题","cid":"99","category":"1","tag":"2,3","active":"4","isopen":0}"#
        );
        assert_eq!(
            push_params_json("标题", None, &PushMetaParams::default()),
            r#"{"title":"标题"}"#
        );
        assert_eq!(
            update_draft_params_json("99", "标题"),
            r#"{"cid":"99","title":"标题"}"#
        );
    }

    #[test]
    fn push_result_wire_shape_omits_absent_optionals() {
        let value = serde_json::to_value(PushResult {
            ok: true,
            cid: Some("7".into()),
            article_type: Some(ArticleType::PostDraft),
            error: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "ok": true, "cid": "7", "type": "post_draft" })
        );
    }
}
