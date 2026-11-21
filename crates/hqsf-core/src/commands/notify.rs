//! 通知命令层（1.x `src/main/ipc/notify.handlers.ts`）。
//!
//! 3 条通道在 1.x 都先过 `trusted(event)`；未登录分别返回空列表 / 0 / 报错。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::adapters::notify::{self, NotificationCategory, NotificationList};
use crate::ctx::CoreCtx;
use crate::domain::user::JsonScalar;
use crate::error::CoreResult;

/// `get-unread-count` 返回体。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCountOut {
    pub total: i64,
}

/// `mark-notifications-read` 参数（1.x 是 `string[]`，非数组按空处理）。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkNotificationsReadArgs {
    #[serde(default)]
    pub categories: Option<Vec<JsonScalar>>,
}

/// 消息中心列表（含「待评审」任务补条）。
pub fn list_notifications(ctx: &CoreCtx) -> CoreResult<NotificationList> {
    notify::list_notifications(ctx)
}

/// 未读总数。
pub fn get_unread_count(ctx: &CoreCtx) -> CoreResult<UnreadCountOut> {
    Ok(UnreadCountOut {
        total: notify::get_unread_count(ctx)?,
    })
}

/// 标记若干分类已读（非法分类忽略，重复去重）。
pub fn mark_notifications_read(ctx: &CoreCtx, args: MarkNotificationsReadArgs) -> CoreResult<()> {
    let categories: Vec<NotificationCategory> = args
        .categories
        .unwrap_or_default()
        .iter()
        .filter_map(|raw| NotificationCategory::parse(&raw.js_string()))
        .collect();
    notify::mark_notifications_read(ctx, &categories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;

    #[test]
    fn get_unread_count_wraps_total() {
        let harness = Harness::new().with_api_config().with_token("tok");
        harness.http.enqueue(
            200,
            serde_json::json!({"code": 1, "data": {"total": 4}}).to_string(),
        );
        let out = get_unread_count(harness.ctx()).expect("count");
        assert_eq!(out.total, 4);
    }

    #[test]
    fn mark_notifications_read_requires_login() {
        let harness = Harness::new().with_api_config();
        let err = mark_notifications_read(
            harness.ctx(),
            MarkNotificationsReadArgs {
                categories: Some(vec![JsonScalar::Text("comment".to_string())]),
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录，无法标记已读");
    }

    #[test]
    fn mark_notifications_read_ignores_unknown_categories() {
        let harness = Harness::new().with_api_config().with_token("tok");
        harness
            .http
            .enqueue(200, serde_json::json!({"code": 1, "data": []}).to_string());
        mark_notifications_read(
            harness.ctx(),
            MarkNotificationsReadArgs {
                categories: Some(vec![
                    JsonScalar::Text("comment".to_string()),
                    JsonScalar::Text("nope".to_string()),
                ]),
            },
        )
        .expect("mark");
        assert_eq!(harness.requests().len(), 1);
    }
}
