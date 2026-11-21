//! 用户域命令层（1.x `src/main/ipc/user.handlers.ts` 一行一通道）。
//!
//! 这里只做「入参归一 + 一次适配调用 + 未登录/入参校验」——分页、uid 校验、字段 trim
//! 都与 1.x handler 逐行对应；远端字段规整在 `adapters::user`。
//!
//! 与 1.x 的差异：`trusted(event)` 的可信来源校验属于壳层（内核拿不到调用方信息），
//! 内核侧不重复实现；`fail(...)` 传字符串导致 `error: undefined` 的 A3 类 bug 统一修正。

use serde::Deserialize;
use serde_json::Value;
use specta::Type;

use crate::adapters::comment::CommentListResult;
use crate::adapters::read::ArticleListOut;
use crate::adapters::review::ReviewListOut;
use crate::adapters::user::{
    self, ClockResult, FollowFeedItem, FollowOpResult, SelfStatus, UploadedImage, UserFollowList,
    UserMarkList, UserProfile, UserProfileUpdatePayload, UserStats,
};
use crate::ctx::CoreCtx;
use crate::domain::user::{JsonScalar, checked_uid, limit_or, page_or, str_of};
use crate::error::{CoreError, CoreResult};
use crate::services::auth;

/// 只想拿一个 `uid` 的通道参数（user-profile / user-stats / user-follow-state）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserUidArgs {
    /// 1.x 是 `unknown`，经 `checkedUid` 归一（非正整数串 → `'0'`）
    pub uid: Option<JsonScalar>,
}

/// `uid` + 分页参数（关注/粉丝/文章/评审/评论列表）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserListArgs {
    pub uid: Option<JsonScalar>,
    #[serde(default)]
    pub page: Option<JsonScalar>,
    #[serde(default)]
    pub limit: Option<JsonScalar>,
}

/// 只有分页参数的通道（user-marks）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageArgs {
    #[serde(default)]
    pub page: Option<JsonScalar>,
    #[serde(default)]
    pub limit: Option<JsonScalar>,
}

/// `hqsf:user-follow` 参数。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserFollowArgs {
    pub uid: Option<JsonScalar>,
    /// 1.x 用 `follow === true` 严格判断（`'true'`/`1` 都算 false）
    #[serde(default)]
    pub follow: Option<JsonScalar>,
}

/// `hqsf:user-update-profile` 参数：先当 `Value` 收，非对象由命令报「无效的资料数据」。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserUpdateProfileArgs {
    pub payload: Option<Value>,
}

/// 用户资料（公开可读）。
pub fn user_profile(ctx: &CoreCtx, args: UserUidArgs) -> CoreResult<UserProfile> {
    let uid = checked_uid(args.uid.as_ref());
    user::get_user_profile(ctx, &uid)
}

/// 用户计数（未登录返回 `null`）。
pub fn user_stats(ctx: &CoreCtx, args: UserUidArgs) -> CoreResult<Option<UserStats>> {
    let uid = checked_uid(args.uid.as_ref());
    user::get_user_stats(ctx, &uid)
}

/// 本人状态（未登录返回 `null`）。
pub fn user_self_status(ctx: &CoreCtx) -> CoreResult<Option<SelfStatus>> {
    user::get_self_status(ctx)
}

/// 是否已关注（未登录 false）。
pub fn user_follow_state(ctx: &CoreCtx, args: UserUidArgs) -> CoreResult<bool> {
    let uid = checked_uid(args.uid.as_ref());
    user::get_follow_state(ctx, &uid)
}

/// 关注/取关。
pub fn user_follow(ctx: &CoreCtx, args: UserFollowArgs) -> CoreResult<FollowOpResult> {
    let uid = checked_uid(args.uid.as_ref());
    let follow = args.follow.as_ref().is_some_and(JsonScalar::is_true);
    user::set_follow(ctx, &uid, follow)
}

/// 关注列表。
pub fn user_follow_list(ctx: &CoreCtx, args: UserListArgs) -> CoreResult<UserFollowList> {
    let uid = checked_uid(args.uid.as_ref());
    user::list_follows(
        ctx,
        &uid,
        page_or(args.page.as_ref()),
        limit_or(args.limit.as_ref()),
    )
}

/// 粉丝列表。
pub fn user_fan_list(ctx: &CoreCtx, args: UserListArgs) -> CoreResult<UserFollowList> {
    let uid = checked_uid(args.uid.as_ref());
    user::list_fans(
        ctx,
        &uid,
        page_or(args.page.as_ref()),
        limit_or(args.limit.as_ref()),
    )
}

/// 签到。
pub fn user_clock(ctx: &CoreCtx) -> CoreResult<ClockResult> {
    // 1.x：handler 先判 token（'未登录，无法签到'），再进 clockIn（内部再判一次）
    crate::services::net::require_token(ctx, "未登录，无法签到")?;
    user::clock_in(ctx)
}

/// 修改本人资料：逐字段 `String(x).trim()`，只保留非 null，成功后合并写回本地会话。
pub fn user_update_profile(ctx: &CoreCtx, args: UserUpdateProfileArgs) -> CoreResult<()> {
    crate::services::net::require_token(ctx, "未登录，无法修改资料")?;
    let Some(Value::Object(raw)) = args.payload else {
        return Err(CoreError::app("无效的资料数据"));
    };
    let mut clean = UserProfileUpdatePayload::default();
    let mut patch = serde_json::Map::new();
    for (key, slot) in [
        ("screenName", &mut clean.screen_name as &mut Option<String>),
        ("avatar", &mut clean.avatar),
        ("userBg", &mut clean.user_bg),
        ("introduce", &mut clean.introduce),
        ("mail", &mut clean.mail),
        ("phone", &mut clean.phone),
    ] {
        let Some(value) = raw.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        let trimmed = str_of(value).trim().to_string();
        patch.insert(key.to_string(), Value::String(trimmed.clone()));
        *slot = Some(trimmed);
    }
    user::update_user_profile(ctx, &clean)?;
    // 1.x：updateSessionUserinfo(clean) —— 没有会话时是 no-op
    auth::update_session_userinfo(ctx, &patch)?;
    Ok(())
}

/// 选择并上传头像（取消返回 `null`）。
pub fn pick_upload_user_image(ctx: &CoreCtx) -> CoreResult<Option<UploadedImage>> {
    user::pick_upload_user_image(ctx)
}
/// 我的收藏（需登录）。
pub fn user_marks(ctx: &CoreCtx, args: PageArgs) -> CoreResult<UserMarkList> {
    crate::services::net::require_token(ctx, "未登录，无法查看收藏")?;
    user::list_marks(
        ctx,
        page_or(args.page.as_ref()),
        limit_or(args.limit.as_ref()),
    )
}

/// 用户发表的文章。
pub fn user_articles(ctx: &CoreCtx, args: UserListArgs) -> CoreResult<ArticleListOut> {
    let uid = checked_uid(args.uid.as_ref());
    user::list_user_articles(
        ctx,
        Some(&JsonScalar::Text(uid)),
        page_or(args.page.as_ref()),
        limit_or(args.limit.as_ref()),
    )
}

/// 用户发表的评审。
pub fn user_reviews(ctx: &CoreCtx, args: UserListArgs) -> CoreResult<ReviewListOut> {
    let uid = checked_uid(args.uid.as_ref());
    user::list_user_reviews(
        ctx,
        &uid,
        page_or(args.page.as_ref()),
        limit_or(args.limit.as_ref()),
    )
}

/// 用户发表的评论。
pub fn user_comments(ctx: &CoreCtx, args: UserListArgs) -> CoreResult<CommentListResult> {
    let uid = checked_uid(args.uid.as_ref());
    user::list_user_comments(
        ctx,
        Some(&JsonScalar::Text(uid)),
        page_or(args.page.as_ref()),
        limit_or(args.limit.as_ref()),
    )
}

/// 关注动态（未登录返回空数组）。
pub fn user_feed(ctx: &CoreCtx) -> CoreResult<Vec<FollowFeedItem>> {
    let Some(_token) = crate::services::net::token(ctx)? else {
        return Ok(Vec::new());
    };
    let uid = auth::session_uid(ctx);
    if uid.is_empty() {
        return Ok(Vec::new());
    }
    user::list_follow_feed(ctx, &uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::user::JsonScalar;
    #[allow(unused_imports)]
    use crate::ports::SecretStore;
    use crate::testkit::Harness;

    fn harness() -> Harness {
        Harness::new().with_api_config().with_token("tok")
    }

    #[test]
    fn user_profile_uses_checked_uid() {
        let harness = harness();
        harness.http.enqueue(
            200,
            serde_json::json!({"code": 1, "data": {"uid": 7, "screenName": "甲"}}).to_string(),
        );
        let profile = user_profile(
            harness.ctx(),
            UserUidArgs {
                uid: Some(JsonScalar::Text("7".to_string())),
            },
        )
        .expect("profile");
        assert_eq!(profile.uid, "7");
        assert_eq!(profile.name, "甲");
        let request = harness.last_request();
        assert!(request.url.contains("key=7"));
    }

    #[test]
    fn user_profile_invalid_uid_becomes_zero() {
        let harness = harness();
        harness.http.enqueue(
            200,
            serde_json::json!({"code": 1, "data": {"uid": 0}}).to_string(),
        );
        user_profile(
            harness.ctx(),
            UserUidArgs {
                uid: Some(JsonScalar::Text("abc".to_string())),
            },
        )
        .expect("profile");
        assert!(harness.last_request().url.contains("key=0"));
    }

    #[test]
    fn user_follow_requires_strict_true() {
        let harness = harness();
        harness
            .http
            .enqueue(200, serde_json::json!({"code": 1, "data": []}).to_string());
        let result = user_follow(
            harness.ctx(),
            UserFollowArgs {
                uid: Some(JsonScalar::Text("3".to_string())),
                follow: Some(JsonScalar::Text("true".to_string())),
            },
        )
        .expect("follow");
        assert!(result.ok);
        // `'true'` 不是严格 true → type=0（取关）
        assert!(harness.last_request().url.contains("type=0"));
    }

    #[test]
    fn user_update_profile_rejects_non_object_payload() {
        let harness = harness();
        let err = user_update_profile(
            harness.ctx(),
            UserUpdateProfileArgs {
                payload: Some(serde_json::json!("字符串")),
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "无效的资料数据");
    }

    #[test]
    fn user_update_profile_requires_login() {
        let harness = Harness::new().with_api_config();
        let err = user_update_profile(
            harness.ctx(),
            UserUpdateProfileArgs {
                payload: Some(serde_json::json!({})),
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录，无法修改资料");
    }

    #[test]
    fn user_update_profile_trims_and_posts_params() {
        let harness = harness();
        harness
            .secrets
            .set(
                crate::services::net::SESSION_SECRET_KEY,
                r#"{"token":"tok","userinfo":{"uid":"7"},"savedAt":1}"#,
            )
            .expect("session");
        harness
            .http
            .enqueue(200, serde_json::json!({"code": 1, "data": []}).to_string());
        user_update_profile(
            harness.ctx(),
            UserUpdateProfileArgs {
                payload: Some(serde_json::json!({
                    "screenName": "  新名字  ",
                    "avatar": null,
                    "mail": "a@b.c"
                })),
            },
        )
        .expect("update");

        let request = harness.last_request();
        assert_eq!(request.method, "POST");
        let body = String::from_utf8(request.body.expect("body")).expect("utf8");
        assert!(body.contains("params="));
        assert!(body.contains("%22screenName%22%3A%22%E6%96%B0%E5%90%8D%E5%AD%97%22"));
        assert!(!body.contains("avatar"));
        assert!(body.contains("token=tok"));
    }

    #[test]
    fn user_marks_requires_login() {
        let harness = Harness::new().with_api_config();
        let err = user_marks(
            harness.ctx(),
            PageArgs {
                page: None,
                limit: None,
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录，无法查看收藏");
    }

    #[test]
    fn user_feed_without_session_returns_empty() {
        let harness = harness();
        let feed = user_feed(harness.ctx()).expect("feed");
        assert!(feed.is_empty());
    }

    #[test]
    fn user_feed_without_token_returns_empty() {
        let harness = Harness::new().with_api_config();
        let feed = user_feed(harness.ctx()).expect("feed");
        assert!(feed.is_empty());
    }
}
