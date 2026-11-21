//! 搜索域命令（对应 `src/main/ipc/search.handlers.ts`，3 条通道）。
//!
//! 逐条对应：
//! - `hqsf:search-comments` → [`search_comments`]
//! - `hqsf:search-reviews` → [`search_reviews`]
//! - `hqsf:search-users` → [`search_users`]
//!
//! 三个通道都固定 `page = 1`、`limit` 缺省 10、按 `created` 排序（1.x handler 逐字）。
//! 结果规整在 [`crate::adapters::search`]（评论/评审转调各自 adapter）。

use serde::Deserialize;
use specta::Type;

use crate::CoreResult;
use crate::adapters::comment::CommentListOut;
use crate::adapters::review::ReviewListOut;
use crate::adapters::search::{self, DEFAULT_LIMIT, UserSearchOut};
use crate::ctx::CoreCtx;

/// `hqsf:search-users` 的来源校验失败文案（`search.handlers.ts:32-33`）。
pub use crate::domain::review::ILLEGAL_SOURCE;

/// 三个搜索通道共用的入参（`keyword` + 可选 `limit`）。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    /// 1.x 是 `String(keyword ?? '')`：命令层拿到的已是字符串（契约里必填）。
    pub keyword: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

impl SearchArgs {
    fn limit(&self) -> i64 {
        self.limit.unwrap_or(DEFAULT_LIMIT)
    }
}

/// `hqsf:search-comments`：全文搜索评论。
pub fn search_comments(ctx: &CoreCtx, args: SearchArgs) -> CoreResult<CommentListOut> {
    search::search_comments(ctx, &args.keyword, args.limit())
}

/// `hqsf:search-reviews`：全文搜索评审。
pub fn search_reviews(ctx: &CoreCtx, args: SearchArgs) -> CoreResult<ReviewListOut> {
    search::search_reviews(ctx, &args.keyword, args.limit())
}

/// `hqsf:search-users`：搜索用户。
pub fn search_users(ctx: &CoreCtx, args: SearchArgs) -> CoreResult<UserSearchOut> {
    search::search_users(ctx, &args.keyword, 1, args.limit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    #[test]
    fn search_comments_defaults_limit_to_ten() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"coid": 1, "cid": 88, "text": "命中"}
            ]})
            .to_string(),
        );
        let out = search_comments(
            &h.ctx,
            SearchArgs {
                keyword: "关键词".to_string(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        let url = h.requests().into_iter().next().unwrap().url;
        assert!(url.contains("searchKey="));
        assert!(url.contains("limit=10"));
        assert!(url.contains("page=1"));
    }

    #[test]
    fn search_reviews_uses_created_order_and_page_one() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 0, "data": []}).to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = search_reviews(
            &h.ctx,
            SearchArgs {
                keyword: "关键词".to_string(),
                limit: Some(3),
            },
        )
        .unwrap();
        assert!(out.items.is_empty());
        let url = h.requests().into_iter().next().unwrap().url;
        assert!(url.contains("order=created"));
        assert!(url.contains("limit=3"));
    }

    #[test]
    fn search_users_forwards_keyword_and_page_one() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"uid": 9, "name": "甲"}
            ]})
            .to_string(),
        );
        let out = search_users(
            &h.ctx,
            SearchArgs {
                keyword: "甲".to_string(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        let url = h.last_request().url;
        assert!(url.contains("searchKey="));
        assert!(url.contains("page=1"));
        assert!(url.contains("limit=10"));
    }
}
