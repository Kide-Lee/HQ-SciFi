//! 搜索侧适配层：三个搜索通道的结果规整（原 `read.adapter.ts` + `user.adapter.ts:314`
//! + `search.handlers.ts`）。
//!
//! - [`search_comments`] / [`search_reviews`] 直接复用评论/评审 adapter（1.x 就是如此：
//!   search handler 调 `searchComments` / `listReviews`，只有 `search-users` 有自己的
//!   结果映射，见 `user.adapter.ts:314` 的 `searchUsers`）；
//! - 本模块只负责 `search-users` 的返回体规整，**不动** `adapters/user.rs`（别的 lane 的文件）。
//!
//! 接口方法从 `api.config.json` 的 endpoint 定义取（1.x `searchUsers` 也是这么做的：
//! 配置写 POST 就发 form body，否则发 query）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::adapters::comment::{CommentListOut, search_comments as search_comments_impl};
use crate::adapters::read::{JsonObject, field, js_to_string, non_empty, num_of, str_of};
use crate::adapters::review::{ReviewListOptions, ReviewListOut, list_reviews};
use crate::ctx::CoreCtx;
use crate::error::CoreResult;
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::{self, HttpMethod, endpoints};
use crate::services::net;

/// 搜索默认条数（`search.handlers.ts:14/25/36`）。
pub const DEFAULT_LIMIT: i64 = 10;

/// 用户搜索结果（`src/shared/domain/index.ts:536` `UserSearchResult`）。
///
/// 归本 lane 所有：L7b 的 user lane 复用本类型，不再重复定义（已与 L7b 对齐）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserSearchResult {
    pub uid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_key: Option<String>,
}

/// 用户搜索返回（`search-users` 的 `{items,total}`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserSearchOut {
    pub items: Vec<UserSearchResult>,
    pub total: i64,
}

/// 搜索用户（`hqUser/userList` + `searchKey`）。
///
/// 方法跟随配置（1.x `searchUsers`：`endpoint('userList').method === 'POST'` 时走 body）。
pub fn search_users(
    ctx: &CoreCtx,
    keyword: &str,
    page: i64,
    limit: i64,
) -> CoreResult<UserSearchOut> {
    let token = net::token(ctx)?;
    let config = net::api_config(ctx)?;
    let endpoint = config::endpoint(&config, endpoints::USER_LIST)?;
    let is_post = endpoint.method == HttpMethod::Post;

    let mut options = if is_post {
        ApiOptions::post()
    } else {
        ApiOptions::get()
    };
    let entries: Vec<(&str, String)> = vec![
        ("searchParams", String::new()),
        ("limit", limit.to_string()),
        ("page", page.to_string()),
        ("searchKey", keyword.to_string()),
        ("order", "created".to_string()),
    ];
    for (key, value) in entries {
        options = if is_post {
            options.body(key, value)
        } else {
            options.query(key, value)
        };
    }
    if let Some(token) = token.as_deref() {
        options = if is_post {
            options.body("token", token)
        } else {
            options.query("token", token)
        };
    }

    let resp = net::request::<Value>(ctx, endpoints::USER_LIST, &options)?;
    let raw = resp.data.as_array().cloned().unwrap_or_default();
    let items: Vec<UserSearchResult> = raw.iter().map(to_user_search_result).collect();
    let total = resp.total.unwrap_or(0);
    let total = if total == 0 {
        items.len() as i64
    } else {
        total
    };
    Ok(UserSearchOut { items, total })
}

/// `user.adapter.ts:314` `searchUsers` 的逐条映射。
pub fn to_user_search_result(item: &Value) -> UserSearchResult {
    UserSearchResult {
        uid: str_of(field(item, "uid")),
        // 1.x: `str(o.name ?? o.screenName)`——两者都缺时是空串。
        name: match field(item, "name") {
            Some(name) => js_to_string(name),
            None => str_of(field(item, "screenName")),
        },
        screen_name: non_empty(str_of(field(item, "screenName"))),
        avatar: non_empty(str_of(field(item, "avatar"))),
        experience: field(item, "experience").map(|value| num_of(Some(value))),
        introduce: non_empty(str_of(field(item, "introduce"))),
        group_key: non_empty(str_of(field(item, "groupKey"))),
    }
}

/// 搜索评论（`commentsList` + `searchKey`，type=comment，按 created）。
pub fn search_comments(ctx: &CoreCtx, keyword: &str, limit: i64) -> CoreResult<CommentListOut> {
    search_comments_impl(ctx, keyword, limit)
}

/// 搜索评审（复用 `list-reviews` 的 adapter：`searchKey` + limit + page 1 + order=created）。
pub fn search_reviews(ctx: &CoreCtx, keyword: &str, limit: i64) -> CoreResult<ReviewListOut> {
    let opts = ReviewListOptions {
        cid: None,
        activeid: None,
        limit: Some(limit),
        page: Some(1),
        order: Some("created".to_string()),
        search_key: Some(keyword.to_string()),
    };
    list_reviews(ctx, &opts)
}

/// 供命令层做透传对象的类型标注（`userJson` 等仍是任意 JSON）。
pub type SearchJson = JsonObject;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    #[test]
    fn to_user_search_result_maps_fields() {
        let item = json!({
            "uid": 9,
            "name": "甲",
            "screenName": "甲甲",
            "avatar": "a.png",
            "experience": 4,
            "introduce": "介绍",
            "groupKey": "vip"
        });
        let user = to_user_search_result(&item);
        assert_eq!(user.uid, "9");
        assert_eq!(user.name, "甲");
        assert_eq!(user.screen_name.as_deref(), Some("甲甲"));
        assert_eq!(user.avatar.as_deref(), Some("a.png"));
        assert_eq!(user.experience, Some(4));
        assert_eq!(user.introduce.as_deref(), Some("介绍"));
        assert_eq!(user.group_key.as_deref(), Some("vip"));
    }

    #[test]
    fn to_user_search_result_falls_back_to_screen_name_and_drops_blank_fields() {
        let user = to_user_search_result(&json!({"uid": 1, "screenName": "乙", "avatar": ""}));
        assert_eq!(user.name, "乙");
        assert!(user.avatar.is_none());
        assert!(user.experience.is_none());
        assert!(user.introduce.is_none());
    }

    #[test]
    fn search_users_queries_user_list_with_search_key() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"uid": 9, "name": "甲"}
            ]})
            .to_string(),
        );
        let out = search_users(&h.ctx, "甲", 1, DEFAULT_LIMIT).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.total, 1);
        let request = h.last_request();
        assert!(request.url.contains("/api/userlist"));
        assert!(request.url.contains("searchKey="));
        assert!(request.url.contains("searchParams="));
        assert!(request.url.contains("limit=10"));
        assert!(request.url.contains("order=created"));
        assert!(request.url.contains("token=t"));
    }

    #[test]
    fn search_users_total_falls_back_to_item_count() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"uid": 1}, {"uid": 2}
            ]})
            .to_string(),
        );
        let out = search_users(&h.ctx, "x", 1, 10).unwrap();
        assert_eq!(out.total, 2);
        assert_eq!(out.items[0].name, "");
    }

    #[test]
    fn search_reviews_uses_search_key_and_created_order() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"id": 1, "cid": 88, "uid": 9}
            ]})
            .to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = search_reviews(&h.ctx, "关键词", DEFAULT_LIMIT).unwrap();
        assert_eq!(out.items.len(), 1);
        let request = h.requests().into_iter().next().unwrap();
        assert!(request.url.contains("searchKey="));
        assert!(request.url.contains("order=created"));
        assert!(request.url.contains("page=1"));
    }

    #[test]
    fn search_comments_delegates_to_comment_adapter() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"coid": 1, "cid": 88, "text": "命中"}
            ]})
            .to_string(),
        );
        let out = search_comments(&h.ctx, "关键词", DEFAULT_LIMIT).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.total, 1);
        assert!(
            h.requests()
                .into_iter()
                .next()
                .unwrap()
                .url
                .contains("searchKey=")
        );
    }
}
