//! 评审域命令（对应 `src/main/ipc/review.handlers.ts`，5 条通道）。
//!
//! 逐条对应：
//! - `hqsf:list-reviews` → [`list_reviews`]
//! - `hqsf:submit-review` → [`submit_review`]
//! - `hqsf:set-review-attitude` → [`set_review_attitude`]
//! - `hqsf:list-review-tasks` → [`list_review_tasks`]
//! - `hqsf:list-my-reviews` → [`list_my_reviews`]
//!
//! 校验与规整都在 [`crate::adapters::review`] / [`crate::domain::review`]；命令层只做
//! 「取 uid → 调 adapter → 返回」。`trusted(...)` 的来源校验属于壳层：壳层拒绝时用
//! [`ILLEGAL_SOURCE`] 的文案，内核不重复实现。

use serde::Deserialize;
use specta::Type;

use crate::CoreResult;
use crate::adapters::read::{Json, StrOrNum, session_uid};
use crate::adapters::review::{
    self, MyReviews, ReviewListOptions, ReviewListOut, ReviewSubmitResult, ReviewTaskItem,
};
use crate::ctx::CoreCtx;

/// 壳层来源校验失败文案（`review.handlers.ts:17-18` 等）。
pub use crate::domain::review::ILLEGAL_SOURCE;

/// `hqsf:list-reviews` 入参（1.x `opts = {}`）。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ListReviewsArgs {
    pub opts: Option<ReviewListOptions>,
}

/// `hqsf:list-reviews`：评审列表（可按文章 / 活动筛选）。
pub fn list_reviews(ctx: &CoreCtx, args: ListReviewsArgs) -> CoreResult<ReviewListOut> {
    let opts = args.opts.unwrap_or_default();
    review::list_reviews(ctx, &opts)
}

/// `hqsf:submit-review` 入参。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmitReviewArgs {
    pub payload: Json,
}

/// `hqsf:submit-review`：发表 / 修改评审（五维评语 + 评分）。
pub fn submit_review(ctx: &CoreCtx, args: SubmitReviewArgs) -> CoreResult<ReviewSubmitResult> {
    review::submit_review(ctx, &args.payload)
}

/// `hqsf:set-review-attitude` 入参（TS 字段名是 `type`）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetReviewAttitudeArgs {
    pub review_id: StrOrNum,
    /// 1.x 参数名就是 `type`（Rust 关键字，故加 rename）。
    #[serde(rename = "type")]
    pub attitude_type: i64,
}

/// `hqsf:set-review-attitude`：给评审表态（赞 / 踩）。
pub fn set_review_attitude(
    ctx: &CoreCtx,
    args: SetReviewAttitudeArgs,
) -> CoreResult<ReviewSubmitResult> {
    review::set_review_attitude(ctx, &args.review_id, args.attitude_type)
}

/// `hqsf:list-review-tasks`：我负责的评审任务（无 uid 时返回空数组，不是错误）。
pub fn list_review_tasks(ctx: &CoreCtx) -> CoreResult<Vec<ReviewTaskItem>> {
    match uid_arg(ctx)? {
        Some(uid) => review::list_review_tasks(ctx, &uid),
        None => Ok(Vec::new()),
    }
}

/// `hqsf:list-my-reviews`：我已评审过的文章 cid（无 uid 时返回空集合，不是错误）。
pub fn list_my_reviews(ctx: &CoreCtx) -> CoreResult<MyReviews> {
    match uid_arg(ctx)? {
        Some(uid) => review::list_my_reviews(ctx, &uid),
        None => Ok(MyReviews { cids: Vec::new() }),
    }
}

/// 1.x `uid` 规整（`review.handlers.ts:54-57`）：数字且 >0 用数字，否则用字符串；
/// 空串视为「无 uid」（此时调用方返回空结果而非报错）。
pub(crate) fn uid_arg(ctx: &CoreCtx) -> CoreResult<Option<StrOrNum>> {
    let Some(uid) = session_uid(ctx)? else {
        return Ok(None);
    };
    if uid.is_empty() {
        return Ok(None);
    }
    Ok(Some(match uid.parse::<i64>() {
        Ok(number) if number > 0 => StrOrNum::Number(number),
        _ => StrOrNum::Text(uid),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    fn with_uid(token: &str, uid: i64) -> Harness {
        let h = Harness::new().with_api_config();
        // 正式会话形态：userinfo 落 session.json、token 落钥匙串（`services::auth`）。
        let session = crate::infra::session::SessionData {
            token: token.to_string(),
            userinfo: json!({"uid": uid}).as_object().cloned().unwrap_or_default(),
            ..Default::default()
        };
        crate::infra::session::save(&h.ctx, &session).unwrap();
        h
    }

    #[test]
    fn list_reviews_forwards_options() {
        let h = with_uid("t", 9);
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"id": 1, "cid": 88, "uid": 9}
            ]})
            .to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = list_reviews(
            &h.ctx,
            ListReviewsArgs {
                opts: Some(ReviewListOptions {
                    cid: Some("88".to_string()),
                    page: Some(2),
                    limit: Some(5),
                    ..ReviewListOptions::default()
                }),
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        let request = h.requests().into_iter().next().unwrap();
        assert!(request.url.contains("/api/reviewlist"));
        assert!(request.url.contains("page=2"));
        assert!(request.url.contains("limit=5"));
        assert!(request.url.contains("searchParams="));
    }

    #[test]
    fn submit_review_posts_params_for_new_review() {
        let h = with_uid("t", 9);
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok"}).to_string());
        let payload = json!({
            "dianzi": "电子维度评语足够十个字",
            "wenbi": "文笔维度评语足够十个字",
            "renwu": "人物维度评语足够十个字",
            "jiezou": "节奏维度评语足够十个字",
            "liyi": "立意维度评语足够十个字",
            "dianziScore": 1,
            "wenbiScore": 2,
            "renwuScore": 3,
            "jiezouScore": 4,
            "liyiScore": 5,
            "cid": "88"
        });
        let out = submit_review(
            &h.ctx,
            SubmitReviewArgs {
                payload: Json::from_value(&payload),
            },
        )
        .unwrap();
        assert!(out.ok);
        let request = h.last_request();
        assert!(request.url.contains("/api/addreview"));
        assert!(request.url.contains("params="));
        assert!(request.url.contains("token=t"));
    }

    #[test]
    fn submit_review_requires_login() {
        let h = Harness::new().with_api_config();
        let err = submit_review(
            &h.ctx,
            SubmitReviewArgs {
                payload: Json::from_value(&json!({"cid": "88"})),
            },
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法评审");
    }

    #[test]
    fn set_review_attitude_posts_form_body() {
        let h = with_uid("t", 9);
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok"}).to_string());
        let out = set_review_attitude(
            &h.ctx,
            SetReviewAttitudeArgs {
                review_id: StrOrNum::Number(123),
                attitude_type: 1,
            },
        )
        .unwrap();
        assert!(out.ok);
        let request = h.last_request();
        assert_eq!(request.method, "POST");
        assert!(request.url.contains("/api/attitude"));
        let body = String::from_utf8(request.body.unwrap_or_default()).unwrap();
        assert!(body.contains("id=123"));
        assert!(body.contains("type=1"));
        assert!(body.contains("token=t"));
    }

    #[test]
    fn list_review_tasks_without_uid_returns_empty_without_request() {
        let h = Harness::new().with_api_config();
        let tasks = list_review_tasks(&h.ctx).unwrap();
        assert!(tasks.is_empty());
        assert!(h.requests().is_empty());
    }

    #[test]
    fn list_my_reviews_without_uid_returns_empty() {
        let h = Harness::new().with_api_config();
        let mine = list_my_reviews(&h.ctx).unwrap();
        assert!(mine.cids.is_empty());
        assert!(h.requests().is_empty());
    }

    #[test]
    fn list_review_tasks_maps_items_with_uid() {
        let h = with_uid("t", 9);
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"cid": 5, "status": 1, "activeid": 3,
                 "activeJson": {"name": "活动"}, "contentJson": {"title": "文章"}}
            ]})
            .to_string(),
        );
        let tasks = list_review_tasks(&h.ctx).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].cid, "5");
        assert_eq!(tasks[0].active_name, "活动");
        assert!(h.last_request().url.contains("uid=9"));
    }

    #[test]
    fn list_my_reviews_collects_cids_with_uid() {
        let h = with_uid("t", 9);
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "data": [
                {"cid": 5, "contentJson": {"cid": 6}}
            ]})
            .to_string(),
        );
        let mine = list_my_reviews(&h.ctx).unwrap();
        assert_eq!(mine.cids, vec!["5".to_string()]);
        assert!(h.last_request().url.contains("searchParams="));
    }
}
