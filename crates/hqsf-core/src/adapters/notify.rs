//! 通知适配层（1.x `src/main/adapters/notify.adapter.ts` 逐函数翻译）。
//!
//! 收件箱是 6 个分类（评论/评审/财务/系统/粉丝/私信）各拉一页再合并：单个分类失败
//! 不能拖垮整个消息中心（1.x 用 `Promise.allSettled`，这里逐类 `unwrap_or_default`）。
//! 未读数走 `unreadNum`，缺失逐条 `isread` 时用分组未读数回填；`list-notifications`
//! 还会把「待评审」任务以已读通知的形式补进消息中心（`notify.handlers.ts:16-36`）。
//!
//! 偏差：1.x 收件箱逐条复用 `CommentItem`/`ReviewItem` 类型；这里用 `InboxCommentItem`/
//! `InboxReviewItem`（字段集与收件箱构造一致，避免与 comment/review lane 耦合）。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::adapters::read::StrOrNum;
use crate::adapters::review;
use crate::ctx::CoreCtx;
use crate::domain::user::{first, list_items, num, str_at, str_of};
use crate::error::CoreResult;
use crate::infra::net::api::{ApiOptions, ApiResponse};
use crate::infra::net::config::{self, HttpMethod, endpoints};
use crate::services::{auth, net};

/// 收件箱分类（1.x `INBOX_TYPES`）。
pub const INBOX_TYPES: [NotificationCategory; 6] = [
    NotificationCategory::Comment,
    NotificationCategory::Review,
    NotificationCategory::Finance,
    NotificationCategory::System,
    NotificationCategory::Fan,
    NotificationCategory::Chat,
];

/// 通知分类（`NotificationCategory`）。
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "lowercase")]
pub enum NotificationCategory {
    Comment,
    Review,
    Finance,
    #[default]
    System,
    Fan,
    Chat,
}

impl NotificationCategory {
    /// 线上取值（也是 1.x 里 `INBOX_TYPES` 的字符串形态）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Comment => "comment",
            Self::Review => "review",
            Self::Finance => "finance",
            Self::System => "system",
            Self::Fan => "fan",
            Self::Chat => "chat",
        }
    }

    /// 字符串 → 分类；不在 6 类内返回 `None`（1.x `INBOX_TYPES.includes` 过滤）。
    pub fn parse(raw: &str) -> Option<Self> {
        INBOX_TYPES.into_iter().find(|kind| kind.as_str() == raw)
    }
}

/// 收件箱里的评论（`notify.adapter.ts:31` `toCommentItem` 的收件箱变体）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxCommentItem {
    pub coid: String,
    pub cid: String,
    pub parent: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_author_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_is_anonymous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_author: Option<String>,
    pub author: String,
    pub author_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewid: Option<String>,
}

/// 收件箱里的评审（`notify.adapter.ts:57` `toReviewItem` 的收件箱变体）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxReviewItem {
    pub id: String,
    pub cid: String,
    pub uid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actualscore: Option<String>,
    pub zonghe: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_num: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_json: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_info: Option<Value>,
    pub created: i64,
    /// 1.x 恒输出布尔（`item.hideScore === true`），没有 undefined 分支。
    pub hide_score: bool,
}

/// 消息中心条目（`AppNotification`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppNotification {
    pub id: String,
    pub category: NotificationCategory,
    pub title: String,
    pub text: String,
    pub time: i64,
    pub read: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<InboxCommentItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<InboxReviewItem>,
}

/// `list-notifications` 返回体：`{ items, totalUnread }`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationList {
    pub items: Vec<AppNotification>,
    pub total_unread: i64,
}

/// 分组未读数（`getUnreadCounts`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCounts {
    pub total: i64,
    pub comment: i64,
    pub review: i64,
    pub finance: i64,
    pub system: i64,
    pub fan: i64,
    pub chat: i64,
}

impl UnreadCounts {
    fn of(&self, category: NotificationCategory) -> i64 {
        match category {
            NotificationCategory::Comment => self.comment,
            NotificationCategory::Review => self.review,
            NotificationCategory::Finance => self.finance,
            NotificationCategory::System => self.system,
            NotificationCategory::Fan => self.fan,
            NotificationCategory::Chat => self.chat,
        }
    }
}

/// JS 真值（`!!value`）：`0`/`''`/`null`/`false` → false，其余 true。
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn object_of(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// 从消息原始字段推断分类（`categorize`）。
pub fn categorize(item: &Value) -> NotificationCategory {
    let raw = str_at(
        item,
        &["type", "typeid", "cate", "category", "kind", "msgtype"],
    )
    .to_lowercase();
    if raw.contains("review") || raw.contains("评审") {
        return NotificationCategory::Review;
    }
    if raw.contains("comment")
        || raw.contains("reply")
        || raw.contains("评论")
        || raw == "postcomment"
    {
        return NotificationCategory::Comment;
    }
    if ["finance", "pay", "coin", "asset", "财务"]
        .iter()
        .any(|needle| raw.contains(needle))
    {
        return NotificationCategory::Finance;
    }
    if raw.contains("system") || raw.contains("系统") {
        return NotificationCategory::System;
    }
    if raw == "fan" || raw.contains("fans") || raw.contains("粉丝") {
        return NotificationCategory::Fan;
    }
    if raw == "chat" || raw.contains("private") || raw.contains("私聊") {
        return NotificationCategory::Chat;
    }

    let text = str_at(item, &["content", "text", "msg", "message"]).to_lowercase();
    if text.contains("评审") || text.contains("评价") {
        return NotificationCategory::Review;
    }
    if text.contains("评论") || text.contains("回复") {
        return NotificationCategory::Comment;
    }
    if [
        "pay",
        "finance",
        "coin",
        "asset",
        "withdraw",
        "recharge",
        "能量币",
        "收益",
        "提现",
        "充值",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        return NotificationCategory::Finance;
    }
    if text.contains("关注了你") || text.contains("新粉丝") || text.contains("粉丝") {
        return NotificationCategory::Fan;
    }
    if text.contains("私聊") || text.contains("chat") {
        return NotificationCategory::Chat;
    }
    NotificationCategory::System
}

/// 收件箱评论（`toCommentItem` 收件箱变体）。
pub fn to_inbox_comment(
    item: &Value,
    text: &str,
    time: i64,
    user_json: &Map<String, Value>,
) -> InboxCommentItem {
    let contents_info = object_of(first(item, &["contentsInfo"]));
    let user_json_value = Value::Object(user_json.clone());
    let coid = str_at(item, &["coid", "commentId", "cid", "id"]);
    let cid = match first(&Value::Object(contents_info.clone()), &["cid"]) {
        Some(value) => str_of(value),
        None => str_at(item, &["articleId", "key", "cid"]),
    };
    let parent = match first(item, &["parent"]) {
        Some(value) => str_of(value),
        None => "0".to_string(),
    };
    let article_title = match first(item, &["contenTitle", "articleTitle", "article_title"]) {
        Some(value) => str_of(value),
        None => str_at(&Value::Object(contents_info), &["title"]),
    };
    let experience = match first(item, &["experience"]) {
        Some(value) => Some(num(value)),
        None => first(&user_json_value, &["experience"]).map(num),
    };
    let author = match first(item, &["author", "userName"]) {
        Some(value) => str_of(value),
        None => {
            let name = str_at(&user_json_value, &["name", "nickname"]);
            if name.is_empty() {
                "匿名".to_string()
            } else {
                name
            }
        }
    };
    let author_id = match first(item, &["uid", "authorId", "fromUid"]) {
        Some(value) => str_of(value),
        None => str_at(&user_json_value, &["uid"]),
    };
    let avatar = match first(item, &["avatar"]) {
        Some(value) => str_of(value),
        None => str_at(&user_json_value, &["avatar", "headImg"]),
    };
    InboxCommentItem {
        coid,
        cid,
        parent,
        text: text.to_string(),
        article_title: Some(article_title),
        article_author_id: first(item, &["articleAuthorId"]).map(str_of),
        article_is_anonymous: first(item, &["articleIsAnonymous"]).map(js_truthy),
        experience,
        review_author: first(item, &["reviewAuthor"]).map(str_of),
        author,
        author_id,
        avatar: (!avatar.is_empty()).then_some(avatar),
        created: time,
        reviewid: first(item, &["reviewid"]).map(str_of),
    }
}

/// 收件箱评审（`toReviewItem` 收件箱变体）。
pub fn to_inbox_review(
    item: &Value,
    text: &str,
    time: i64,
    user_json: &Map<String, Value>,
) -> InboxReviewItem {
    let contents_info = object_of(first(item, &["contentsInfo"]));
    let mut article_info = object_of(first(item, &["articleInfo"]));
    let user_json_value = Value::Object(user_json.clone());
    let contents_value = Value::Object(contents_info.clone());
    let id = str_at(item, &["rid", "reviewId", "id"]);
    let cid = match first(&contents_value, &["cid"]) {
        Some(value) => str_of(value),
        None => str_at(item, &["articleId", "key", "cid"]),
    };
    let uid = match first(item, &["uid"]) {
        Some(value) => str_of(value),
        None => str_at(&user_json_value, &["uid"]),
    };
    let title = match first(item, &["contenTitle", "articleTitle"]) {
        Some(value) => str_of(value),
        None => match first(&Value::Object(article_info.clone()), &["title"]) {
            Some(value) => str_of(value),
            None => str_at(&contents_value, &["title"]),
        },
    };
    if title.is_empty() {
        article_info.remove("title");
    } else {
        article_info.insert("title".to_string(), Value::String(title));
    }
    InboxReviewItem {
        id,
        cid,
        uid,
        actualscore: first(item, &["actualscore"]).map(str_of),
        zonghe: text.to_string(),
        reply_num: first(item, &["replyNum"]).map(num),
        user_json: Some(user_json_value),
        article_info: Some(Value::Object(article_info)),
        created: time,
        hide_score: item
            .get("hideScore")
            .is_some_and(|value| value == &Value::Bool(true)),
    }
}

/// 收件箱条目 → [`AppNotification`]（`toAppNotification`）。
pub fn to_app_notification(item: &Value) -> AppNotification {
    let id = str_at(item, &["id", "mid", "msgId"]);
    let text = str_at(item, &["content", "text", "msg", "message"]);
    let category = categorize(item);
    let title = match first(item, &["title"]) {
        Some(value) => str_of(value),
        None => match category {
            NotificationCategory::Fan => "新粉丝".to_string(),
            NotificationCategory::Chat => "私聊消息".to_string(),
            _ => "新消息".to_string(),
        },
    };
    let time = crate::domain::user::norm_ts_at(item, &["addtime", "created", "time", "addTime"]);
    let user_json = object_of(first(item, &["userJson"]));
    let contents_info = object_of(first(item, &["contentsInfo"]));
    let contents_value = Value::Object(contents_info);
    // 逐条 isread 缺失时按已读处理（list_inbox 会用分组未读数兜底回填）
    let read = match first(item, &["isread", "isRead", "read"]) {
        None => true,
        Some(value) => crate::domain::user::number(value).is_none_or(|n| n != 0.0),
    };
    let cid = match first(&contents_value, &["cid"]) {
        Some(value) => str_of(value),
        None => str_at(item, &["articleId", "key", "cid"]),
    };
    let mut notification = AppNotification {
        id,
        category,
        title,
        text: text.clone(),
        time,
        read,
        cid: (!cid.is_empty()).then_some(cid),
        comment: None,
        review: None,
    };
    match category {
        NotificationCategory::Comment => {
            notification.comment = Some(to_inbox_comment(item, &text, time, &user_json));
        }
        NotificationCategory::Review => {
            notification.review = Some(to_inbox_review(item, &text, time, &user_json));
        }
        _ => {}
    }
    notification
}

/// 按配置里的 method 调具名接口（GET → query，POST → body）。
fn request_by_endpoint(
    ctx: &CoreCtx,
    name: &str,
    pairs: &[(&str, String)],
) -> CoreResult<ApiResponse<Value>> {
    let method = {
        let config = net::api_config(ctx)?;
        config::endpoint(&config, name)?.method
    };
    let mut options = match method {
        HttpMethod::Post => ApiOptions::post(),
        HttpMethod::Get => ApiOptions::get(),
    };
    for (key, value) in pairs {
        options = match method {
            HttpMethod::Post => options.body(key, value.clone()),
            HttpMethod::Get => options.query(key, value.clone()),
        };
    }
    net::request::<Value>(ctx, name, &options)
}

/// 分组未读数（`unreadNum`；`data` 可能是数字或对象）。
pub fn get_unread_counts(ctx: &CoreCtx) -> CoreResult<UnreadCounts> {
    let Some(token) = net::token(ctx)? else {
        return Ok(UnreadCounts::default());
    };
    let resp = request_by_endpoint(ctx, endpoints::UNREAD_NUM, &[("token", token)])?;
    let data = &resp.data;
    if let Some(_number) = data.as_f64() {
        return Ok(UnreadCounts {
            total: num(data),
            ..Default::default()
        });
    }
    if !data.is_object() {
        return Ok(UnreadCounts::default());
    }
    Ok(UnreadCounts {
        total: num_at_any(data, &["total", "unread", "count"]),
        comment: num_at_any(data, &["comment", "comments"]),
        review: num_at_any(data, &["review", "reviews"]),
        finance: num_at_any(data, &["finance"]),
        system: num_at_any(data, &["system"]),
        fan: num_at_any(data, &["fan"]),
        chat: num_at_any(data, &["chat"]),
    })
}

/// `num(d.a ?? d.b ?? 0)`：缺失/`null` 都落到 `0`。
fn num_at_any(data: &Value, keys: &[&str]) -> i64 {
    first(data, keys).map(num).unwrap_or(0)
}

/// 拉取某一分类的收件箱（`inbox`，method 取配置；limit 默认 50）。
pub fn fetch_inbox_type(
    ctx: &CoreCtx,
    token: &str,
    category: NotificationCategory,
    limit: i64,
) -> CoreResult<Vec<AppNotification>> {
    let resp = request_by_endpoint(
        ctx,
        endpoints::INBOX,
        &[
            ("type", category.as_str().to_string()),
            ("token", token.to_string()),
            ("limit", limit.to_string()),
            ("page", "1".to_string()),
        ],
    )?;
    let raw = list_items(&resp.data);
    Ok(raw.iter().map(to_app_notification).collect())
}

/// 合并 6 类收件箱，按分组未读数回填 `read`，时间倒序 + id 去重。
pub fn list_inbox(ctx: &CoreCtx) -> CoreResult<Vec<AppNotification>> {
    let Some(token) = net::token(ctx)? else {
        return Ok(Vec::new());
    };
    let grouped: Vec<Vec<AppNotification>> = INBOX_TYPES
        .iter()
        .map(|category| fetch_inbox_type(ctx, &token, *category, 50).unwrap_or_default())
        .collect();
    let unread = get_unread_counts(ctx).unwrap_or_default();

    let mut all: Vec<AppNotification> = Vec::new();
    for (index, category) in INBOX_TYPES.iter().enumerate() {
        let mut sorted = grouped[index].clone();
        sorted.sort_by_key(|item| std::cmp::Reverse(item.time));
        let known_unread = sorted.iter().filter(|item| !item.read).count() as i64;
        let mut need_fallback = (unread.of(*category) - known_unread).max(0);
        for notification in &mut sorted {
            if need_fallback > 0 && notification.read {
                notification.read = false;
                need_fallback -= 1;
            }
        }
        all.extend(sorted);
    }
    all.sort_by_key(|item| std::cmp::Reverse(item.time));
    let mut seen: BTreeSet<String> = BTreeSet::new();
    all.retain(|notification| !notification.id.is_empty() && seen.insert(notification.id.clone()));
    Ok(all)
}

/// 未读总数（`getUnreadCount`）。
pub fn get_unread_count(ctx: &CoreCtx) -> CoreResult<i64> {
    Ok(get_unread_counts(ctx)?.total)
}

/// 标记若干分类已读（`setRead`，method 取配置；逐类请求，`type` 即分类）。
pub fn mark_notifications_read(
    ctx: &CoreCtx,
    categories: &[NotificationCategory],
) -> CoreResult<()> {
    let token = net::require_token(ctx, "未登录，无法标记已读")?;
    let mut seen: BTreeSet<NotificationCategory> = BTreeSet::new();
    for category in categories {
        if !seen.insert(*category) {
            continue;
        }
        request_by_endpoint(
            ctx,
            endpoints::SET_READ,
            &[
                ("token", token.clone()),
                ("type", category.as_str().to_string()),
            ],
        )?;
    }
    Ok(())
}

/// 消息中心列表（`notify.handlers.ts:9-42`）：收件箱 + 「待评审」任务补条。
pub fn list_notifications(ctx: &CoreCtx) -> CoreResult<NotificationList> {
    let Some(_token) = net::token(ctx)? else {
        return Ok(NotificationList::default());
    };
    let mut items = list_inbox(ctx)?;
    let uid = auth::session_uid(ctx);
    if !uid.is_empty() && uid != "0" {
        let tasks = review::list_review_tasks(ctx, &StrOrNum::Text(uid)).unwrap_or_default();
        let known_cids: BTreeSet<String> =
            items.iter().filter_map(|item| item.cid.clone()).collect();
        let now = ctx.clock.now_ms() / 1000;
        let task_items: Vec<AppNotification> = tasks
            .into_iter()
            .filter(|task| {
                task.status == 0 && !task.cid.is_empty() && !known_cids.contains(&task.cid)
            })
            .map(|task| {
                let joined = [task.active_name, task.article_title]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<String>>()
                    .join(" · ");
                AppNotification {
                    id: format!("review-task:{}", task.cid),
                    category: NotificationCategory::Review,
                    title: "待评审".to_string(),
                    text: if joined.is_empty() {
                        task.cid.clone()
                    } else {
                        joined
                    },
                    time: match task.created {
                        Some(created) if created > 0 => created,
                        _ => now,
                    },
                    read: true,
                    cid: Some(task.cid),
                    comment: None,
                    review: None,
                }
            })
            .collect();
        if !task_items.is_empty() {
            let mut merged = task_items;
            merged.append(&mut items);
            items = merged;
        }
    }
    let total_unread = items.iter().filter(|item| !item.read).count() as i64;
    Ok(NotificationList {
        items,
        total_unread,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::ports::SecretStore;
    use serde_json::json;

    fn save_session(harness: &crate::testkit::Harness, uid: &str) {
        let mut userinfo = serde_json::Map::new();
        userinfo.insert("uid".to_string(), json!(uid));
        crate::infra::session::save(
            harness.ctx(),
            &crate::infra::session::SessionData {
                token: "tok".to_string(),
                userinfo,
                insecure: false,
            },
        )
        .expect("session");
    }

    #[test]
    fn categorize_matches_type_field_first() {
        assert_eq!(
            categorize(&json!({"type": "postComment"})),
            NotificationCategory::Comment
        );
        assert_eq!(
            categorize(&json!({"type": "review"})),
            NotificationCategory::Review
        );
        assert_eq!(
            categorize(&json!({"msgtype": "FAN"})),
            NotificationCategory::Fan
        );
        assert_eq!(
            categorize(&json!({"type": "private"})),
            NotificationCategory::Chat
        );
        // 1.x 的 nullish 链只看 `type` 本身；`cate` 只有 `type` 缺失时才被读到。
        assert_eq!(
            categorize(&json!({"cate": "Finance"})),
            NotificationCategory::Finance
        );
    }

    #[test]
    fn categorize_falls_back_to_text() {
        assert_eq!(
            categorize(&json!({"content": "有人评论了你的文章"})),
            NotificationCategory::Comment
        );
        assert_eq!(
            categorize(&json!({"msg": "收到了 3 能量币"})),
            NotificationCategory::Finance
        );
        assert_eq!(
            categorize(&json!({"message": "张三关注了你"})),
            NotificationCategory::Fan
        );
        assert_eq!(
            categorize(&json!({"content": "无关内容"})),
            NotificationCategory::System
        );
    }

    #[test]
    fn notification_defaults_read_to_true_and_titles_by_category() {
        let fan = to_app_notification(&json!({"id": 7, "type": "fan", "content": "新粉丝"}));
        assert_eq!(fan.id, "7");
        assert_eq!(fan.title, "新粉丝");
        assert!(fan.read);
        assert_eq!(fan.category, NotificationCategory::Fan);
        assert_eq!(fan.time, 0);

        let chat = to_app_notification(&json!({"id": "c1", "type": "chat"}));
        assert_eq!(chat.title, "私聊消息");

        let system = to_app_notification(&json!({"id": "s1", "type": "system"}));
        assert_eq!(system.title, "新消息");
    }

    #[test]
    fn notification_read_flag_follows_isread() {
        let unread = to_app_notification(&json!({"id": "1", "type": "system", "isread": 0}));
        assert!(!unread.read);
        let read = to_app_notification(&json!({"id": "2", "type": "system", "isRead": "1"}));
        assert!(read.read);
        let legacy = to_app_notification(&json!({"id": "3", "type": "system", "read": false}));
        assert!(!legacy.read);
    }

    #[test]
    fn comment_notification_uses_contents_info_cid() {
        let notification = to_app_notification(&json!({
            "id": "9",
            "type": "comment",
            "content": "评论正文",
            "created": 1_700_000_000,
            "cid": "999",
            "isread": 0,
            "userJson": {"uid": 3, "name": "甲", "avatar": "/a.png"},
            "contentsInfo": {"cid": "42", "title": "文章标题"}
        }));
        let comment = notification.comment.expect("comment");
        assert_eq!(notification.cid.as_deref(), Some("42"));
        // 1.x 的 coid 链是 `coid ?? commentId ?? cid ?? id`，顶层 `cid` 先命中。
        assert_eq!(comment.coid, "999");
        assert_eq!(comment.cid, "42");
        assert_eq!(comment.parent, "0");
        assert_eq!(comment.text, "评论正文");
        assert_eq!(comment.author, "甲");
        assert_eq!(comment.author_id, "3");
        assert_eq!(comment.avatar.as_deref(), Some("/a.png"));
        assert_eq!(comment.article_title.as_deref(), Some("文章标题"));
        assert_eq!(notification.time, 1_700_000_000);
    }

    #[test]
    fn review_notification_merges_article_info_title() {
        let notification = to_app_notification(&json!({
            "id": "11",
            "type": "review",
            "content": "总体不错",
            "rid": "55",
            "uid": 8,
            "actualscore": "8",
            "replyNum": 2,
            "hideScore": true,
            "articleInfo": {"title": "旧标题", "score": "7"},
            "contentsInfo": {"cid": "43"}
        }));
        let review = notification.review.expect("review");
        assert_eq!(review.id, "55");
        assert_eq!(review.cid, "43");
        assert_eq!(review.uid, "8");
        assert_eq!(review.zonghe, "总体不错");
        assert_eq!(review.actualscore.as_deref(), Some("8"));
        assert_eq!(review.reply_num, Some(2));
        assert!(review.hide_score);
        let info = review.article_info.expect("articleInfo");
        assert_eq!(info["title"], json!("旧标题"));
        assert_eq!(info["score"], json!("7"));
    }

    #[test]
    fn unread_counts_reads_number_and_object_shapes() {
        let harness = crate::testkit::Harness::new()
            .with_api_config()
            .with_token("tok");
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": 5}).to_string());
        let counts = get_unread_counts(harness.ctx()).expect("counts");
        assert_eq!(counts.total, 5);
        assert_eq!(counts.comment, 0);

        harness.http.enqueue(
            200,
            json!({"code": 1, "data": {"total": 9, "comment": 2, "review": 3, "fan": 1}})
                .to_string(),
        );
        let counts = get_unread_counts(harness.ctx()).expect("counts");
        assert_eq!(counts.total, 9);
        assert_eq!(counts.comment, 2);
        assert_eq!(counts.review, 3);
        assert_eq!(counts.fan, 1);
        assert_eq!(counts.chat, 0);
    }

    #[test]
    fn unread_counts_without_token_are_zero() {
        let harness = crate::testkit::Harness::new().with_api_config();
        let counts = get_unread_counts(harness.ctx()).expect("counts");
        assert_eq!(counts, UnreadCounts::default());
    }

    #[test]
    fn list_inbox_merges_sorts_and_dedupes() {
        let harness = crate::testkit::Harness::new()
            .with_api_config()
            .with_token("tok");
        // 6 类收件箱（顺序同 INBOX_TYPES），最后是 unreadNum
        harness.http.enqueue(
            200,
            json!({"code": 1, "data": [
                {"id": "a", "type": "comment", "created": 100, "isread": 1},
                {"id": "b", "type": "comment", "created": 300, "isread": 1}
            ]})
            .to_string(),
        );
        harness.http.enqueue(
            200,
            json!({"code": 1, "data": [
                {"id": "c", "type": "review", "created": 200, "isread": 1}
            ]})
            .to_string(),
        );
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness.http.enqueue(
            200,
            json!({"code": 1, "data": {"items": [
                {"id": "b", "type": "system", "created": 300, "isread": 1}
            ]}})
            .to_string(),
        );
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness.http.enqueue(
            200,
            json!({"code": 1, "data": {"total": 1, "comment": 1}}).to_string(),
        );

        let items = list_inbox(harness.ctx()).expect("inbox");
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
        // comment 未读 1 条：组内时间最新（b@300）的 read 条目被回填为未读
        assert!(!items[0].read);
        assert!(items[1].read);
        assert!(items[2].read);
    }

    #[test]
    fn list_inbox_survives_single_category_failure() {
        let harness = crate::testkit::Harness::new()
            .with_api_config()
            .with_token("tok");
        harness
            .http
            .enqueue(500, json!({"code": 0, "msg": "boom"}).to_string());
        harness.http.enqueue(
            200,
            json!({"code": 1, "data": [
                {"id": "r1", "type": "review", "created": 5, "isread": 1}
            ]})
            .to_string(),
        );
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());

        let items = list_inbox(harness.ctx()).expect("inbox");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "r1");
    }

    #[test]
    fn notifications_without_token_are_empty() {
        let harness = crate::testkit::Harness::new().with_api_config();
        let list = list_notifications(harness.ctx()).expect("list");
        assert!(list.items.is_empty());
        assert_eq!(list.total_unread, 0);
    }

    #[test]
    fn list_notifications_appends_review_tasks() {
        let harness = crate::testkit::Harness::new()
            .with_api_config()
            .with_token("tok");
        save_session(&harness, "7");
        // 收件箱 6 类 + unreadNum
        for _ in 0..6 {
            harness
                .http
                .enqueue(200, json!({"code": 1, "data": []}).to_string());
        }
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": {"total": 0}}).to_string());
        // reviewTask
        harness.http.enqueue(
            200,
            json!({"code": 1, "data": [
                {"cid": "77", "status": 0, "activeJson": {"name": "春季赛"}, "contentJson": {"title": "文章甲"}, "created": 600},
                {"cid": "78", "status": 1, "activeJson": {"name": "春季赛"}, "contentJson": {"title": "文章乙"}, "created": 700}
            ]})
        .to_string());

        let list = list_notifications(harness.ctx()).expect("list");
        assert_eq!(list.items.len(), 1);
        let task = &list.items[0];
        assert_eq!(task.id, "review-task:77");
        assert_eq!(task.title, "待评审");
        assert_eq!(task.text, "春季赛 · 文章甲");
        assert_eq!(task.time, 600);
        assert_eq!(task.cid.as_deref(), Some("77"));
        assert!(task.read);
        assert_eq!(list.total_unread, 0);
    }

    #[test]
    fn mark_notifications_read_dedupes_and_uses_endpoint_method() {
        let harness = crate::testkit::Harness::new()
            .with_api_config()
            .with_token("tok");
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        harness
            .http
            .enqueue(200, json!({"code": 1, "data": []}).to_string());
        mark_notifications_read(
            harness.ctx(),
            &[
                NotificationCategory::Comment,
                NotificationCategory::Chat,
                NotificationCategory::Comment,
            ],
        )
        .expect("mark");

        let requests = harness.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].url.contains("/api/setread"));
        assert!(requests[0].url.contains("type=comment"));
        assert!(requests[1].url.contains("type=chat"));
    }

    #[test]
    fn mark_notifications_read_requires_login() {
        let harness = crate::testkit::Harness::new().with_api_config();
        let err = mark_notifications_read(harness.ctx(), &[NotificationCategory::Comment])
            .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录，无法标记已读");
    }
}
