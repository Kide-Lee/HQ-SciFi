//! 评审侧适配层：远端 JSON → 渲染层结构（原 `read.adapter.ts:580-745` 的评审子集
//! + `src/main/ipc/review.handlers.ts` 的入参校验）。
//!
//! 1.x 的评审规整逻辑物理上在 `read.adapter.ts`（`toReviewItem` / `listReviews` /
//! `submitReview` / `setReviewAttitude` / `listReviewTasks` / `listMyReviews`），
//! 校验逻辑在 IPC handler；这里按职责拆成两层：
//! - [`crate::domain::review`]：无 IO 的纯判定（维度文案、分数区间、分数隐藏、`Number()` 近似）；
//! - 本模块：请求 + 逐字段规整 + 排序/匿名化。
//!
//! 与 1.x 的接口形态差异（不影响契约）：
//! - 1.x 的 `submitReview` / `setReviewAttitude` 用「返回 `{ok:false,error}`」表达接口失败，
//!   校验失败则由 handler `fail()` 抛错；Rust 侧保持同样分工：校验失败 → `Err(CoreError)`，
//!   接口失败 → `Ok(ReviewSubmitResult{ok:false, …})`。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::adapters::read::{
    ArticleFetchError, Json, JsonObject, StrOrNum, field, field_or, fill_article_anon_meta,
    get_ongoing_review_mids, js_to_string, json_object_of, non_empty, norm_ts, num_of, session_uid,
    str_of,
};
use crate::ctx::CoreCtx;
use crate::domain::review as rules;
use crate::error::{CoreError, CoreResult};
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::services::net;

/// 评审列表默认每页条数（`read.adapter.ts:612`）。
pub const PAGE_SIZE: i64 = 20;

/// 「我的评审」分页大小与页数上限（`read.adapter.ts:375-397`，防呆 20 页 / 1000 条）。
const MY_REVIEWS_PAGE_SIZE: i64 = 50;
const MY_REVIEWS_MAX_PAGES: i64 = 20;

/// 评审作者名补全的超时（`read.adapter.ts:646` 的 `withTimeout(…, 3000)`）。
const AUTHOR_NAME_TIMEOUT_MS: u64 = 3_000;

// ---------- 输出结构 ----------

/// 评审条目（`src/shared/domain/index.ts:299` `ReviewItem`）。
///
/// 字段全是 `String` / `i64` 而非 `Option`：1.x 的 `toReviewItem` 对每个字段都调
/// `str()` / `num()`（缺失即 `''` / `0`），只有显式 `!= null` 才给 `undefined` 的字段
/// 才是 `Option`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub id: String,
    pub cid: String,
    pub activeid: Option<String>,
    /// 评者 uid（1.x 恒为字符串：`item.uid != null ? str(item.uid) : str(userJson.uid ?? '')`）。
    pub uid: String,
    pub is_ai: i64,
    pub attitude_type: i64,
    pub actualscore: String,
    /// 逗号分隔五维分数（dianzi,wenbi,jiezou,renwu,liyi）。
    pub score: String,
    pub dianzi: String,
    pub wenbi: String,
    pub renwu: String,
    pub jiezou: String,
    pub liyi: String,
    pub zonghe: String,
    pub joy: i64,
    pub helpful: i64,
    pub earnest: i64,
    pub reply_num: i64,
    /// 进行中活动不展示评分（[`sanitize_review_list`] 设置）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_score: Option<bool>,
    pub user_json: Option<JsonObject>,
    pub article_info: Option<JsonObject>,
    /// 所属文章作者 uid（全局评审流由 [`fill_article_anon_meta`] 补全）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_author_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_is_anonymous: Option<bool>,
    pub created: i64,
}

/// 评审任务（`src/shared/domain/index.ts:372` `ReviewTaskItem`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTaskItem {
    pub cid: String,
    /// 0 = 待评审 / 1 = 已完成（服务端口径）。
    pub status: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activeid: Option<String>,
    pub active_name: String,
    pub article_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
}

/// 提交/表态的返回（`src/shared/domain/index.ts:364` `ReviewSubmitResult`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ReviewSubmitResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ReviewSubmitResult {
    fn success() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// 「我的评审」结果（`read.adapter.ts:375`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MyReviews {
    pub cids: Vec<String>,
}

/// `list-reviews` 的入参（`review.handlers.ts:8` + `read.adapter.ts:612`）。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewListOptions {
    pub cid: Option<String>,
    pub activeid: Option<StrOrNum>,
    pub limit: Option<i64>,
    pub page: Option<i64>,
    pub order: Option<String>,
    /// `search-reviews` 走同一 adapter（1.x `listReviews` 也吃 `searchKey`）。
    pub search_key: Option<String>,
}

/// `list-reviews` / `search-reviews` 的返回（`ApiResult<{items,total}>`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewListOut {
    pub items: Vec<ReviewItem>,
    pub total: i64,
}

// ---------- 逐字段规整（`read.adapter.ts:580` `toReviewItem`） ----------

/// 远端评审原始 JSON → [`ReviewItem`]。
pub fn to_review_item(item: &Value) -> ReviewItem {
    let user_json = field(item, "userJson").and_then(json_object_of);
    // 1.x: `articleInfo: (item.articleInfo ?? item.contentJson) as Record<…> | undefined`
    let article_info = field_or(item, &["articleInfo", "contentJson"]).and_then(json_object_of);
    let uid = match field(item, "uid") {
        Some(v) => js_to_string(v),
        None => user_json
            .as_ref()
            .and_then(|obj| obj.get("uid"))
            .map(|uid| js_to_string(&uid.to_value()))
            .unwrap_or_default(),
    };
    ReviewItem {
        id: str_of(field_or(item, &["id", "rid"])),
        cid: str_of(field_or(item, &["cid", "key"])),
        activeid: field(item, "activeid").map(js_to_string),
        uid,
        is_ai: num_of(field(item, "isAi")),
        attitude_type: num_of(field(item, "attitudeType")),
        actualscore: str_of(field(item, "actualscore")),
        score: str_of(field(item, "score")),
        dianzi: str_of(field(item, "dianzi")),
        wenbi: str_of(field(item, "wenbi")),
        renwu: str_of(field(item, "renwu")),
        jiezou: str_of(field(item, "jiezou")),
        liyi: str_of(field(item, "liyi")),
        zonghe: str_of(field(item, "zonghe")),
        joy: num_of(field(item, "joy")),
        helpful: num_of(field(item, "helpful")),
        earnest: num_of(field(item, "earnest")),
        reply_num: num_of(field(item, "replyNum")),
        hide_score: None,
        user_json,
        article_info,
        article_author_id: None,
        article_is_anonymous: None,
        created: norm_ts(field(item, "created")),
    }
}

// ---------- 列表（`read.adapter.ts:612` `listReviews`） ----------

/// 拉取评审列表（`reviewList`）。
///
/// `cid` 存在时只取该文章的评审（不补文章匿名元数据）；否则按全局评审流处理，
/// 补全 `articleAuthorId` / `articleIsAnonymous`（1.x `fillArticleAnonMeta`，前 4 条）。
pub fn list_reviews(ctx: &CoreCtx, opts: &ReviewListOptions) -> CoreResult<ReviewListOut> {
    let token = net::token(ctx)?;

    let mut search = Map::new();
    if let Some(cid) = opts.cid.as_deref().filter(|s| !s.is_empty()) {
        search.insert("cid".to_string(), Value::from(cid));
    }
    if let Some(activeid) = &opts.activeid {
        // 1.x: `activeid != null && activeid !== 0`——数字 0 排除，字符串 "0" 不排除。
        if !matches!(activeid, StrOrNum::Number(0)) {
            search.insert("activeid".to_string(), activeid.to_value());
        }
    }

    let mut options = ApiOptions::get()
        .query("searchParams", Value::Object(search.clone()).to_string())
        .query("limit", opts.limit.unwrap_or(PAGE_SIZE).to_string())
        .query("page", opts.page.unwrap_or(1).to_string());
    if let Some(order) = opts.order.as_deref().filter(|s| !s.is_empty()) {
        options = options.query("order", order);
    }
    if let Some(key) = opts.search_key.as_deref().filter(|s| !s.is_empty()) {
        options = options.query("searchKey", key);
    }
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }

    let resp = net::request::<Value>(ctx, endpoints::REVIEW_LIST, &options)?;
    let raw_items = resp.data.as_array().cloned().unwrap_or_default();
    let mut items: Vec<ReviewItem> = raw_items.iter().map(to_review_item).collect();

    let my_uid = session_uid(ctx)?;
    let mids = get_ongoing_review_mids(ctx);
    sanitize_review_list(&mut items, &mids, my_uid.as_deref());

    // 1.x: `opts.cid ? items : await fillArticleAnonMeta(token, items)`
    if opts.cid.is_none() {
        let cids: Vec<String> = items
            .iter()
            .take(4)
            .map(|it| it.cid.clone())
            .filter(|cid| !cid.is_empty())
            .collect();
        let metas = fill_article_anon_meta(ctx, &cids);
        for item in &mut items {
            let Some(meta) = metas.get(&item.cid) else {
                continue;
            };
            if item
                .article_author_id
                .as_deref()
                .map(str::is_empty)
                .unwrap_or(true)
                && !meta.author_id.is_empty()
            {
                item.article_author_id = Some(meta.author_id.clone());
            }
            if meta.is_anonymous {
                item.article_is_anonymous = Some(true);
            }
        }
    }

    let total = resp.total.unwrap_or(0);
    let total = if total == 0 {
        items.len() as i64
    } else {
        total
    };
    Ok(ReviewListOut { items, total })
}

/// 进行中活动的评审分数隐藏（`activity-rules.ts:52` `sanitizeReviewList`）。
///
/// 本人评审保留自己的分数（`myUid` 非空且与该条 `uid` 相等时视为本人）。
pub fn sanitize_review_list(
    items: &mut [ReviewItem],
    mids: &BTreeSet<String>,
    my_uid: Option<&str>,
) {
    for item in items.iter_mut() {
        if rules::should_hide_review_score(item.activeid.as_deref(), mids, &item.uid, my_uid) {
            item.actualscore = rules::HIDDEN_SCORE.to_string();
            item.score = rules::HIDDEN_SCORE_LIST.to_string();
            item.hide_score = Some(true);
        }
    }
}

// ---------- 任务 / 我的评审（`read.adapter.ts:345` / `:375`） ----------

/// 拉取当前账号的评审任务（`reviewTask`；status 0=待评审 / 1=已完成）。
pub fn list_review_tasks(ctx: &CoreCtx, uid: &StrOrNum) -> CoreResult<Vec<ReviewTaskItem>> {
    let token = net::token(ctx)?;
    let mut options = ApiOptions::get()
        .query("uid", uid.as_id())
        .query("limit", "100")
        .query("page", "1");
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }

    let resp = net::request::<Value>(ctx, endpoints::REVIEW_TASK, &options)?;
    let raw_items = resp.data.as_array().cloned().unwrap_or_default();
    Ok(raw_items
        .iter()
        .map(|t| {
            let content_json = field(t, "contentJson").unwrap_or(&Value::Null);
            let active_json = field(t, "activeJson").unwrap_or(&Value::Null);
            ReviewTaskItem {
                cid: cid_of(t, content_json),
                status: num_of(field(t, "status")),
                activeid: field(t, "activeid").map(js_to_string),
                active_name: str_of(field(active_json, "name")),
                article_title: str_of(field(content_json, "title")),
                created: non_empty_ts(norm_ts(field(t, "created"))),
            }
        })
        .collect())
}

/// `normTs(t.created) || undefined`。
fn non_empty_ts(ts: i64) -> Option<i64> {
    if ts == 0 { None } else { Some(ts) }
}

/// 拉取当前账号写过的全部评审 cid（`reviewList` searchParams={uid}，分页 20 页防呆）。
pub fn list_my_reviews(ctx: &CoreCtx, uid: &StrOrNum) -> CoreResult<MyReviews> {
    let token = net::token(ctx)?;
    let mut cids: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for page in 1..=MY_REVIEWS_MAX_PAGES {
        let mut options = ApiOptions::get()
            .query(
                "searchParams",
                Value::Object(Map::from_iter([("uid".to_string(), uid.to_value())])).to_string(),
            )
            .query("limit", MY_REVIEWS_PAGE_SIZE.to_string())
            .query("page", page.to_string());
        if let Some(token) = token.as_deref() {
            options = options.query("token", token);
        }

        let resp = net::request::<Value>(ctx, endpoints::REVIEW_LIST, &options)?;
        let items = resp.data.as_array().cloned().unwrap_or_default();
        for it in &items {
            let content_json = field(it, "contentJson").unwrap_or(&Value::Null);
            let cid = cid_of(it, content_json);
            if !cid.is_empty() && seen.insert(cid.clone()) {
                cids.push(cid);
            }
        }
        if (items.len() as i64) < MY_REVIEWS_PAGE_SIZE {
            break;
        }
    }
    Ok(MyReviews { cids })
}

/// 1.x: `str(it.cid ?? contentJson.cid ?? contentJson.id ?? '')`。
fn cid_of(item: &Value, content_json: &Value) -> String {
    if let Some(v) = field(item, "cid") {
        return js_to_string(v);
    }
    str_of(field_or(content_json, &["cid", "id"]))
}

// ---------- 提交 / 编辑 / 表态（`read.adapter.ts:696-745`） ----------

/// 提交或编辑评审（`addReview` / `editReview`）。
///
/// 校验顺序与 1.x handler 逐字一致：token → payload 形状 → cid → id → 五维评语 → 五维评分；
/// 校验失败返回 `Err(CoreError::app(文案))`（1.x `fail(…)`），接口失败返回
/// `Ok(ReviewSubmitResult{ok:false,error})`（1.x adapter 内部 catch）。
pub fn submit_review(ctx: &CoreCtx, payload: &Json) -> CoreResult<ReviewSubmitResult> {
    let token = net::require_token(ctx, rules::NOT_LOGGED_IN_SUBMIT)?;
    let value = payload.to_value();
    let obj = value
        .as_object()
        .ok_or_else(|| CoreError::app(rules::INVALID_PAYLOAD))?;

    // cid：必须是非空字符串（1.x `typeof payload.cid !== 'string' || !payload.cid`）。
    match field(&value, "cid") {
        Some(Value::String(cid)) if !cid.is_empty() => {}
        _ => return Err(CoreError::app(rules::MISSING_CID)),
    }

    // id：可缺省；存在时只接受 string / number。
    if let Some(id) = field(&value, "id")
        && !matches!(id, Value::String(_) | Value::Number(_))
    {
        return Err(CoreError::app(rules::INVALID_REVIEW_ID));
    }

    for dimension in rules::DIMENSIONS {
        let text = match field(&value, dimension) {
            Some(Value::String(text)) => text.trim().to_string(),
            _ => String::new(),
        };
        if let Err(message) = rules::validate_dimension_text(dimension, &text) {
            return Err(CoreError::app(message));
        }
        let key = format!("{dimension}Score");
        // 1.x `Number(payload[key])`；key 缺失时是 `Number(undefined) = NaN`（非法）。
        let score = match field(&value, &key) {
            Some(raw) => rules::js_number(Some(raw)),
            None => f64::NAN,
        };
        if let Err(message) = rules::validate_dimension_score(dimension, score) {
            return Err(CoreError::app(message));
        }
    }

    let params = review_params(obj);
    let is_edit = field(&value, "id")
        .map(|id| match id {
            Value::String(s) => !s.is_empty(),
            _ => true,
        })
        .unwrap_or(false);
    let path = if is_edit {
        endpoints::EDIT_REVIEW
    } else {
        endpoints::ADD_REVIEW
    };
    let options = ApiOptions::get()
        .query("params", params)
        .query("token", token);

    match net::request::<Value>(ctx, path, &options) {
        Ok(_) => Ok(ReviewSubmitResult::success()),
        Err(err) => Ok(ReviewSubmitResult::failure(err.to_string())),
    }
}

/// `read.adapter.ts:696` `reviewParams`：拼 `addReview` / `editReview` 的 params JSON。
fn review_params(obj: &Map<String, Value>) -> String {
    let mut params = Map::new();
    for dimension in rules::DIMENSIONS {
        params.insert(dimension.to_string(), score_value(obj, dimension));
    }
    for dimension in rules::DIMENSIONS {
        let key = format!("{dimension}Score");
        let score = match obj.get(&key) {
            Some(raw) => raw.clone(),
            None => Value::Null,
        };
        params.insert(key, score);
    }
    if let Some(cid) = obj.get("cid") {
        params.insert("cid".to_string(), cid.clone());
    }
    // score 是「五维顺序」的逗号串：dianzi,wenbi,jiezou,renwu,liyi（与 DIMENSIONS 的
    // dianzi,wenbi,renwu,jiezou,liyi 不同！1.x 第 3、4 位是 jiezou,renwu）。
    let score_order = [
        "dianziScore",
        "wenbiScore",
        "jiezouScore",
        "renwuScore",
        "liyiScore",
    ];
    let joined = score_order
        .iter()
        .map(|key| match obj.get(*key) {
            Some(raw) => js_to_string(raw),
            None => "undefined".to_string(),
        })
        .collect::<Vec<_>>()
        .join(",");
    params.insert("score".to_string(), Value::from(joined));
    if let Some(zonghe) = obj.get("zonghe").filter(|v| truthy(v)) {
        params.insert("zonghe".to_string(), zonghe.clone());
    }
    if let Some(activeid) = obj.get("activeid").filter(|v| !is_zero(v)) {
        params.insert("activeid".to_string(), activeid.clone());
    }
    if let Some(id) = obj.get("id").filter(|v| !is_empty_string(v)) {
        params.insert("id".to_string(), id.clone());
    }
    Value::Object(params).to_string()
}

/// 维度评语在 params 里的取值（1.x 直接透传 payload 原值）。
fn score_value(obj: &Map<String, Value>, dimension: &str) -> Value {
    obj.get(dimension).cloned().unwrap_or(Value::Null)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn is_zero(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s == "0",
        _ => false,
    }
}

fn is_empty_string(value: &Value) -> bool {
    matches!(value, Value::String(s) if s.is_empty())
}

/// 评审表态（`read.adapter.ts:733` `setReviewAttitude`；POST body `{token,id,type}`）。
pub fn set_review_attitude(
    ctx: &CoreCtx,
    review_id: &StrOrNum,
    attitude_type: i64,
) -> CoreResult<ReviewSubmitResult> {
    let token = net::require_token(ctx, rules::NOT_LOGGED_IN_ATTITUDE)?;
    let options = ApiOptions::post()
        .body("token", token)
        .body("id", review_id.as_id())
        .body("type", attitude_type.to_string());

    match net::request::<Value>(ctx, endpoints::ATTITUDE, &options) {
        Ok(_) => Ok(ReviewSubmitResult::success()),
        Err(err) => Ok(ReviewSubmitResult::failure(err.to_string())),
    }
}

// ---------- 评论列表的评审作者补全（`read.adapter.ts:646`） ----------

/// 查评审作者显示名（`userJson.name ?? userJson.nickname`）；失败/超时返回 `None`。
pub fn fetch_review_author_name(ctx: &CoreCtx, review_id: &str) -> Option<String> {
    let token = net::token(ctx).ok()?;
    let mut options = ApiOptions::get()
        .query(
            "searchParams",
            Value::Object(Map::from_iter([("id".to_string(), Value::from(review_id))])).to_string(),
        )
        .query("limit", "2")
        .query("page", "1")
        .timeout(AUTHOR_NAME_TIMEOUT_MS);
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }

    let resp = net::request::<Value>(ctx, endpoints::REVIEW_LIST, &options).ok()?;
    let first = resp.data.as_array()?.first()?;
    let user_json = field(first, "userJson")?;
    let name = str_of(field_or(user_json, &["name", "nickname"]));
    non_empty(name)
}

// ---------- 文章不可读错误（`read.adapter.ts:408`，read handler 会据此包装文案） ----------

/// 把 [`ArticleFetchError`] 的「服务端明确拒绝」判定透出给命令层（1.x `instanceof` 检查）。
pub fn is_article_unavailable(err: &ArticleFetchError) -> bool {
    err.is_unavailable()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    fn review_error(err: CoreError) -> String {
        err.to_string()
    }

    #[test]
    fn to_review_item_matches_1x() {
        let item = json!({
            "id": 12,
            "cid": 88,
            "activeid": "3",
            "isAi": 1,
            "attitudeType": "2",
            "actualscore": 7.5,
            "score": "8,7,6,9,7",
            "dianzi": "设定",
            "wenbi": "文笔",
            "renwu": "人物",
            "jiezou": "节奏",
            "liyi": "立意",
            "zonghe": "综合",
            "joy": 1,
            "helpful": 2,
            "earnest": 3,
            "replyNum": 4,
            "userJson": {"uid": 9, "name": "甲"},
            "contentJson": {"cid": 88, "title": "标题"},
            "created": 1700000000
        });
        let review = to_review_item(&item);
        assert_eq!(review.id, "12");
        assert_eq!(review.cid, "88");
        assert_eq!(review.activeid.as_deref(), Some("3"));
        assert_eq!(review.uid, "9");
        assert_eq!(review.actualscore, "7.5");
        assert_eq!(review.score, "8,7,6,9,7");
        assert_eq!(review.reply_num, 4);
        assert_eq!(review.created, 1_700_000_000);
        assert_eq!(
            review.article_info.as_ref().and_then(|a| a.get("title")),
            Some(&Json::String("标题".to_string()))
        );
        assert!(review.hide_score.is_none());
    }

    #[test]
    fn to_review_item_keeps_uid_from_top_level_when_present() {
        let item = json!({"id": 1, "uid": 5, "userJson": {"uid": 9}});
        assert_eq!(to_review_item(&item).uid, "5");
        let item = json!({"id": 1, "userJson": {"uid": 9}});
        assert_eq!(to_review_item(&item).uid, "9");
        let item = json!({"id": 1});
        assert_eq!(to_review_item(&item).uid, "");
    }

    #[test]
    fn sanitize_review_list_hides_activity_scores_but_keeps_mine() {
        let mids: BTreeSet<String> = ["3".to_string()].into_iter().collect();
        let mut items = vec![
            ReviewItem {
                id: "1".to_string(),
                activeid: Some("3".to_string()),
                uid: "7".to_string(),
                actualscore: "7".to_string(),
                score: "1,2,3,4,5".to_string(),
                ..ReviewItem::default()
            },
            ReviewItem {
                id: "2".to_string(),
                activeid: Some("3".to_string()),
                uid: "9".to_string(),
                actualscore: "8".to_string(),
                score: "2,3,4,5,6".to_string(),
                ..ReviewItem::default()
            },
        ];
        sanitize_review_list(&mut items, &mids, Some("9"));
        // 他人评审隐藏，本人评审保留（activity-rules.ts:52 的例外）。
        assert_eq!(items[0].actualscore, "-.-");
        assert_eq!(items[0].score, "-.-,-.-,-.-,-.-,-.-");
        assert_eq!(items[0].hide_score, Some(true));
        assert_eq!(items[1].actualscore, "8");
        assert_eq!(items[1].hide_score, None);
    }

    #[test]
    fn sanitize_review_list_keeps_non_activity_scores() {
        let mids: BTreeSet<String> = BTreeSet::new();
        let mut items = vec![ReviewItem {
            activeid: Some("4".to_string()),
            actualscore: "7".to_string(),
            ..ReviewItem::default()
        }];
        sanitize_review_list(&mut items, &mids, None);
        assert_eq!(items[0].actualscore, "7");
        assert!(items[0].hide_score.is_none());
    }

    #[test]
    fn submit_review_requires_login() {
        let h = Harness::new().with_api_config();
        let err = submit_review(&h.ctx, &Json::Object(JsonObject::new())).unwrap_err();
        assert_eq!(review_error(err), rules::NOT_LOGGED_IN_SUBMIT);
    }

    #[test]
    fn submit_review_validates_dimension_length_and_score() {
        let h = Harness::new().with_api_config().with_token("t");
        let payload = json!({
            "cid": "88",
            "dianzi": "太短",
            "wenbi": "足够长的文笔评语内容",
            "renwu": "足够长的人物评语内容",
            "jiezou": "足够长的节奏评语内容",
            "liyi": "足够长的立意评语内容",
            "dianziScore": 5,
            "wenbiScore": 5,
            "renwuScore": 5,
            "jiezouScore": 5,
            "liyiScore": 5
        });
        let err = submit_review(&h.ctx, &Json::from_value(&payload)).unwrap_err();
        assert_eq!(review_error(err), "「dianzi」评语需至少 10 字");

        let payload = json!({
            "cid": "88",
            "dianzi": "足够长的设定评语内容",
            "wenbi": "足够长的文笔评语内容",
            "renwu": "足够长的人物评语内容",
            "jiezou": "足够长的节奏评语内容",
            "liyi": "足够长的立意评语内容",
            "dianziScore": 11,
            "wenbiScore": 5,
            "renwuScore": 5,
            "jiezouScore": 5,
            "liyiScore": 5
        });
        let err = submit_review(&h.ctx, &Json::from_value(&payload)).unwrap_err();
        assert_eq!(review_error(err), "「dianzi」评分需在 0-10 之间");
    }

    #[test]
    fn submit_review_posts_params_json_to_add_review() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": null}).to_string(),
        );
        let payload = json!({
            "cid": "88",
            "dianzi": "足够长的设定评语内容",
            "wenbi": "足够长的文笔评语内容",
            "renwu": "足够长的人物评语内容",
            "jiezou": "足够长的节奏评语内容",
            "liyi": "足够长的立意评语内容",
            "dianziScore": 8,
            "wenbiScore": 7,
            "renwuScore": 6,
            "jiezouScore": 9,
            "liyiScore": 5,
            "zonghe": "综合评语",
            "activeid": 3
        });
        let result = submit_review(&h.ctx, &Json::from_value(&payload)).unwrap();
        assert!(result.ok);
        let request = h.last_request();
        assert!(request.url.contains("/api/addreview"));
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
        assert_eq!(value["score"], "8,7,9,6,5");
        assert_eq!(value["zonghe"], "综合评语");
        assert_eq!(value["activeid"], 3);
        assert!(value.get("id").is_none());
    }

    #[test]
    fn submit_review_maps_server_failure_to_result() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 0, "msg": "评语太短", "data": null}).to_string(),
        );
        let payload = json!({
            "cid": "88",
            "dianzi": "足够长的设定评语内容",
            "wenbi": "足够长的文笔评语内容",
            "renwu": "足够长的人物评语内容",
            "jiezou": "足够长的节奏评语内容",
            "liyi": "足够长的立意评语内容",
            "dianziScore": 8,
            "wenbiScore": 7,
            "renwuScore": 6,
            "jiezouScore": 9,
            "liyiScore": 5
        });
        let result = submit_review(&h.ctx, &Json::from_value(&payload)).unwrap();
        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("评语太短"));
    }

    #[test]
    fn submit_review_uses_edit_review_when_id_present() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": null}).to_string(),
        );
        let payload = json!({
            "cid": "88",
            "id": 7,
            "dianzi": "足够长的设定评语内容",
            "wenbi": "足够长的文笔评语内容",
            "renwu": "足够长的人物评语内容",
            "jiezou": "足够长的节奏评语内容",
            "liyi": "足够长的立意评语内容",
            "dianziScore": 8,
            "wenbiScore": 7,
            "renwuScore": 6,
            "jiezouScore": 9,
            "liyiScore": 5
        });
        let result = submit_review(&h.ctx, &Json::from_value(&payload)).unwrap();
        assert!(result.ok);
        assert!(h.last_request().url.contains("/api/editreview"));
    }

    #[test]
    fn set_review_attitude_posts_form_body() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": null}).to_string(),
        );
        let result = set_review_attitude(&h.ctx, &StrOrNum::Number(7), 1).unwrap();
        assert!(result.ok);
        let request = h.last_request();
        assert_eq!(request.method, "POST");
        let body = String::from_utf8_lossy(request.body.as_deref().unwrap()).to_string();
        assert!(body.contains("id=7"));
        assert!(body.contains("type=1"));
        assert!(body.contains("token=t"));
    }

    #[test]
    fn list_reviews_builds_query_and_sanitizes() {
        let h = Harness::new().with_api_config().with_token("t");
        // 1) reviewList 列表
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"id": 1, "cid": 88, "uid": 9, "activeid": 3, "created": 1700000000}
            ]})
            .to_string(),
        );
        // 2) 活动 mid 列表（metasList）
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"mid": 3, "name": "活动", "activeStatus": 1}
            ]})
            .to_string(),
        );
        // 3) 文章匿名元数据（contentsList）
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"cid": 88, "authorId": 5, "isAnonymous": 1}
            ]})
            .to_string(),
        );
        let out = list_reviews(&h.ctx, &ReviewListOptions::default()).unwrap();
        assert_eq!(out.total, 1);
        assert_eq!(out.items[0].actualscore, "-.-");
        assert_eq!(out.items[0].hide_score, Some(true));
        assert_eq!(out.items[0].article_author_id.as_deref(), Some("5"));
        assert_eq!(out.items[0].article_is_anonymous, Some(true));
    }

    #[test]
    fn list_my_reviews_collects_unique_cids_and_stops_on_short_page() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"cid": 88}, {"contentJson": {"cid": 99}}, {"cid": 88}
            ]})
            .to_string(),
        );
        let out = list_my_reviews(&h.ctx, &StrOrNum::Text("9".to_string())).unwrap();
        assert_eq!(out.cids, vec!["88".to_string(), "99".to_string()]);
    }

    #[test]
    fn list_review_tasks_maps_fields() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"cid": 88, "status": 1, "activeid": 3,
                 "contentJson": {"title": "标题"}, "activeJson": {"name": "活动"},
                 "created": 1700000000}
            ]})
            .to_string(),
        );
        let out = list_review_tasks(&h.ctx, &StrOrNum::Number(9)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].cid, "88");
        assert_eq!(out[0].status, 1);
        assert_eq!(out[0].activeid.as_deref(), Some("3"));
        assert_eq!(out[0].active_name, "活动");
        assert_eq!(out[0].article_title, "标题");
        assert_eq!(out[0].created, Some(1_700_000_000));
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
