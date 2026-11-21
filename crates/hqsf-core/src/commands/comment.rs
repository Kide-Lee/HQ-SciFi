//! 评论域命令（对应 `src/main/ipc/comment.handlers.ts`，3 条通道）。
//!
//! 逐条对应：
//! - `hqsf:list-comments` → [`list_comments`]
//! - `hqsf:list-recent-comments` → [`list_recent_comments`]
//! - `hqsf:add-comment` → [`add_comment`]
//!
//! `trusted(...)` 来源校验属于壳层（拒绝时用 [`ILLEGAL_SOURCE`]）；其余校验（cid/text
//! 长度/parent/reviewid）逐字在 [`crate::adapters::comment`] 里实现。

use serde::Deserialize;
use specta::Type;

use crate::CoreError;
use crate::CoreResult;
use crate::adapters::comment::{
    self, CommentListOptions, CommentListOut, CommentListResult, CommentSubmitResult,
};
use crate::adapters::read::Json;
use crate::ctx::CoreCtx;
use crate::domain::comment as rules;

/// 壳层来源校验失败文案（`comment.handlers.ts:8-9` 等）。
pub use crate::domain::review::ILLEGAL_SOURCE;

/// `hqsf:list-comments` 入参。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListCommentsArgs {
    pub cid: String,
    #[serde(default)]
    pub opts: Option<CommentListOptions>,
}

/// `hqsf:list-comments`：某篇文章的评论（含占位过滤、匿名作者脱敏与补页）。
pub fn list_comments(ctx: &CoreCtx, args: ListCommentsArgs) -> CoreResult<CommentListResult> {
    // 1.x `String(cid ?? '').trim()`，空串才拒绝（`comment.handlers.ts:11-13`）。
    let cid = args.cid.trim();
    if cid.is_empty() {
        return Err(CoreError::app(rules::MISSING_CID));
    }
    let opts = args.opts.unwrap_or_default();
    comment::list_comments(ctx, cid, &opts)
}

/// `hqsf:list-recent-comments` 入参。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ListRecentCommentsArgs {
    pub opts: Option<CommentListOptions>,
}

/// `hqsf:list-recent-comments`：全局最新评论流（首页「最新讨论」）。
pub fn list_recent_comments(
    ctx: &CoreCtx,
    args: ListRecentCommentsArgs,
) -> CoreResult<CommentListOut> {
    let opts = args.opts.unwrap_or_default();
    comment::list_recent_comments(ctx, &opts)
}

/// `hqsf:add-comment` 入参。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddCommentArgs {
    pub payload: Json,
}

/// `hqsf:add-comment`：发表评论 / 回复 / 评审关联评论。
pub fn add_comment(ctx: &CoreCtx, args: AddCommentArgs) -> CoreResult<CommentSubmitResult> {
    comment::add_comment(ctx, &args.payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    #[test]
    fn list_comments_rejects_blank_cid() {
        let h = Harness::new().with_api_config();
        let err = list_comments(
            &h.ctx,
            ListCommentsArgs {
                cid: "   ".to_string(),
                opts: None,
            },
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "缺少文章 ID");
        assert!(h.requests().is_empty());
    }

    #[test]
    fn list_comments_returns_paged_result() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"coid": 1, "cid": 88, "text": "评论"}
            ]})
            .to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = list_comments(
            &h.ctx,
            ListCommentsArgs {
                cid: "88".to_string(),
                opts: None,
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.total, 1);
        assert_eq!(out.next_page, 2);
        assert!(!out.has_more);
        assert!(
            h.requests()
                .into_iter()
                .next()
                .unwrap()
                .url
                .contains("/api/commentslist")
        );
    }

    #[test]
    fn list_recent_comments_uses_approved_filter() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 0, "data": []}).to_string(),
        );
        let out = list_recent_comments(&h.ctx, ListRecentCommentsArgs::default()).unwrap();
        assert!(out.items.is_empty());
        let url = h.last_request().url;
        assert!(url.contains("commentslist"));
        assert!(url.contains("limit=8"));
        assert!(url.contains("order=created"));
    }

    #[test]
    fn add_comment_posts_params_with_zero_defaults() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok"}).to_string());
        let out = add_comment(
            &h.ctx,
            AddCommentArgs {
                payload: Json::from_value(&json!({"cid": "88", "text": "四个字的评论"})),
            },
        )
        .unwrap();
        assert!(out.ok);
        let request = h.last_request();
        assert!(request.url.contains("/api/commentsadd"));
        assert!(request.url.contains("params="));
        assert!(request.url.contains("text="));
    }

    #[test]
    fn add_comment_requires_login() {
        let h = Harness::new().with_api_config();
        let err = add_comment(
            &h.ctx,
            AddCommentArgs {
                payload: Json::from_value(&json!({"cid": "88", "text": "四个字的评论"})),
            },
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法评论");
    }
}
