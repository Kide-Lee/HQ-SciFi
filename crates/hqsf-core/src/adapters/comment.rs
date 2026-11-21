//! 评论侧适配层：远端 JSON → 渲染层结构（原 `read.adapter.ts:784-963` 的评论子集
//! + `src/main/ipc/comment.handlers.ts` 的入参校验）。
//!
//! 与 1.x 的对应关系：
//! - [`to_comment_item`] ← `read.adapter.ts:784` `toCommentItem`；
//! - [`sanitize_comment_list`] ← `activity-rules.ts:66` `sanitizeCommentList`；
//! - [`fetch_comments_by_search_params`] ← `read.adapter.ts:841`（带「过滤服务端占位评论后
//!   补页」的最多 5 次尝试）；
//! - [`add_comment`] ← `read.adapter.ts:948` + `comment-request.ts` 的 `buildCommentRequest`。
//!
//! 偏差（已报 lead）：1.x 用 `mapLimit(cids, 4)` 并发补文章元数据、`Promise.all` 并行补
//! 评审作者名；这里顺序执行——行为等价（都带缓存/各自超时），只是最坏延迟略高。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::adapters::read::{
    Json, boolish_of, field, field_or, js_to_string, json_object_of, norm_ts, num_of, str_of,
};
use crate::adapters::review::fetch_review_author_name;
use crate::ctx::CoreCtx;
use crate::domain::comment as rules;
use crate::error::{CoreError, CoreResult};
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::services::net;

/// 评论列表默认每页条数（`read.adapter.ts:34` `PAGE_SIZE`）。
pub const PAGE_SIZE: i64 = 20;

/// 「最新讨论」默认条数（`read.adapter.ts:897`）。
pub const RECENT_PAGE_SIZE: i64 = 8;

/// 占位评论过滤后的补页上限（`read.adapter.ts:849` 的 `attempt < 5`）。
const MAX_FETCH_ATTEMPTS: usize = 5;

/// 搜索默认条数（`search.handlers.ts:14`）。
pub const SEARCH_PAGE_SIZE: i64 = 10;

// ---------- 输出结构 ----------

/// 父级评论摘要（`CommentItem.parentComments`，1.x 是原样透传的对象）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ParentCommentSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

/// 评论条目（`src/shared/domain/index.ts:388` `CommentItem`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentItem {
    pub coid: String,
    pub cid: String,
    pub parent: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_title: Option<String>,
    /// 所属文章作者 uid（`ownerId` / `contentsInfo.authorId`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_author_id: Option<String>,
    /// 所属文章是否匿名（1.x `boolish(contentsInfo.isAnonymous ?? item.articleIsAnonymous)`）。
    pub article_is_anonymous: bool,
    /// 评论者经验值（官网 Lv0~Lv7；缺失/匿名不显示）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
    /// 评审讨论卡片展示「中某某的评审」用（首页前 4 条补全）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_author: Option<String>,
    pub author: String,
    pub author_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub created: i64,
    pub sub_num: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_comments: Option<ParentCommentSummary>,
    /// 评论-评审关联（荒启定制版 `reviewid`，0/空 = 普通评论）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewid: Option<String>,
}

/// 评论列表返回（`src/shared/domain/index.ts:477` `CommentListResult`：
/// `list-comments` 带 `nextPage` / `hasMore`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentListResult {
    pub items: Vec<CommentItem>,
    pub total: i64,
    pub next_page: i64,
    pub has_more: bool,
}

/// 只有 `{items,total}` 的评论列表（`list-recent-comments` / `search-comments`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentListOut {
    pub items: Vec<CommentItem>,
    pub total: i64,
}

/// `list-comments` / `list-recent-comments` 的入参（`comment.handlers.ts:7,19`）。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct CommentListOptions {
    pub limit: Option<i64>,
    pub page: Option<i64>,
    pub order: Option<String>,
}

/// 评论提交结果（`src/shared/domain/index.ts:485` `CommentSubmitResult`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct CommentSubmitResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------- 逐字段规整（`read.adapter.ts:784` `toCommentItem`） ----------

/// 远端评论原始 JSON → [`CommentItem`]。
pub fn to_comment_item(item: &Value) -> CommentItem {
    let user_json = field(item, "userJson").unwrap_or(&Value::Null);
    let contents_info = field(item, "contentsInfo").unwrap_or(&Value::Null);

    // 1.x: `userJson.name ?? item.author ?? '匿名'`——服务端对「匿名作者本人」的 userJson
    // 已做匿名化，顶层 author 仍是真实昵称，所以 userJson 优先。
    let author = match field(user_json, "name") {
        Some(name) => str_of(Some(name)),
        None => match field(item, "author") {
            Some(author) => str_of(Some(author)),
            None => "匿名".to_string(),
        },
    };
    let parent_comments = field(item, "parentComments")
        .and_then(json_object_of)
        .map(|obj| ParentCommentSummary {
            author: parent_field(&obj, "author"),
            text: parent_field(&obj, "text"),
            created: parent_field(&obj, "created"),
        });

    CommentItem {
        coid: str_of(field_or(item, &["coid", "id"])),
        cid: match field(item, "cid") {
            Some(cid) => js_to_string(cid),
            None => str_of(field(contents_info, "cid")),
        },
        parent: match field(item, "parent") {
            Some(parent) => js_to_string(parent),
            None => "0".to_string(),
        },
        text: str_of(field(item, "text")),
        article_title: non_empty(match field(item, "contenTitle") {
            Some(title) => str_of(Some(title)),
            None => str_of(field(contents_info, "title")),
        }),
        article_author_id: non_empty({
            match field(contents_info, "authorId") {
                Some(v) => str_of(Some(v)),
                None => match field(item, "ownerId") {
                    Some(v) => str_of(Some(v)),
                    None => str_of(field(item, "articleAuthorId")),
                },
            }
        }),
        article_is_anonymous: boolish_of(
            field(contents_info, "isAnonymous").or_else(|| field(item, "articleIsAnonymous")),
        ),
        experience: field(user_json, "experience").map(|v| num_of(Some(v))),
        review_author: None,
        author,
        author_id: match field(item, "authorId") {
            Some(v) => js_to_string(v),
            None => match field(user_json, "uid") {
                Some(v) => js_to_string(v),
                None => "0".to_string(),
            },
        },
        avatar: non_empty(str_of(field(user_json, "avatar")))
            .or_else(|| non_empty(str_of(field(item, "avatar")))),
        created: norm_ts(field(item, "created")),
        sub_num: num_of(field(item, "subNum")),
        parent_comments,
        reviewid: field(item, "reviewid").map(js_to_string),
    }
}

fn optional_str(value: Option<&Value>) -> Option<String> {
    non_empty(str_of(value))
}

/// `parentComments` 的某个字符串字段（1.x 是原样透传，缺失/空串都算无）。
fn parent_field(obj: &crate::adapters::read::JsonObject, key: &str) -> Option<String> {
    let value = obj.get(key)?.to_value();
    optional_str(Some(&value))
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

// ---------- 脱敏（`activity-rules.ts:66` `sanitizeCommentList`） ----------

/// 过滤服务端占位评论；文章匿名活动期内，评论者即文章作者时隐藏其展示名/头像。
pub fn sanitize_comment_list(
    items: Vec<CommentItem>,
    anonymous_cids: Option<&BTreeSet<String>>,
) -> Vec<CommentItem> {
    let mut filtered: Vec<CommentItem> = items
        .into_iter()
        .filter(|item| !rules::is_server_hidden(&item.text))
        .collect();
    let Some(cids) = anonymous_cids.filter(|set| !set.is_empty()) else {
        return filtered;
    };
    for item in &mut filtered {
        if !cids.contains(&item.cid) {
            continue;
        }
        let author_id = item.author_id.as_str();
        let article_author_id = item.article_author_id.as_deref().unwrap_or("");
        if rules::should_anonymize_comment(author_id, article_author_id) {
            item.author = "匿名用户".to_string();
            item.avatar = None;
        }
    }
    filtered
}

/// 匿名活动文章 cid 集合（`read.adapter.ts:833` `anonymousCidsOf`）。
pub fn anonymous_cids_of(items: &[CommentItem]) -> BTreeSet<String> {
    items
        .iter()
        .filter(|item| item.article_is_anonymous && !item.cid.is_empty())
        .map(|item| item.cid.clone())
        .collect()
}

/// 补全评论所属文章的 `authorId` / `isAnonymous`（`read.adapter.ts:814`）。
pub fn enrich_comments_with_article_meta(ctx: &CoreCtx, items: &mut [CommentItem]) {
    let mut cids: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for item in items.iter() {
        if !item.cid.is_empty() && seen.insert(item.cid.clone()) {
            cids.push(item.cid.clone());
        }
    }
    if cids.is_empty() {
        return;
    }
    let mut metas = std::collections::BTreeMap::new();
    for cid in cids {
        metas.insert(
            cid.clone(),
            crate::adapters::read::get_article_meta_by_cid(ctx, &cid),
        );
    }
    for item in items.iter_mut() {
        let Some(Some(meta)) = metas.get(&item.cid) else {
            continue;
        };
        let current = item.article_author_id.clone().unwrap_or_default();
        if current.is_empty() && !meta.author_id.is_empty() {
            item.article_author_id = Some(meta.author_id.clone());
        }
        if meta.is_anonymous {
            item.article_is_anonymous = true;
        }
    }
}

// ---------- 评审作者补全（`read.adapter.ts:677` `fillReviewAuthors`） ----------

/// 给前 4 条评论补 `reviewAuthor`（评审讨论卡片「中某某的评审」）。
pub fn fill_review_authors(ctx: &CoreCtx, items: &mut [CommentItem]) {
    let mut ids: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for item in items.iter().take(4) {
        let id = review_id_of(item);
        if !id.is_empty() && seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return;
    }
    let mut names = std::collections::BTreeMap::new();
    for id in ids {
        if let Some(name) = fetch_review_author_name(ctx, &id) {
            names.insert(id, name);
        }
    }
    if names.is_empty() {
        return;
    }
    for item in items.iter_mut() {
        let id = review_id_of(item);
        if let Some(name) = names.get(&id) {
            item.review_author = Some(name.clone());
        }
    }
}

/// 评论关联的评审 id（0/空 = 普通评论，`read.adapter.ts:670`）。
fn review_id_of(item: &CommentItem) -> String {
    match item.reviewid.as_deref() {
        None | Some("") | Some("0") => String::new(),
        Some(id) => id.to_string(),
    }
}

// ---------- 列表（`read.adapter.ts:841` `fetchCommentsBySearchParams`） ----------

/// 按 `searchParams` 拉评论，带「过滤占位评论后补页」的最多 5 次尝试。
///
/// 返回的 `items` 已过滤/脱敏；`nextPage` 是**下一次请求**的页码（1.x 语义）。
pub fn fetch_comments_by_search_params(
    ctx: &CoreCtx,
    search_params: &Value,
    limit: i64,
    page: i64,
    order: Option<&str>,
    search_key: Option<&str>,
) -> CoreResult<CommentListResult> {
    let token = net::token(ctx)?;
    let mut collected: Vec<CommentItem> = Vec::new();
    let mut total: i64 = 0;
    let mut current_page = page;
    let mut has_more = false;

    for attempt in 0..MAX_FETCH_ATTEMPTS {
        let mut options = ApiOptions::get()
            .query("searchParams", search_params.to_string())
            .query("limit", limit.to_string())
            .query("page", current_page.to_string());
        if let Some(order) = order.filter(|s| !s.is_empty()) {
            options = options.query("order", order);
        }
        if let Some(key) = search_key.filter(|s| !s.is_empty()) {
            options = options.query("searchKey", key);
        }
        if let Some(token) = token.as_deref() {
            options = options.query("token", token);
        }

        let resp = net::request::<Value>(ctx, endpoints::COMMENTS_LIST, &options)?;
        let raw = resp.data.as_array().cloned().unwrap_or_default();
        let raw_len = raw.len() as i64;
        let resp_total = resp.total.unwrap_or(0);
        // 1.x: `total = num(resp.total) || total || rawItems.length`
        total = if resp_total != 0 {
            resp_total
        } else if total != 0 {
            total
        } else {
            raw_len
        };

        let mut items: Vec<CommentItem> = raw.iter().map(to_comment_item).collect();
        enrich_comments_with_article_meta(ctx, &mut items);
        let anonymous = anonymous_cids_of(&items);
        let visible = sanitize_comment_list(items, Some(&anonymous));
        collected.extend(visible);

        current_page += 1;
        has_more = raw_len >= limit && (collected.len() as i64) >= limit;
        if raw_len < limit || (collected.len() as i64) >= limit || attempt == MAX_FETCH_ATTEMPTS - 1
        {
            break;
        }
    }

    let items = collected.into_iter().take(limit as usize).collect();
    Ok(CommentListResult {
        items,
        total,
        next_page: current_page,
        has_more,
    })
}

/// 拉取文章评论列表（`commentsList` + `searchParams={cid}`）。
pub fn list_comments(
    ctx: &CoreCtx,
    cid: &str,
    opts: &CommentListOptions,
) -> CoreResult<CommentListResult> {
    let search_params = Value::Object(Map::from_iter([(
        "cid".to_string(),
        Value::from(cid.to_string()),
    )]));
    fetch_comments_by_search_params(
        ctx,
        &search_params,
        opts.limit.unwrap_or(PAGE_SIZE),
        opts.page.unwrap_or(1),
        opts.order.as_deref(),
        None,
    )
}

/// 全局最新评论流（首页「最新讨论」；`type=comment&status=approved`，默认按 created 倒序）。
pub fn list_recent_comments(
    ctx: &CoreCtx,
    opts: &CommentListOptions,
) -> CoreResult<CommentListOut> {
    let token = net::token(ctx)?;
    let order = opts.order.as_deref().filter(|s| !s.is_empty());
    let mut options = ApiOptions::get()
        .query(
            "searchParams",
            Value::Object(Map::from_iter([
                ("type".to_string(), Value::from("comment")),
                ("status".to_string(), Value::from("approved")),
            ]))
            .to_string(),
        )
        .query("limit", opts.limit.unwrap_or(RECENT_PAGE_SIZE).to_string())
        .query("page", opts.page.unwrap_or(1).to_string())
        .query("order", order.unwrap_or("created"));
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }

    let resp = net::request::<Value>(ctx, endpoints::COMMENTS_LIST, &options)?;
    let raw = resp.data.as_array().cloned().unwrap_or_default();
    let mut items: Vec<CommentItem> = raw.iter().map(to_comment_item).collect();

    // 1.x 并行跑两项补全（`Promise.all`），结果合并回同一下标。
    let mut with_meta = items.clone();
    enrich_comments_with_article_meta(ctx, &mut with_meta);
    let mut with_authors = items.clone();
    fill_review_authors(ctx, &mut with_authors);
    for (index, item) in with_meta.iter_mut().enumerate() {
        item.review_author = with_authors
            .get(index)
            .and_then(|author| author.review_author.clone());
        items[index] = item.clone();
    }

    let anonymous = anonymous_cids_of(&items);
    let items = sanitize_comment_list(items, Some(&anonymous));
    let total = resp.total.unwrap_or(0);
    let total = if total == 0 { raw.len() as i64 } else { total };
    Ok(CommentListOut { items, total })
}

/// 全局搜索评论（`commentsList` + `searchKey`）。
pub fn search_comments(ctx: &CoreCtx, keyword: &str, limit: i64) -> CoreResult<CommentListOut> {
    let search_params = Value::Object(Map::from_iter([(
        "type".to_string(),
        Value::from("comment"),
    )]));
    let result = fetch_comments_by_search_params(
        ctx,
        &search_params,
        limit,
        1,
        Some("created"),
        Some(keyword),
    )?;
    Ok(CommentListOut {
        items: result.items,
        total: result.total,
    })
}

// ---------- 发表评论（`read.adapter.ts:948` + `comment-request.ts`） ----------

/// 发表评论（`commentsAdd`，GET + `params` JSON；`parent`/`reviewid` 必须恒出现）。
///
/// 校验顺序与 `comment.handlers.ts:29` 逐字一致；校验失败返回 `Err`（1.x `fail(…)`），
/// 接口失败返回 `Ok(CommentSubmitResult{ok:false,error})`（1.x adapter 内部 catch）。
pub fn add_comment(ctx: &CoreCtx, payload: &Json) -> CoreResult<CommentSubmitResult> {
    let token = net::require_token(ctx, rules::NOT_LOGGED_IN)?;
    let value = payload.to_value();
    let obj = value
        .as_object()
        .ok_or_else(|| CoreError::app(rules::INVALID_PAYLOAD))?;

    // cid：1.x `String(payload.cid ?? '').trim()`，空串才拒绝（任何类型都先字符串化）。
    let cid = str_of(field(&value, "cid")).trim().to_string();
    if cid.is_empty() {
        return Err(CoreError::app(rules::MISSING_TARGET_CID));
    }

    let text = str_of(field(&value, "text")).trim().to_string();
    if let Err(message) = rules::validate_text(&text) {
        return Err(CoreError::app(message));
    }

    let parent = validate_id_like(obj, "parent", rules::INVALID_PARENT)?;
    let reviewid = validate_id_like(obj, "reviewid", rules::INVALID_REVIEW_LINK)?;

    let params = comment_params(&cid, parent.as_ref(), reviewid.as_ref());
    let options = ApiOptions::get()
        .query("params", params)
        .query("token", token)
        .query("text", text);

    match net::request::<Value>(ctx, endpoints::COMMENTS_ADD, &options) {
        Ok(_) => Ok(CommentSubmitResult {
            ok: true,
            error: None,
        }),
        Err(err) => Ok(CommentSubmitResult {
            ok: false,
            error: Some(err.to_string()),
        }),
    }
}

/// `parent` / `reviewid` 的类型校验：缺省/null 通过，其余只接受 string / number。
fn validate_id_like(
    obj: &Map<String, Value>,
    key: &str,
    message: &str,
) -> CoreResult<Option<Value>> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ (Value::String(_) | Value::Number(_))) => Ok(Some(value.clone())),
        Some(_) => Err(CoreError::app(message)),
    }
}

/// `comment-request.ts:buildCommentRequest` 的 `params` JSON。
///
/// `parent`/`reviewid` 必须**始终**出现（顶层评论传 0）：定制版服务端对缺 `parent`
/// 的请求会返回「接口请求异常，请联系管理员」。
fn comment_params(cid: &str, parent: Option<&Value>, reviewid: Option<&Value>) -> String {
    let mut params = Map::new();
    params.insert("cid".to_string(), Value::from(cid.to_string()));
    params.insert("parent".to_string(), normalize_optional_id(parent));
    params.insert("reviewid".to_string(), normalize_optional_id(reviewid));
    Value::Object(params).to_string()
}

/// `parent != null && String(parent) !== '0' ? parent : 0`。
fn normalize_optional_id(value: Option<&Value>) -> Value {
    match value {
        Some(value) if js_to_string(value) != "0" => value.clone(),
        _ => Value::from(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::read::{Json, JsonObject};
    use crate::testkit::Harness;
    use serde_json::json;

    fn item_json() -> Value {
        json!({
            "coid": 11,
            "cid": 88,
            "parent": 0,
            "text": "这是一条评论",
            "reviewid": 7,
            "subNum": 3,
            "created": 1700000000,
            "userJson": {"uid": 9, "name": "甲", "avatar": "a.png", "experience": 4},
            "contentsInfo": {"cid": 88, "title": "标题", "authorId": 5, "isAnonymous": 0}
        })
    }

    #[test]
    fn to_comment_item_maps_1x_fields() {
        let item = to_comment_item(&item_json());
        assert_eq!(item.coid, "11");
        assert_eq!(item.cid, "88");
        assert_eq!(item.parent, "0");
        assert_eq!(item.author, "甲");
        assert_eq!(item.author_id, "9");
        assert_eq!(item.avatar.as_deref(), Some("a.png"));
        assert_eq!(item.experience, Some(4));
        assert_eq!(item.article_title.as_deref(), Some("标题"));
        assert_eq!(item.article_author_id.as_deref(), Some("5"));
        assert!(!item.article_is_anonymous);
        assert_eq!(item.reviewid.as_deref(), Some("7"));
        assert_eq!(item.created, 1_700_000_000);
        assert_eq!(item.sub_num, 3);
    }

    #[test]
    fn to_comment_item_falls_back_to_top_level_author_and_anonymous_label() {
        let item = to_comment_item(&json!({"id": 1, "text": "x", "author": "乙"}));
        assert_eq!(item.coid, "1");
        assert_eq!(item.author, "乙");
        assert_eq!(item.author_id, "0");
        assert!(item.avatar.is_none());
        let item = to_comment_item(&json!({"id": 2, "text": "x"}));
        assert_eq!(item.author, "匿名");
    }

    #[test]
    fn to_comment_item_keeps_parent_comments() {
        let item = to_comment_item(&json!({
            "id": 1, "text": "x",
            "parentComments": {"author": "甲", "text": "上一条", "created": "2026-01-01"}
        }));
        let parent = item.parent_comments.unwrap();
        assert_eq!(parent.author.as_deref(), Some("甲"));
        assert_eq!(parent.text.as_deref(), Some("上一条"));
        assert_eq!(parent.created.as_deref(), Some("2026-01-01"));
    }

    #[test]
    fn sanitize_comment_list_filters_server_placeholder() {
        let hidden = CommentItem {
            text: " 活动期间，作者评论回复暂时隐藏 ".to_string(),
            ..CommentItem::default()
        };
        let normal = CommentItem {
            text: "正常评论".to_string(),
            ..CommentItem::default()
        };
        let out = sanitize_comment_list(vec![hidden, normal], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "正常评论");
    }

    #[test]
    fn sanitize_comment_list_anonymizes_author_who_is_article_author() {
        let items = vec![
            CommentItem {
                cid: "88".to_string(),
                author: "甲".to_string(),
                author_id: "5".to_string(),
                article_author_id: Some("5".to_string()),
                avatar: Some("a.png".to_string()),
                ..CommentItem::default()
            },
            CommentItem {
                cid: "88".to_string(),
                author: "乙".to_string(),
                author_id: "6".to_string(),
                article_author_id: Some("5".to_string()),
                ..CommentItem::default()
            },
        ];
        let cids: BTreeSet<String> = ["88".to_string()].into_iter().collect();
        let out = sanitize_comment_list(items, Some(&cids));
        assert_eq!(out[0].author, "匿名用户");
        assert!(out[0].avatar.is_none());
        assert_eq!(out[1].author, "乙");
    }

    #[test]
    fn anonymous_cids_only_from_anonymous_articles() {
        let items = vec![
            CommentItem {
                cid: "88".to_string(),
                article_is_anonymous: true,
                ..CommentItem::default()
            },
            CommentItem {
                cid: "99".to_string(),
                ..CommentItem::default()
            },
        ];
        let cids = anonymous_cids_of(&items);
        assert_eq!(cids.len(), 1);
        assert!(cids.contains("88"));
    }

    #[test]
    fn add_comment_requires_login() {
        let h = Harness::new().with_api_config();
        let err = add_comment(&h.ctx, &Json::Object(JsonObject::new())).unwrap_err();
        assert_eq!(err.to_string(), rules::NOT_LOGGED_IN);
    }

    #[test]
    fn add_comment_validates_payload_like_1x() {
        let h = Harness::new().with_api_config().with_token("t");
        let err = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"text": "够长的评论内容"})),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), rules::MISSING_TARGET_CID);

        let err = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"cid": "88", "text": "短"})),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), rules::TEXT_TOO_SHORT);

        let long = "长".repeat(2001);
        let err = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"cid": "88", "text": long})),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), rules::TEXT_TOO_LONG);

        let err = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"cid": "88", "text": "够长的评论内容", "parent": {}})),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), rules::INVALID_PARENT);

        let err = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"cid": "88", "text": "够长的评论内容", "reviewid": []})),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), rules::INVALID_REVIEW_LINK);

        let err = add_comment(&h.ctx, &Json::from_value(&json!("不是对象"))).unwrap_err();
        assert_eq!(err.to_string(), rules::INVALID_PAYLOAD);
    }

    #[test]
    fn add_comment_sends_params_with_parent_and_reviewid_zero() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": null}).to_string(),
        );
        let out = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"cid": "88", "text": "  够长的评论内容  "})),
        )
        .unwrap();
        assert!(out.ok);
        let request = h.last_request();
        assert!(request.url.contains("/api/commentsadd"));
        let params = request
            .url
            .split("params=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap();
        let decoded = urlencoding_decode(params);
        let value: Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(value["cid"], "88");
        assert_eq!(value["parent"], 0);
        assert_eq!(value["reviewid"], 0);
        assert!(request.url.contains("text="));
    }

    #[test]
    fn add_comment_passes_parent_and_reviewid_when_not_zero() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": null}).to_string(),
        );
        add_comment(
            &h.ctx,
            &Json::from_value(&json!({
                "cid": "88", "text": "够长的评论内容", "parent": "11", "reviewid": 7
            })),
        )
        .unwrap();
        let request = h.last_request();
        let params = request
            .url
            .split("params=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap();
        let value: Value = serde_json::from_str(&urlencoding_decode(params)).unwrap();
        assert_eq!(value["parent"], "11");
        assert_eq!(value["reviewid"], 7);
    }

    #[test]
    fn add_comment_maps_server_failure_to_result() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 0, "msg": "评论太频繁", "data": null}).to_string(),
        );
        let out = add_comment(
            &h.ctx,
            &Json::from_value(&json!({"cid": "88", "text": "够长的评论内容"})),
        )
        .unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("评论太频繁"));
    }

    #[test]
    fn list_comments_filters_hidden_and_fills_next_page() {
        let h = Harness::new().with_api_config().with_token("t");
        // 第 1 页：2 条里 1 条占位（过滤后不足 limit → 补第 2 页）
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 3, "data": [
                {"coid": 1, "cid": 88, "text": "活动期间，作者评论回复暂时隐藏"},
                {"coid": 2, "cid": 88, "text": "正常评论"}
            ]})
            .to_string(),
        );
        // 文章元数据（contentsList 查询，按 cid）
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"cid": 88, "authorId": 5, "isAnonymous": 0}
            ]})
            .to_string(),
        );
        // 活动 mid 集合（metasList，补全元数据时顺带触发）
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        // 第 2 页
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"coid": 3, "cid": 88, "text": "第三条"},
                {"coid": 4, "cid": 88, "text": "第四条"}
            ]})
            .to_string(),
        );
        let out = list_comments(
            &h.ctx,
            "88",
            &CommentListOptions {
                limit: Some(2),
                page: Some(1),
                order: None,
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 2);
        assert_eq!(out.items[0].text, "正常评论");
        assert_eq!(out.total, 3);
        assert_eq!(out.next_page, 3);
        assert!(out.has_more);
    }

    #[test]
    fn list_comments_stops_when_short_page() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"coid": 1, "cid": 88, "text": "唯一一条"}
            ]})
            .to_string(),
        );
        // 文章元数据（contentsList，按 cid）与活动 mid 集合（metasList）。
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"cid": 88, "authorId": 5}
            ]})
            .to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = list_comments(&h.ctx, "88", &CommentListOptions::default()).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.next_page, 2);
        assert!(!out.has_more);
    }

    #[test]
    fn list_recent_comments_fills_review_author() {
        let h = Harness::new().with_api_config().with_token("t");
        // 1) commentsList（最新评论流）
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"coid": 1, "cid": 88, "text": "评论", "reviewid": 7,
                 "contentsInfo": {"cid": 88, "title": "标题", "authorId": 5, "isAnonymous": 1}}
            ]})
            .to_string(),
        );
        // 2) 文章元数据（contentsList，按 cid）
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"cid": 88, "authorId": 5, "isAnonymous": 0}
            ]})
            .to_string(),
        );
        // 3) 活动 mid 集合（metasList）
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        // 4) fillReviewAuthors 的 reviewList 查询
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"userJson": {"name": "评审者"}}
            ]})
            .to_string(),
        );
        let out = list_recent_comments(&h.ctx, &CommentListOptions::default()).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].review_author.as_deref(), Some("评审者"));
        assert_eq!(out.total, 1);
    }

    #[test]
    fn search_comments_uses_search_key_and_returns_items_total() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"coid": 1, "cid": 88, "text": "命中"}
            ]})
            .to_string(),
        );
        let out = search_comments(&h.ctx, "关键词", SEARCH_PAGE_SIZE).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.total, 1);
        // 之后还有补全元数据的 contentsList 请求，这里断言第一条。
        let request = h.requests().into_iter().next().unwrap();
        assert!(request.url.contains("searchKey="));
        assert!(request.url.contains("order=created"));
    }

    /// 最小 form-urlencoded 解码（测试断言 `params=` 的 JSON 用）。
    fn urlencoding_decode(input: &str) -> String {
        let bytes = input.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00");
                    out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                    i += 3;
                }
                byte => {
                    out.push(byte);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).to_string()
    }
}
