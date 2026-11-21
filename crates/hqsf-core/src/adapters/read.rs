//! 阅读侧适配层：远端 JSON → 渲染层结构（原 `src/main/adapters/read.adapter.ts`，
//! 1,031 行，本 lane 的主要工作量）。
//!
//! 平移原则（与 1.x 逐字段一致，不"顺手改进"）：
//! - 每条 item 都是 `Record<string, unknown>`：字段可能缺失、可能是字符串或数字，
//!   所以入参用 `&serde_json::Value` 手工取值，而不是强类型 `Deserialize`（强类型会在
//!   类型抖动时让整条失败，与 1.x 的 `num/str/boolish` 容错语义冲突）；
//! - 输出结构 `Serialize + specta::Type + camelCase`，字段名与 `src/shared/domain` 一致；
//! - passthrough 的 JSON（`authorInfo` / `userJson` / `active`…）用本地 [`Json`] 枚举，
//!   因为 specta 未开 `serde_json` feature，`serde_json::Value` 没有 `Type` 实现。
//!
//! 分层偏差（已报 lead 批准）：本模块直接收 `&CoreCtx`，内部经
//! [`crate::services::net`] 取 token / API 配置；`sanitize_*` 也留在这里，因为
//! `domain` 不能反向依赖 adapters 的输出类型。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::ctx::CoreCtx;
use crate::domain::review as review_rules;
use crate::error::{CoreError, CoreResult};
use crate::infra::net::api::{ApiOptions, ApiResponse};
use crate::infra::net::config::endpoints;
use crate::services::net;

/// 列表默认每页条数（`read.adapter.ts:34`）。
pub const PAGE_SIZE: i64 = 20;

/// 文章详情缓存的硬过期（`read.adapter.ts:534`）：10 分钟。
///
/// 1.x 的 notes：24h 滑动 TTL 会让常读文章永远不刷新，作者更新后客户端一直显示旧版。
pub const ARTICLE_CACHE_MAX_AGE_MS: i64 = 10 * 60 * 1000;

/// 活动 mid / 文章元数据的缓存 TTL（1.x 模块级内存缓存 5 分钟）。
pub const META_CACHE_TTL_MS: i64 = 5 * 60 * 1000;

/// 单篇元数据补全的超时（`read.adapter.ts:170`）。
///
/// 1.x 用 `withTimeout` 包住整个 promise（超时后原请求继续后台跑）；Rust 侧把
/// 超时下压到 HTTP 传输层（`HttpRequest.timeout_ms`），效果等价且不会有悬挂任务。
pub const ANON_META_TIMEOUT_MS: u64 = 3000;

/// 阅读缓存 key 的前缀（`read.adapter.ts:530` 的 `article:${uidKey}:${cid}`）。
const ARTICLE_CACHE_KEY_PREFIX: &str = "article:";

/// 进行中活动 mid 集合的缓存 key（1.x 是模块级内存缓存，这里落到 `meta` 表）。
const ONGOING_MIDS_CACHE_KEY: &str = "read:ongoing-review-mids";

/// 文章元数据（评论脱敏用）的缓存 key 前缀。
const ARTICLE_META_CACHE_PREFIX: &str = "read:article-meta:";

// ---------- passthrough JSON ----------

/// 任意 JSON 值（替代 `Record<string, unknown>` 等 passthrough 字段）。
///
/// specta 只在开启 `serde_json` feature 时给 `serde_json::Value` 实现 `Type`，
/// 而 workspace 依赖只开了 `derive`（不能改 `Cargo.toml`），所以这里自建一个
/// untagged 枚举：导出的 TS 是 `null | boolean | number | string | Json[] | Record<string, Json>`，
/// 语义最接近 1.x 的 `Record<string, unknown>`。
///
/// 偏差：内部用 [`BTreeMap`]，JSON 对象的 key 会被排序（1.x 保持插入序）；
/// 渲染层只按键取值，不影响行为。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    Array(Vec<Json>),
    Object(JsonObject),
}

/// JSON 对象（1.x `Record<string, unknown>`）。
pub type JsonObject = BTreeMap<String, Json>;

impl Json {
    /// `serde_json::Value` → [`Json`]。
    pub fn from_value(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(b) => Self::Bool(*b),
            Value::Number(n) => match n.as_i64() {
                Some(i) => Self::Int(i),
                None => Self::Float(n.as_f64().unwrap_or_default()),
            },
            Value::String(s) => Self::String(s.clone()),
            Value::Array(items) => Self::Array(items.iter().map(Self::from_value).collect()),
            Value::Object(map) => Self::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), Self::from_value(v)))
                    .collect(),
            ),
        }
    }

    /// 对象视图（非对象返回 `None`）。
    pub fn as_object(&self) -> Option<&JsonObject> {
        match self {
            Self::Object(o) => Some(o),
            _ => None,
        }
    }

    /// 转回 `serde_json::Value`（命令入参是 [`Json`]，规整逻辑仍按 1.x 的
    /// `Record<string, unknown>` 语义在 `Value` 上做）。
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// `number | string` 的 ID（1.x `mid?: number | string`、`activeid?: number | string`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum StrOrNum {
    Number(i64),
    Text(String),
}

impl StrOrNum {
    /// 统一成字符串（1.x 里的 `String(mid)`）。
    pub fn as_id(&self) -> String {
        match self {
            Self::Number(n) => n.to_string(),
            Self::Text(s) => s.clone(),
        }
    }

    /// 从 JSON 值取 ID；`null`/对象 等不可表示的值返回 `None`。
    pub fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Number(n) => n.as_i64().map(Self::Number).or_else(|| {
                n.as_f64()
                    .filter(|f| f.fract() == 0.0)
                    .map(|f| Self::Number(f as i64))
            }),
            Value::String(s) => Some(Self::Text(s.clone())),
            _ => None,
        }
    }

    /// 序列化成 JSON 值时保留原始类型（`{mid: 12}` vs `{mid: "12"}`，1.x 直接 `JSON.stringify`）。
    pub fn to_value(&self) -> Value {
        match self {
            Self::Number(n) => Value::from(*n),
            Self::Text(s) => Value::from(s.clone()),
        }
    }
}

// ---------- 输出结构 ----------

/// 栏目/活动/分类引用（原 `MetaRef`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MetaRef {
    pub mid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 注意字段名：TS 是 `type`（Rust 关键字）。
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub meta_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imgurl: Option<String>,
    pub deadline: i64,
}

/// 信息流条目（原 `RemoteArticle`，`src/shared/domain/index.ts:185`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArticle {
    pub cid: String,
    pub title: String,
    #[serde(rename = "type")]
    pub article_type: String,
    pub status: String,
    pub score: String,
    pub text: String,
    pub author_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_info: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<Vec<MetaRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<Vec<MetaRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<Vec<MetaRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduction: Option<String>,
    pub views: i64,
    pub likes: i64,
    pub comments_num: i64,
    pub created: i64,
    pub modified: i64,
    pub is_anonymous: bool,
    /// TS 是 `active?: MetaRef[] | null`：显式 null 表示「没有活动」，不能用 skip。
    pub active: Option<Vec<MetaRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_score: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    pub reply_time: i64,
}

/// 文章详情（原 `ArticleDetail`，`src/shared/domain/index.ts:220`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleDetail {
    pub cid: String,
    pub title: String,
    pub text: String,
    pub score: String,
    pub author_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_json: Option<JsonObject>,
    pub views: i64,
    pub likes: i64,
    pub comments_num: i64,
    pub created: i64,
    pub modified: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    pub is_anonymous: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<Vec<MetaRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection: Option<Vec<MetaRef>>,
    pub active: Option<Vec<MetaRef>>,
    pub markdown: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduction: Option<String>,
    pub is_likes: i64,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub article_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// 栏目条目（原 `MetaInfo`，`src/shared/domain/index.ts:269`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MetaInfo {
    pub mid: String,
    #[serde(rename = "type")]
    pub meta_type: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub imgurl: String,
    pub count: i64,
    pub deadline: i64,
    pub is_review: i64,
    pub active_status: i64,
}

/// 作品库分类（原 `CategoryMeta`，`read.adapter.ts:755`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CategoryMeta {
    pub mid: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub count: i64,
}

/// 文章元数据（评论/评审脱敏补全用）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleMeta {
    pub author_id: String,
    pub is_anonymous: bool,
}

/// 文章列表入参（原 `ArticleListOptions`，`src/shared/domain/index.ts:253`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleListOptions {
    #[serde(default)]
    pub search_params: Option<JsonObject>,
    #[serde(default)]
    pub mid: Option<StrOrNum>,
    #[serde(default)]
    pub choice: Option<bool>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub order: Option<String>,
    #[serde(default)]
    pub search_key: Option<String>,
}

/// 文章列表返回体：`{ items, total }`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleListOut {
    pub items: Vec<RemoteArticle>,
    pub total: i64,
}

/// 文章不可读的错误分类（1.x `ArticleUnavailableError` + 传输错误）。
///
/// IPC 层据此决定是否把失败包装成「阅读全文需要登录」——网络故障不误标
/// （`src/main/ipc/read.handlers.ts:26-30`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArticleFetchError {
    /// 服务端明确拒绝（返回了响应但不带 `title`，或 `isopen=0` 非本人文章）。
    Unavailable(String),
    /// 传输层失败（网络错误/非 JSON/全部尝试失败）。
    Transport(String),
    /// 共享层错误（配置缺失、会话损坏、缓存读写失败等）。
    Core(String),
}

impl ArticleFetchError {
    /// 1.x `ArticleUnavailableError.message`：`拉取文章失败: ${msg || '未公开或不存在'}`。
    pub fn unavailable_message(reason: &str) -> String {
        let inner = if reason.is_empty() {
            review_rules::ARTICLE_UNAVAILABLE_REASON
        } else {
            reason
        };
        format!("{}{inner}", review_rules::ARTICLE_UNAVAILABLE_PREFIX)
    }

    /// 转成 IPC 错误（消息逐字保留 1.x 的形态）。
    pub fn into_core_error(self) -> CoreError {
        match self {
            Self::Unavailable(reason) => CoreError::app(Self::unavailable_message(&reason)),
            Self::Transport(msg) | Self::Core(msg) => CoreError::app(msg),
        }
    }

    /// 是否为「服务端明确拒绝」（1.x `instanceof ArticleUnavailableError`）。
    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::Unavailable(_))
    }
}

impl From<CoreError> for ArticleFetchError {
    fn from(value: CoreError) -> Self {
        Self::Core(value.to_string())
    }
}

// ---------- 1.x 标量规整（逐字平移 read.adapter.ts:38-60） ----------

/// 取字段；字段缺失或为 `null` 都返回 `None`（对应 1.x 的 `??` 语义）。
///
/// 注意与 `v.get(key)` 的区别：JSON 里显式 `null` 在 1.x 会走 `??` 的右侧。
pub fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value.get(key) {
        None | Some(Value::Null) => None,
        Some(v) => Some(v),
    }
}

/// 取两个别名的第一个非 null 值（1.x 的 `a ?? b`）。
pub fn field_or<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| field(value, key))
}

/// 1.x `str(v)`：`v == null ? '' : String(v)`。
pub fn str_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_to_string(v),
    }
}

/// JS `String(v)` 的近似实现（`str` 的非 null 分支）。
pub fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n),
        Value::String(s) => s.clone(),
        // JS: String([1,2]) === "1,2"，元素里 null/undefined 变空串
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// JS 数字转字符串：`3.0` → `"3"`（serde_json 会给出 `"3.0"`，下游按字符串比较会不一致）。
fn js_number_to_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    match n.as_f64() {
        Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 9e15 => {
            format!("{}", f as i64)
        }
        Some(f) => {
            // JS 对普通小数用最短往返表示，Rust 的 Display 与之一致（如 0.1 → "0.1"）。
            format!("{f}")
        }
        None => n.to_string(),
    }
}

/// 1.x `num(v)`：`Number(v ?? 0)`，非有限值 → 0。
///
/// 偏差：1.x 返回 JS number（可能是小数），这里取整（`views`/`likes` 等计数与
/// `total` 在协议里都是整数，小数只可能出现在脏数据里）。
pub fn num_of(value: Option<&Value>) -> i64 {
    let n = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or_default(),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Array(_)) | Some(Value::Object(_)) => f64::NAN,
    };
    if n.is_finite() { n.trunc() as i64 } else { 0 }
}

/// 1.x `boolish(v)`：`v === true || v === 1 || v === '1' || v === 'true'`。
pub fn boolish_of(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        Some(Value::String(s)) => s == "1" || s == "true",
        _ => false,
    }
}

/// JS 真值判断（对应 1.x 的 `!!v`，例如 `isAnonymous: !!obj.isAnonymous`）。
pub fn truthy_of(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// 1.x `normTs(v)`：统一成秒；非有限/≤0 → 0；毫秒（>1e12）向下取整到秒。
pub fn norm_ts(value: Option<&Value>) -> i64 {
    let n = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or_default(),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Some(Value::Bool(_)) | Some(Value::Array(_)) | Some(Value::Object(_)) => f64::NAN,
    };
    if !n.is_finite() || n <= 0.0 {
        return 0;
    }
    if n > 1e12 {
        (n / 1000.0).floor() as i64
    } else {
        n as i64
    }
}

/// 空串 → `None`（1.x 的 `str(x) || undefined`）。
pub fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

// ---------- 媒体标记剥离（read.adapter.ts:64-68） ----------

/// 剥离展示类文本里的音乐/视频占位标记。
///
/// 1.x 用一条全局正则：
/// ```text
/// (?:\[music\s+163\][\s\S]*?\[\/music\s+163\]|\[music\s+qq\][\s\S]*?\[\/music\s+qq\]|
///    \[video\s+bilibili\][\s\S]*?\[\/video\s+bilibili\]|
///    music163\s*\d{3,20}\s*\/music163|musicqq\s*\d{3,20}\s*\/musicqq)
/// ```
/// 内核不能新增 `regex` 依赖，这里用手写扫描器实现（语义见测试）：
/// 方括号形态跨行非贪婪匹配到对应的闭合标记；紧凑形态要求 3-20 位数字。
pub fn strip_media_tags(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'['
            && let Some((end, tag)) = match_bracket_tag(value, i)
            && let Some(close) = find_close_tag(value, end, tag)
        {
            i = close;
            continue;
        }
        // 紧凑形态：music163<数字3-20>/music163 或 musicqq<数字3-20>/musicqq
        if let Some(end) = match_compact_tag(value, i) {
            i = end;
            continue;
        }
        let ch = value[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 若 `start` 处是 `[music 163]` / `[music qq]` / `[video bilibili]` 开标签，
/// 返回 `(开标签后的字节下标, 归一化后的标签名)`。
fn match_bracket_tag(value: &str, start: usize) -> Option<(usize, &'static str)> {
    let rest = &value[start..];
    let candidates: [(&str, &str, &'static str); 3] = [
        ("[music", "]", "music 163"),
        ("[video", "]", "video bilibili"),
        ("[music", "]", "music qq"),
    ];
    for (open, close, canonical) in candidates {
        if !rest.starts_with(open) {
            continue;
        }
        let after_open = &rest[open.len()..];
        // 开标签形如 `[music 163]`：`\s+` + 关键字 + `]`
        let keyword = canonical
            .split_once(' ')
            .map(|(_, k)| k)
            .unwrap_or_default();
        let trimmed = after_open.trim_start();
        if trimmed.len() == after_open.len() {
            continue; // 必须有空白
        }
        let Some(after_keyword) = trimmed.strip_prefix(keyword) else {
            continue;
        };
        if let Some(rest_after) = after_keyword.strip_prefix(close) {
            let consumed = value.len() - rest_after.len();
            return Some((consumed, canonical));
        }
    }
    None
}

/// 从 `from` 开始找 `[/music 163]` 这类闭合标记，返回闭合标记之后的字节下标。
fn find_close_tag(value: &str, from: usize, canonical: &'static str) -> Option<usize> {
    let (kind, keyword) = canonical.split_once(' ')?;
    let needle = format!("[/{kind}");
    let mut search = from;
    while let Some(offset) = value[search..].find(&needle) {
        let at = search + offset;
        let after = &value[at + needle.len()..];
        let trimmed = after.trim_start();
        if trimmed.len() != after.len()
            && let Some(rest) = trimmed.strip_prefix(keyword)
            && let Some(tail) = rest.strip_prefix(']')
        {
            return Some(value.len() - tail.len());
        }
        search = at + needle.len();
    }
    None
}

/// 紧凑形态 `music16312345/music163`（数字 3-20 位）。
fn match_compact_tag(value: &str, start: usize) -> Option<usize> {
    let rest = &value[start..];
    for (prefix, suffix) in [("music163", "/music163"), ("musicqq", "/musicqq")] {
        let Some(after) = rest.strip_prefix(prefix) else {
            continue;
        };
        let after = after.trim_start();
        let digits = after.bytes().take_while(u8::is_ascii_digit).count();
        if !(3..=20).contains(&digits) {
            continue;
        }
        let after_digits = after[digits..].trim_start();
        if let Some(tail) = after_digits.strip_prefix(suffix) {
            return Some(value.len() - tail.len());
        }
    }
    None
}

// ---------- 条目适配（read.adapter.ts:72-116） ----------

/// 栏目引用规整（`toMetaRef`）。
pub fn to_meta_ref(value: &Value) -> MetaRef {
    MetaRef {
        mid: str_of(field_or(value, &["mid", "id"])),
        name: non_empty(str_of(field(value, "name"))),
        meta_type: non_empty(str_of(field(value, "type"))),
        imgurl: non_empty(str_of(field(value, "imgurl"))),
        deadline: norm_ts(field(value, "deadline")),
    }
}

fn array_of_meta_refs(value: &Value) -> Option<Vec<MetaRef>> {
    value
        .as_array()
        .map(|items| items.iter().map(to_meta_ref).collect())
}

/// 列表条目 → [`RemoteArticle`]（`toRemoteArticle`）。
pub fn to_remote_article(item: &Value) -> RemoteArticle {
    RemoteArticle {
        cid: str_of(field_or(item, &["cid", "id"])),
        title: strip_media_tags(&str_or(item, "title", "未命名")),
        article_type: str_of(field(item, "type")),
        status: str_of(field(item, "status")),
        score: str_of(field(item, "score")),
        text: strip_media_tags(&str_of(field(item, "text"))),
        author_id: str_of(field(item, "authorId")),
        author_info: field(item, "authorInfo").and_then(|v| match v {
            Value::Object(map) => Some(
                map.iter()
                    .map(|(k, v)| (k.clone(), Json::from_value(v)))
                    .collect(),
            ),
            _ => None,
        }),
        category: field(item, "category").and_then(array_of_meta_refs),
        tag: field(item, "tag").and_then(array_of_meta_refs),
        collection: field(item, "collection").and_then(array_of_meta_refs),
        cover: non_empty(str_of(field(item, "cover"))),
        introduction: non_empty(strip_media_tags(&str_of(field(item, "introduction")))),
        views: num_of(field(item, "views")),
        likes: num_of(field(item, "likes")),
        comments_num: num_of(field(item, "commentsNum")),
        created: norm_ts(field(item, "created")),
        modified: norm_ts(field(item, "modified")),
        is_anonymous: truthy_of(field(item, "isAnonymous")),
        active: array_of_meta_refs_opt(field(item, "active")),
        hide_score: None,
        size: non_zero(num_of(field(item, "size"))),
        images: field(item, "images")
            .and_then(|v| v.as_array())
            .map(|items| items.iter().map(|v| str_of(Some(v))).collect()),
        reply_time: norm_ts(field(item, "replyTime")),
    }
}

/// `Array.isArray(x) ? map : null` 语义：非数组 → `None`（序列化为 `null`）。
fn array_of_meta_refs_opt(value: Option<&Value>) -> Option<Vec<MetaRef>> {
    value.and_then(array_of_meta_refs)
}

fn non_zero(value: i64) -> Option<i64> {
    if value == 0 { None } else { Some(value) }
}

/// `str(item[key] ?? fallback)` 的便捷写法。
fn str_or(item: &Value, key: &str, fallback: &str) -> String {
    match field(item, key) {
        Some(v) => str_of(Some(v)),
        None => fallback.to_string(),
    }
}

pub fn json_object_of(value: &Value) -> Option<JsonObject> {
    match value {
        Value::Object(map) => Some(
            map.iter()
                .map(|(k, v)| (k.clone(), Json::from_value(v)))
                .collect(),
        ),
        _ => None,
    }
}

/// 详情条目 → [`ArticleDetail`]（`fetchRemoteArticle` 的构造部分，`read.adapter.ts:548`）。
pub fn adapt_article_detail(obj: &Value, cid: &str) -> ArticleDetail {
    let user_json = field(obj, "userJson").and_then(json_object_of);
    let author_id = {
        let from_obj = str_of(field(obj, "authorId"));
        if !from_obj.is_empty() {
            from_obj
        } else {
            user_json
                .as_ref()
                .and_then(|u| u.get("uid").or_else(|| u.get("id")))
                .map(json_to_string)
                .unwrap_or_default()
        }
    };
    ArticleDetail {
        cid: cid.to_string(),
        title: str_of(field(obj, "title")),
        text: str_of(field(obj, "text")),
        score: str_of(field(obj, "score")),
        author_id,
        user_json,
        views: num_of(field(obj, "views")),
        likes: num_of(field(obj, "likes")),
        comments_num: num_of(field(obj, "commentsNum")),
        created: norm_ts(field(obj, "created")),
        modified: norm_ts(field(obj, "modified")),
        size: non_zero(num_of(field(obj, "size"))),
        is_anonymous: truthy_of(field(obj, "isAnonymous")),
        category: field(obj, "category").and_then(array_of_meta_refs),
        collection: field(obj, "collection").and_then(array_of_meta_refs),
        active: array_of_meta_refs_opt(field(obj, "active")),
        markdown: num_of(field(obj, "markdown")),
        introduction: non_empty(strip_media_tags(&str_of(field(obj, "introduction")))),
        is_likes: num_of(field(obj, "isLikes")),
        article_type: non_empty(str_of(field(obj, "type"))),
        status: non_empty(str_of(field(obj, "status"))),
    }
}

fn json_to_string(value: &Json) -> String {
    match value {
        Json::Null => String::new(),
        Json::Bool(b) => b.to_string(),
        Json::Int(i) => i.to_string(),
        Json::Float(f) => js_number_to_string(
            &serde_json::Number::from_f64(*f).unwrap_or_else(|| serde_json::Number::from(0i64)),
        ),
        Json::String(s) => s.clone(),
        Json::Array(_) | Json::Object(_) => String::new(),
    }
}

// ---------- 脱敏（原 activity-rules.ts；domain 只放判定，展示字段在这里改） ----------

/// 展示名匿名化（`anonymizeUserJson`）。
///
/// 保留 uid 等内部字段，只改展示字段：`name`/`nickname`/`screenName` = 匿名用户，
/// 头像类字段清空。入参为 `None` 时返回只含这些字段的对象（1.x `...(u ?? {})`）。
pub fn anonymize_user_json(user: &Option<JsonObject>) -> JsonObject {
    let mut next = user.clone().unwrap_or_default();
    let anonymous = Json::String("匿名用户".to_string());
    for key in ["name", "nickname", "screenName"] {
        next.insert(key.to_string(), anonymous.clone());
    }
    let empty = Json::String(String::new());
    for key in ["avatar", "headImg", "headImgUrl", "avatarUrl"] {
        next.insert(key.to_string(), empty.clone());
    }
    next
}

/// 文章列表脱敏（`sanitizeArticleList`）：命中活动 → 隐藏评分 + 匿名作者展示名。
pub fn sanitize_article_list(items: &mut [RemoteArticle], mids: &BTreeSet<String>) {
    for item in items.iter_mut() {
        let hit = item.active.as_ref().is_some_and(|refs| {
            refs.iter()
                .any(|r| review_rules::is_in_mids(mids, Some(r.mid.as_str())))
        });
        if hit {
            item.score = review_rules::HIDDEN_SCORE.to_string();
            item.hide_score = Some(true);
            item.author_info = Some(anonymize_user_json(&item.author_info));
        }
    }
}

/// 文章详情脱敏（`sanitizeArticleDetail`）：命中活动 → 隐藏评分 + 匿名作者展示名。
pub fn sanitize_article_detail(detail: &mut ArticleDetail, mids: &BTreeSet<String>) {
    let hit = detail.active.as_ref().is_some_and(|refs| {
        refs.iter()
            .any(|r| review_rules::is_in_mids(mids, Some(r.mid.as_str())))
    });
    if hit {
        detail.score = review_rules::HIDDEN_SCORE.to_string();
        detail.user_json = Some(anonymize_user_json(&detail.user_json));
    }
}

// ---------- 请求层 ----------

/// 按裸对象语义请求接口（1.x `raw: true`：整个 body，不校验 `code`）。
fn request_value(ctx: &CoreCtx, name: &str, options: &ApiOptions) -> CoreResult<Value> {
    net::request_value(ctx, name, options)
}

/// 一次列表请求的公共收尾：映射 + 脱敏 + 计算 total。
fn finish_article_list(ctx: &CoreCtx, resp: &ApiResponse<Value>) -> CoreResult<ArticleListOut> {
    let data = resp.data.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut items: Vec<RemoteArticle> = data.iter().map(to_remote_article).collect();
    let mids = get_ongoing_review_mids(ctx);
    sanitize_article_list(&mut items, &mids);
    let total = resp.total.unwrap_or(0);
    let total = if total == 0 { data.len() as i64 } else { total };
    Ok(ArticleListOut { items, total })
}

/// 拉取文章列表（`listRemoteArticles`）。
pub fn list_remote_articles(
    ctx: &CoreCtx,
    opts: &ArticleListOptions,
) -> CoreResult<ArticleListOut> {
    list_remote_articles_with_timeout(ctx, opts, None)
}

fn list_remote_articles_with_timeout(
    ctx: &CoreCtx,
    opts: &ArticleListOptions,
    timeout_ms: Option<u64>,
) -> CoreResult<ArticleListOut> {
    let token = net::token(ctx)?;
    let limit = opts.limit.unwrap_or(PAGE_SIZE);
    let page = opts.page.unwrap_or(1);
    let mut options = ApiOptions::get()
        .query("limit", limit.to_string())
        .query("page", page.to_string());
    if let Some(ms) = timeout_ms {
        options = options.timeout(ms);
    }
    let choice = opts.choice.unwrap_or(false);
    if !choice && let Some(order) = opts.order.as_deref().filter(|s| !s.is_empty()) {
        options = options.query("order", order);
    }
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }

    if choice {
        let resp = net::request::<Value>(ctx, endpoints::CHOICE_LIST, &options)?;
        return finish_article_list(ctx, &resp);
    }

    if let Some(mid) = &opts.mid {
        let search_params = serde_json::json!({ "mid": mid.to_value() }).to_string();
        let resp = net::request::<Value>(
            ctx,
            endpoints::SELECT_CONTENTS,
            &options.query("searchParams", search_params),
        )?;
        return finish_article_list(ctx, &resp);
    }

    let search_params = match &opts.search_params {
        Some(params) => serde_json::to_string(params).unwrap_or_else(|_| "{}".to_string()),
        None => serde_json::json!({ "type": "post" }).to_string(),
    };
    let mut options = options.query("searchParams", search_params);
    if let Some(key) = opts.search_key.as_deref().filter(|s| !s.is_empty()) {
        options = options.query("searchKey", key);
    }
    let resp = net::request::<Value>(ctx, endpoints::CONTENTS_LIST, &options)?;
    finish_article_list(ctx, &resp)
}

/// 拉取 metas 栏目条目（`listMetas`；活动/连载/作品库/tag 树都走它）。
pub fn list_metas(ctx: &CoreCtx, meta_type: &str) -> CoreResult<Vec<MetaInfo>> {
    list_metas_with_timeout(ctx, meta_type, None)
}

fn list_metas_with_timeout(
    ctx: &CoreCtx,
    meta_type: &str,
    timeout_ms: Option<u64>,
) -> CoreResult<Vec<MetaInfo>> {
    let token = net::token(ctx)?;
    let mut options = ApiOptions::get()
        .query(
            "searchParams",
            serde_json::json!({ "type": meta_type }).to_string(),
        )
        .query("limit", "100")
        .query("page", "1")
        .query("order", "order");
    if let Some(ms) = timeout_ms {
        options = options.timeout(ms);
    }
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }
    let resp = net::request::<Value>(ctx, endpoints::METAS_LIST, &options)?;
    let data = resp.data.as_array().map(Vec::as_slice).unwrap_or(&[]);
    Ok(data
        .iter()
        .map(|m| MetaInfo {
            mid: str_of(field_or(m, &["mid", "id"])),
            meta_type: str_of(field(m, "type")),
            name: str_of(field(m, "name")),
            slug: str_of(field(m, "slug")),
            description: str_of(field(m, "description")),
            imgurl: str_of(field(m, "imgurl")),
            count: num_of(field(m, "count")),
            deadline: norm_ts(field(m, "deadline")),
            is_review: num_of(field(m, "isReview")),
            active_status: num_of(field(m, "activeStatus")),
        })
        .collect())
}

/// 作品库分类（`listCategories`，metasList type=category）。
pub fn list_categories(ctx: &CoreCtx) -> CoreResult<Vec<CategoryMeta>> {
    let token = net::token(ctx)?;
    let mut options = ApiOptions::get()
        .query(
            "searchParams",
            serde_json::json!({ "type": "category" }).to_string(),
        )
        .query("limit", "50")
        .query("page", "1")
        .query("order", "order");
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }
    let resp = net::request::<Value>(ctx, endpoints::METAS_LIST, &options)?;
    let data = resp.data.as_array().map(Vec::as_slice).unwrap_or(&[]);
    Ok(data
        .iter()
        .map(|m| CategoryMeta {
            mid: str_of(field_or(m, &["mid", "id"])),
            name: str_of(field(m, "name")),
            slug: str_of(field(m, "slug")),
            description: str_of(field(m, "description")),
            count: num_of(field(m, "count")),
        })
        .collect())
}

// ---------- 活动 mid 集合（5 分钟缓存） ----------

#[derive(Debug, Serialize, Deserialize)]
struct MidsCache {
    mids: Vec<String>,
    at: i64,
}

/// 进行中（`activeStatus=1`）/ 评审中（`-1`）活动的 mid 集合。
///
/// 1.x 是模块级 5 分钟内存缓存；内核落到 `meta` 表（跨进程 + 跨命令共享）。拉取失败
/// 时按「保守不隐藏」返回空集合，并且同样缓存 5 分钟（与 1.x 一致）。
pub fn get_ongoing_review_mids(ctx: &CoreCtx) -> BTreeSet<String> {
    let now = ctx.clock.now_ms();
    if let Some(cache) = read_meta_json::<MidsCache>(ctx, ONGOING_MIDS_CACHE_KEY)
        && now - cache.at < META_CACHE_TTL_MS
    {
        return cache.mids.into_iter().collect();
    }
    let mut mids = BTreeSet::new();
    if let Ok(metas) = list_metas(ctx, "active") {
        for meta in metas {
            if meta.active_status == 1 || meta.active_status == -1 {
                mids.insert(meta.mid);
            }
        }
    }
    let cache = MidsCache {
        mids: mids.iter().cloned().collect(),
        at: now,
    };
    write_meta_json(ctx, ONGOING_MIDS_CACHE_KEY, &cache);
    mids
}

// ---------- 文章元数据补全（评论脱敏） ----------

#[derive(Debug, Serialize, Deserialize)]
struct ArticleMetaCache {
    /// `None` 表示「查过但没有」（负缓存，1.x 同样缓存 null）。
    meta: Option<ArticleMeta>,
    at: i64,
}

fn meta_cache_key(cid: &str) -> String {
    format!("{ARTICLE_META_CACHE_PREFIX}{cid}")
}

/// 取单篇文章元数据（`getArticleMetaByCid`），带 5 分钟缓存与 3 秒超时。
///
/// 1.x 内部走 `listRemoteArticles({searchParams:{cid},limit:2,order:'created'})`，
/// 所以这里同样会顺带触发活动 mid 集合的查询（与 1.x 的请求序列一致）。
pub fn get_article_meta_by_cid(ctx: &CoreCtx, cid: &str) -> Option<ArticleMeta> {
    let now = ctx.clock.now_ms();
    if let Some(cache) = read_meta_json::<ArticleMetaCache>(ctx, &meta_cache_key(cid))
        && now - cache.at < META_CACHE_TTL_MS
    {
        return cache.meta;
    }
    let opts = ArticleListOptions {
        search_params: Some(
            [(String::from("cid"), Json::String(cid.to_string()))]
                .into_iter()
                .collect(),
        ),
        limit: Some(2),
        order: Some("created".to_string()),
        ..Default::default()
    };
    let meta = list_remote_articles_with_timeout(ctx, &opts, Some(ANON_META_TIMEOUT_MS))
        .ok()
        .and_then(|out| {
            out.items
                .into_iter()
                .find(|a| a.cid == cid)
                .map(|a| ArticleMeta {
                    author_id: a.author_id,
                    is_anonymous: a.is_anonymous,
                })
        });
    write_meta_json(
        ctx,
        &meta_cache_key(cid),
        &ArticleMetaCache {
            meta: meta.clone(),
            at: now,
        },
    );
    meta
}

/// 通用补全：把 cid 的 `authorId`/`isAnonymous` 回填到前 N 条条目里。
///
/// 对应 1.x `fillArticleAnonMeta`（前 4 条、去重、逐条 3 秒超时、失败不阻塞）。
/// 返回 `(cid, meta)` 的映射；调用方按字段合并（`a || b` 语义，见各自 adapter）。
pub fn fill_article_anon_meta(ctx: &CoreCtx, cids: &[String]) -> BTreeMap<String, ArticleMeta> {
    let mut seen = BTreeSet::new();
    let mut metas = BTreeMap::new();
    for cid in cids.iter().take(4) {
        if cid.is_empty() || !seen.insert(cid.clone()) {
            continue;
        }
        if let Some(meta) = get_article_meta_by_cid(ctx, cid) {
            metas.insert(cid.clone(), meta);
        }
    }
    metas
}

// ---------- 文章详情 ----------

#[derive(Debug, Serialize, Deserialize)]
struct CachedArticle {
    detail: ArticleDetail,
    #[serde(rename = "cachedAt")]
    cached_at: i64,
}

/// contentsInfo 的两种取法（`fetchRemoteObject` / `fetchRemoteRendered`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentsMode {
    /// 阅读形态：GET isMd=1 → POST（有 token）→ GET isMd=0。
    Rendered,
    /// 编辑形态：POST（有 token）→ GET isMd=0。
    Object,
}

impl ContentsMode {
    const fn failure_suffix(self) -> &'static str {
        match self {
            Self::Rendered => "isMd=1/POST/isMd=0",
            Self::Object => "POST/GET",
        }
    }

    fn attempts(self, token: Option<&str>, cid: &str) -> Vec<ApiOptions> {
        let get_is_md = |is_md: &str| {
            let mut opts = ApiOptions::get().query("key", cid).query("isMd", is_md);
            if let Some(token) = token {
                opts = opts.query("token", token);
            }
            opts
        };
        let post = || {
            ApiOptions::post()
                .body("key", cid)
                .body("token", token.unwrap_or_default())
        };
        match self {
            Self::Rendered => {
                let mut attempts = vec![get_is_md("1")];
                if token.is_some() {
                    attempts.push(post());
                }
                attempts.push(get_is_md("0"));
                attempts
            }
            Self::Object => {
                let mut attempts = Vec::new();
                if token.is_some() {
                    attempts.push(post());
                }
                attempts.push(get_is_md("0"));
                attempts
            }
        }
    }
}

/// 取 contentsInfo 裸对象（`fetchRemoteObject` / `fetchRemoteRendered` 的共同逻辑）。
///
/// 成功判定：返回对象里 `title` 是字符串。否则记录服务端消息；全部尝试失败后：
/// - 收到过服务端响应（哪怕没 title）→ 业务拒绝 [`ArticleFetchError::Unavailable`]
/// - 全程只有传输层异常 → [`ArticleFetchError::Transport`]（1.x 的普通 `Error`）
fn fetch_contents(
    ctx: &CoreCtx,
    cid: &str,
    mode: ContentsMode,
) -> Result<Value, ArticleFetchError> {
    let token = net::token(ctx)?;
    let mut last_error = String::from("未知错误");
    let mut saw_server_response = false;
    for options in mode.attempts(token.as_deref(), cid) {
        match request_value(ctx, endpoints::CONTENTS_INFO, &options) {
            Ok(obj) => {
                let has_title = matches!(field(&obj, "title"), Some(Value::String(_)));
                if has_title {
                    return Ok(obj);
                }
                saw_server_response = true;
                last_error = match field(&obj, "msg") {
                    Some(Value::String(msg)) => msg.clone(),
                    _ => snippet(&obj),
                };
            }
            Err(err) => last_error = err.to_string(),
        }
    }
    if saw_server_response {
        Err(ArticleFetchError::Unavailable(last_error))
    } else {
        Err(ArticleFetchError::Transport(format!(
            "contentsInfo 拉取失败（{} 均试）: {last_error}",
            mode.failure_suffix()
        )))
    }
}

/// 编辑/同步形态取全文（`fetchRemoteObject`）：作者草稿优先走 POST。
pub fn fetch_remote_object(ctx: &CoreCtx, cid: &str) -> Result<Value, ArticleFetchError> {
    fetch_contents(ctx, cid, ContentsMode::Object)
}

/// 阅读形态取全文（`fetchRemoteRendered`）：服务端渲染优先（isMd=1）。
pub fn fetch_remote_rendered(ctx: &CoreCtx, cid: &str) -> Result<Value, ArticleFetchError> {
    fetch_contents(ctx, cid, ContentsMode::Rendered)
}

fn snippet(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

/// 拉取文章详情（`fetchRemoteArticle`）。
///
/// 缓存键并入登录态（`article:{uid|anon}:{cid}`）；详情 10 分钟硬过期。
/// `uid` 用于区分「本人文章」：`isopen=0`（未公开/被隐藏）仅对**非本人**报错，
/// 作者自己的草稿必须可读。
pub fn fetch_remote_article(
    ctx: &CoreCtx,
    cid: &str,
    uid: Option<&str>,
) -> Result<ArticleDetail, ArticleFetchError> {
    let uid_key = match uid {
        Some(uid) if !uid.is_empty() => uid.to_string(),
        _ => "anon".to_string(),
    };
    let cache_key = format!("{ARTICLE_CACHE_KEY_PREFIX}{uid_key}:{cid}");
    let now = ctx.clock.now_ms();
    if let Ok(Some(cached)) = ctx.db.get_read_cache::<CachedArticle>(&cache_key, now)
        && now - cached.cached_at < ARTICLE_CACHE_MAX_AGE_MS
    {
        return Ok(cached.detail);
    }

    let obj = fetch_contents(ctx, cid, ContentsMode::Rendered)?;
    let mut detail = adapt_article_detail(&obj, cid);

    // 文章未公开/被隐藏（contentsInfo 仍返回 title 但 isopen=0）。本人文章豁免。
    let is_open_zero = matches!(field(&obj, "isopen"), Some(Value::Number(n)) if n.as_f64() == Some(0.0))
        || matches!(field(&obj, "isopen"), Some(Value::String(s)) if s == "0");
    if is_open_zero && uid.unwrap_or_default() != detail.author_id {
        let _ = ctx.db.delete_read_cache(&cache_key);
        return Err(ArticleFetchError::Unavailable(str_of(field(&obj, "msg"))));
    }

    let mids = get_ongoing_review_mids(ctx);
    sanitize_article_detail(&mut detail, &mids);
    let cached = CachedArticle {
        detail: detail.clone(),
        cached_at: now,
    };
    if let Err(err) = ctx.db.set_read_cache(&cache_key, &cached, now) {
        return Err(ArticleFetchError::Core(err.to_string()));
    }
    Ok(detail)
}

// ---------- db meta 读写（缓存） ----------

fn read_meta_json<T: for<'de> Deserialize<'de>>(ctx: &CoreCtx, key: &str) -> Option<T> {
    let raw = ctx.db.get_meta(key).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta_json<T: Serialize>(ctx: &CoreCtx, key: &str, value: &T) {
    if let Ok(raw) = serde_json::to_string(value) {
        let _ = ctx.db.set_meta(key, &raw);
    }
}
// ---------- 会话 uid（1.x `getSession()`；委托 L4 的 session 服务） ----------

/// 当前登录账号的 uid（1.x `session?.userinfo?.uid ?? userinfo?.id`）。
///
/// 1.x 里 uid 只用于「我的评审」查询与评审分数隐藏判定，缺失（未登录/会话损坏）
/// 返回 `None`，调用方按空 uid 处理（`review.handlers.ts:56-58` 的 `if (!uid)`）。
pub fn session_uid(ctx: &CoreCtx) -> CoreResult<Option<String>> {
    // TODO(L4): 已改为委托 `services::auth::session_uid`（正式 session 服务）；
    // 这里保留 `Option` 外壳只是为了命令层的 `if !uid` 分支读起来与 1.x 一致。
    Ok(non_empty(crate::services::auth::session_uid(ctx)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    /// 常见响应序列：contentsList 命中 + metasList（活动 mid 缓存未命中时必然发生）。
    fn enqueue_list(h: &Harness, data: serde_json::Value, total: Option<i64>) {
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": total, "data": data}).to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
    }

    #[test]
    fn strip_media_tags_handles_bracket_and_compact_forms() {
        let cases = [
            ("前[music 163]12345[/music 163]后", "前后"),
            ("甲[music qq]9[/music qq]乙", "甲乙"),
            ("开[video bilibili]BV1[/video bilibili]关", "开关"),
            ("a[music 163]跨\n行[/music 163]b", "ab"),
            ("music163 123456 /music163", ""),
            ("xmusicqq 987654 /musicqqy", "xy"),
            ("[music 163]未闭合", "[music 163]未闭合"),
            ("music163 12 /music163", "music163 12 /music163"),
        ];
        for (input, expected) in cases {
            assert_eq!(strip_media_tags(input), expected, "输入 {input:?}");
        }
    }

    #[test]
    fn js_scalars_match_one_x_semantics() {
        assert_eq!(num_of(Some(&json!("3.9"))), 3); // Number("3.9") 截断
        assert_eq!(num_of(Some(&json!(null))), 0);
        assert_eq!(num_of(Some(&json!("abc"))), 0); // NaN → 0
        assert_eq!(str_of(Some(&json!(null))), "");
        assert_eq!(str_of(None), "");
        assert_eq!(str_of(Some(&json!(3.0))), "3"); // String(3.0) === "3"
        assert_eq!(js_to_string(&json!(true)), "true");
        assert!(boolish_of(Some(&json!(1))));
        assert!(boolish_of(Some(&json!("true"))));
        assert!(!boolish_of(Some(&json!("1.0"))));
        assert_eq!(norm_ts(Some(&json!(0))), 0);
        assert_eq!(norm_ts(Some(&json!(-5))), 0);
        assert_eq!(norm_ts(Some(&json!(1_600_000_000_000_i64))), 1_600_000_000);
        assert_eq!(norm_ts(Some(&json!(1_600_000_000_i64))), 1_600_000_000);
    }

    #[test]
    fn to_remote_article_maps_aliases_and_defaults() {
        let item = json!({
            "id": 42,
            "title": "[music qq]9[/music qq]标题",
            "type": "post",
            "status": "approved",
            "score": "8.0",
            "text": "摘要[music 163]1[/music 163]",
            "authorId": 7,
            "authorInfo": {"name": "作者"},
            "category": [{"id": 3, "name": "分类", "type": "category", "imgurl": "c.png", "deadline": 0}],
            "cover": "cover.png",
            "introduction": "引言[music 163]1[/music 163]",
            "views": "12",
            "likes": 3,
            "commentsNum": 2,
            "created": 1_600_000_000,
            "modified": 1_600_000_001,
            "replyTime": 1_600_000_002,
            "isAnonymous": 1,
            "size": 0,
            "images": ["a.png", 2]
        });
        let article = to_remote_article(&item);
        assert_eq!(article.cid, "42");
        assert_eq!(article.title, "标题");
        assert_eq!(article.text, "摘要");
        assert_eq!(article.introduction.as_deref(), Some("引言"));
        assert_eq!(article.views, 12);
        assert!(article.is_anonymous);
        assert_eq!(
            article.images,
            Some(vec!["a.png".to_string(), "2".to_string()])
        );
        assert_eq!(article.size, None); // num 为 0 时 undefined
        assert_eq!(article.active, None); // 无 active 字段 → null
        let category = article.category.unwrap();
        assert_eq!(category[0].mid, "3");
        assert_eq!(category[0].meta_type.as_deref(), Some("category"));
        assert!(article.author_info.is_some());
        assert_eq!(article.reply_time, 1_600_000_002);
    }

    #[test]
    fn to_remote_article_keeps_title_fallback_and_empty_array_active() {
        let article = to_remote_article(&json!({"cid": "5", "active": []}));
        assert_eq!(article.title, "未命名");
        assert_eq!(article.active, Some(Vec::new()));
    }

    #[test]
    fn adapt_article_detail_maps_fields() {
        let obj = json!({
            "title": "标题",
            "text": "正文",
            "score": "9",
            "userJson": {"uid": 7, "name": "作者"},
            "views": 1,
            "likes": 2,
            "commentsNum": 3,
            "created": 1_600_000_000,
            "modified": 1_600_000_000,
            "isAnonymous": false,
            "isLikes": 1,
            "markdown": 1,
            "type": "post",
            "status": "approved",
            "introduction": "[music 163]1[/music 163]"
        });
        let detail = adapt_article_detail(&obj, "99");
        assert_eq!(detail.cid, "99");
        assert_eq!(detail.author_id, "7"); // 来自 userJson.uid
        assert_eq!(detail.markdown, 1);
        assert_eq!(detail.is_likes, 1);
        assert_eq!(detail.article_type.as_deref(), Some("post"));
        assert_eq!(detail.status.as_deref(), Some("approved"));
        assert_eq!(detail.introduction, None); // strip 后空 → undefined
        assert_eq!(detail.active, None);
    }

    #[test]
    fn sanitize_list_hides_scores_and_anonymizes_author_info() {
        let mut items = vec![
            to_remote_article(
                &json!({"cid": 1, "active": [{"mid": 3}], "authorInfo": {"name": "甲"}}),
            ),
            to_remote_article(&json!({"cid": 2, "active": [{"mid": 9}]})),
        ];
        let mids: BTreeSet<String> = ["3".to_string()].into_iter().collect();
        sanitize_article_list(&mut items, &mids);
        assert_eq!(items[0].score, "-.-");
        assert_eq!(items[0].hide_score, Some(true));
        assert_eq!(
            items[0].author_info.as_ref().unwrap().get("name"),
            Some(&Json::String("匿名用户".to_string()))
        );
        assert_eq!(items[1].score, "");
        assert_eq!(items[1].hide_score, None);
    }

    #[test]
    fn sanitize_detail_hides_score_and_anonymizes_user_json() {
        let mut detail =
            adapt_article_detail(&json!({"title": "t", "userJson": {"name": "甲"}}), "1");
        detail.active = Some(vec![MetaRef {
            mid: "3".to_string(),
            ..MetaRef::default()
        }]);
        let mids: BTreeSet<String> = ["3".to_string()].into_iter().collect();
        sanitize_article_detail(&mut detail, &mids);
        assert_eq!(detail.score, "-.-");
        assert_eq!(
            detail.user_json.as_ref().unwrap().get("name"),
            Some(&Json::String("匿名用户".to_string()))
        );
    }

    #[test]
    fn list_remote_articles_choice_uses_choice_endpoint() {
        let h = Harness::new().with_api_config().with_token("t");
        enqueue_list(&h, json!([{"cid": 1, "title": "精选"}]), Some(1));
        let out = list_remote_articles(
            &h.ctx,
            &ArticleListOptions {
                choice: Some(true),
                order: Some("created".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        let request = &h.requests()[0];
        assert!(request.url.contains("/api/choicelist"));
        assert!(!request.url.contains("order=")); // choice 分支忽略 order
        assert!(request.url.contains("token=t"));
    }

    #[test]
    fn list_remote_articles_mid_uses_select_contents() {
        let h = Harness::new().with_api_config();
        enqueue_list(&h, json!([{"cid": 1}]), None);
        let out = list_remote_articles(
            &h.ctx,
            &ArticleListOptions {
                mid: Some(StrOrNum::Number(3)),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.total, 1); // total 缺失 → 回退条目数
        let request = &h.requests()[0];
        assert!(request.url.contains("/api/selectcontents"));
        assert!(request.url.contains("searchParams="));
    }

    #[test]
    fn list_metas_maps_fields() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"id": 3, "type": "active", "name": "活动", "slug": "a",
                 "description": "说明", "imgurl": "i.png", "count": 2,
                 "deadline": 1_700_000_000, "isReview": 1, "activeStatus": -1}
            ]})
            .to_string(),
        );
        let metas = list_metas(&h.ctx, "active").unwrap();
        assert_eq!(metas[0].mid, "3");
        assert_eq!(metas[0].meta_type, "active");
        assert_eq!(metas[0].active_status, -1);
        assert!(h.last_request().url.contains("/api/metaslist"));
    }

    #[test]
    fn ongoing_mids_cache_survives_second_call() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"mid": 3, "activeStatus": 1},
                {"mid": 4, "activeStatus": 0},
                {"mid": 5, "activeStatus": -1}
            ]})
            .to_string(),
        );
        let first = get_ongoing_review_mids(&h.ctx);
        assert_eq!(first, ["3", "5"].into_iter().map(String::from).collect());
        let second = get_ongoing_review_mids(&h.ctx);
        assert_eq!(second, first);
        assert_eq!(h.requests().len(), 1); // 第二次命中 5 分钟缓存
    }

    #[test]
    fn fetch_remote_article_caches_detail_for_same_uid() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"title": "标题", "authorId": 7, "userJson": {"uid": 7}}).to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let first = fetch_remote_article(&h.ctx, "42", Some("9")).unwrap();
        assert_eq!(first.title, "标题");
        let calls = h.requests().len();
        let second = fetch_remote_article(&h.ctx, "42", Some("9")).unwrap();
        assert_eq!(second.title, "标题");
        assert_eq!(h.requests().len(), calls); // 10 分钟缓存命中，不再发请求
    }

    #[test]
    fn fetch_remote_article_rejects_closed_article_for_non_author() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"title": "隐藏", "isopen": 0, "authorId": 7, "msg": "文章已隐藏"}).to_string(),
        );
        let err = fetch_remote_article(&h.ctx, "42", Some("9")).unwrap_err();
        assert!(err.is_unavailable());
        assert_eq!(
            err.into_core_error().to_string(),
            "拉取文章失败: 文章已隐藏"
        );
    }

    #[test]
    fn fetch_remote_article_allows_closed_article_for_author() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"title": "我的草稿", "isopen": "0", "authorId": 7}).to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let detail = fetch_remote_article(&h.ctx, "42", Some("7")).unwrap();
        assert_eq!(detail.title, "我的草稿");
    }

    #[test]
    fn article_meta_is_negatively_cached() {
        let h = Harness::new().with_api_config();
        enqueue_list(&h, json!([]), None);
        assert!(get_article_meta_by_cid(&h.ctx, "42").is_none());
        let calls = h.requests().len();
        assert!(get_article_meta_by_cid(&h.ctx, "42").is_none());
        assert_eq!(h.requests().len(), calls);
    }

    #[test]
    fn fill_article_anon_meta_takes_first_four_unique_cids() {
        let h = Harness::new().with_api_config();
        for _ in 0..4 {
            enqueue_list(&h, json!([{"cid": 1, "authorId": 7}]), None);
        }
        let cids: Vec<String> = ["1", "1", "2", "3", "4", "5"]
            .into_iter()
            .map(String::from)
            .collect();
        let metas = fill_article_anon_meta(&h.ctx, &cids);
        // 只有第一个 cid 的响应里带匹配条目，其余是负缓存，不进 map。
        assert_eq!(metas.len(), 1);
        assert!(metas.contains_key("1"));
        assert_eq!(
            h.requests()
                .iter()
                .filter(|r| r.url.contains("contentslist"))
                .count(),
            3
        );
    }
}
