//! 私聊适配层（1.x `src/main/adapters/chat.adapter.ts` + `ipc/chat.handlers.ts`）。
//!
//! 语义照搬：
//! - `myChat` 返回的 `userJson` 恒为对方用户，`uid` 优先取 `userJson.uid`，缺了才回退 `toid`；
//! - `getPrivateChat` 的 `data` 可能是对象（取 `chatid ?? id`）也可能是裸 id；
//! - `sendMsg` 走 POST，`code !== 1` 由 `services::net::request` 统一转成 `CoreError::Api`
//!   （1.x 里 `resp.msg || '发送失败'` 的兜底永远走不到，因为 `apiRequest` 先抛了）。
//!
//! token 语义在适配层内处理（与 1.x 一致：三个通道未登录都是「未登录，无法私聊」，
//! 会话列表未登录返回空列表）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::ctx::CoreCtx;
use crate::domain::user::{list_items, norm_ts_at, num_at, str_at};
use crate::error::CoreResult;
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::services::net;

/// 一条私聊消息（1.x `ChatMessage`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// 消息 id（服务端可能给数字，统一成字符串）
    pub id: String,
    /// 消息类型（服务端数字）
    #[serde(rename = "type")]
    pub kind: i64,
    pub uid: String,
    pub text: String,
    /// 秒级时间戳
    pub created: i64,
    /// 发送者信息（原样透传；1.x 不规整该字段）
    pub user_json: Option<Value>,
}

/// 一条私聊会话（1.x `ChatSession`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub chatid: String,
    /// 对方 uid
    pub uid: String,
    pub name: String,
    pub avatar: Option<String>,
    /// 秒级时间戳
    pub last_time: i64,
    pub last_msg: Option<String>,
    pub unread: i64,
}

/// `hqsf:list-chat-sessions` 载荷。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionList {
    pub items: Vec<ChatSession>,
}

/// `hqsf:list-chat-messages` 载荷。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageList {
    pub items: Vec<ChatMessage>,
}

/// `hqsf:get-private-chat` 载荷。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrivateChat {
    pub chatid: String,
}

/// 原始消息 → `ChatMessage`。
pub fn to_chat_message(item: &Value) -> ChatMessage {
    ChatMessage {
        id: str_at(item, &["id"]),
        kind: num_at(item, &["type"]),
        uid: str_at(item, &["uid"]),
        text: str_at(item, &["text", "msg"]),
        created: norm_ts_at(item, &["created"]),
        user_json: item.get("userJson").filter(|v| v.is_object()).cloned(),
    }
}

/// 原始会话 → `ChatSession`。
pub fn to_chat_session(item: &Value) -> ChatSession {
    let user_json = item.get("userJson").unwrap_or(&Value::Null);
    let uid = str_at(user_json, &["uid"]);
    let uid = if uid.is_empty() {
        str_at(item, &["toid", "uid"])
    } else {
        uid
    };
    let name = str_at(item, &["name"]);
    let name = if name.is_empty() {
        let from_user = str_at(user_json, &["name", "nickname"]);
        if from_user.is_empty() {
            format!("UID {uid}")
        } else {
            from_user
        }
    } else {
        name
    };
    let avatar = str_at(user_json, &["avatar", "headImg", "avatarUrl"]);
    let last_msg = match item.get("lastMsg").filter(|v| v.is_object()) {
        Some(last) => non_empty(Some(str_at(last, &["text"]))),
        None => non_empty(Some(str_at(item, &["lastMsgText"]))),
    };
    ChatSession {
        chatid: str_at(item, &["id"]),
        uid,
        name,
        avatar: non_empty(Some(avatar)),
        last_time: norm_ts_at(item, &["lastTime", "created"]),
        last_msg,
        unread: num_at(item, &["myUnRead", "unread"]),
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.is_empty())
}

/// 拉取会话列表（`myChat`）。未登录返回空列表（1.x handler 语义）。
pub fn list_chat_sessions(ctx: &CoreCtx) -> CoreResult<ChatSessionList> {
    let Some(token) = net::token(ctx)? else {
        return Ok(ChatSessionList { items: Vec::new() });
    };
    let resp = net::request::<Value>(
        ctx,
        endpoints::MY_CHAT,
        &ApiOptions::get().query("token", &token),
    )?;
    let data = resp.data;
    Ok(ChatSessionList {
        items: list_items(&data).iter().map(to_chat_session).collect(),
    })
}

/// 获取/创建与某用户的会话（`getPrivateChat`），返回 chatid。
pub fn get_private_chat(ctx: &CoreCtx, touid: &str) -> CoreResult<PrivateChat> {
    let token = net::require_token(ctx, "未登录，无法私聊")?;
    let resp = net::request::<Value>(
        ctx,
        endpoints::GET_PRIVATE_CHAT,
        &ApiOptions::get()
            .query("touid", touid)
            .query("token", &token),
    )?;
    let data = resp.data;
    let chatid = if data.is_object() {
        str_at(&data, &["chatid", "id"])
    } else {
        crate::domain::user::str_of(&data)
    };
    Ok(PrivateChat { chatid })
}

/// 拉取会话消息（`msgList`，limit 固定 200 / page 1，与 1.x 一致）。
pub fn list_chat_messages(ctx: &CoreCtx, chatid: &str) -> CoreResult<ChatMessageList> {
    let token = net::require_token(ctx, "未登录，无法私聊")?;
    let resp = net::request::<Value>(
        ctx,
        endpoints::MSG_LIST,
        &ApiOptions::get()
            .query("token", &token)
            .query("chatid", chatid)
            .query("limit", "200")
            .query("page", "1"),
    )?;
    Ok(ChatMessageList {
        items: crate::domain::user::array_or_empty(&resp.data)
            .iter()
            .map(to_chat_message)
            .collect(),
    })
}

/// 发送私聊消息（`sendMsg`，POST；`type` 恒为 0=文本）。
pub fn send_chat_message(ctx: &CoreCtx, chatid: &str, msg: &str) -> CoreResult<()> {
    let token = net::require_token(ctx, "未登录，无法私聊")?;
    net::request::<Value>(
        ctx,
        endpoints::SEND_MSG,
        &ApiOptions::post()
            .body("chatid", chatid)
            .body("token", &token)
            .body("msg", msg)
            .body("type", "0"),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::testkit::Harness;

    use super::*;

    #[test]
    fn to_chat_message_normalizes_fields() {
        let raw = serde_json::json!({
            "id": 9,
            "type": "2",
            "uid": 7,
            "msg": "hi",
            "created": 1_700_000_000_000_i64,
            "userJson": {"uid": 7}
        });
        let m = to_chat_message(&raw);
        assert_eq!(m.id, "9");
        assert_eq!(m.kind, 2);
        assert_eq!(m.uid, "7");
        assert_eq!(m.text, "hi");
        assert_eq!(m.created, 1_700_000_000);
        assert_eq!(m.user_json, Some(serde_json::json!({"uid": 7})));
    }

    #[test]
    fn to_chat_session_prefers_user_json_and_falls_back_to_uid_label() {
        let raw = serde_json::json!({
            "id": 3,
            "toid": 42,
            "userJson": {"avatar": "a.png", "headImg": "b.png"},
            "lastMsg": {"text": "last"},
            "lastTime": 1_700_000_000,
            "myUnRead": 2
        });
        let s = to_chat_session(&raw);
        assert_eq!(s.chatid, "3");
        assert_eq!(s.uid, "42");
        assert_eq!(s.name, "UID 42");
        assert_eq!(s.avatar.as_deref(), Some("a.png"));
        assert_eq!(s.last_msg.as_deref(), Some("last"));
        assert_eq!(s.unread, 2);
    }

    #[test]
    fn to_chat_session_falls_back_to_last_msg_text() {
        let raw = serde_json::json!({"id": "1", "userJson": {"uid": "5", "nickname": "n"}, "lastMsgText": "t"});
        let s = to_chat_session(&raw);
        assert_eq!(s.name, "n");
        assert_eq!(s.last_msg.as_deref(), Some("t"));
        assert_eq!(s.last_time, 0);
    }

    #[test]
    fn list_chat_sessions_without_token_returns_empty() {
        let h = Harness::new();
        let out = list_chat_sessions(h.ctx()).unwrap();
        assert!(out.items.is_empty());
        assert!(h.requests().is_empty(), "未登录不该发请求");
    }

    #[test]
    fn list_chat_sessions_reads_wrapped_and_bare_arrays() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"list":[{"id":1}]}}"#.to_string(),
        );
        let out = list_chat_sessions(h.ctx()).unwrap();
        assert_eq!(out.items.len(), 1);
        let last = h.last_request();
        assert!(last.url.contains("/api/mychat"), "{}", last.url);

        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":1,"msg":"","data":[{"id":2}]}"#.to_string());
        assert_eq!(list_chat_sessions(h.ctx()).unwrap().items.len(), 1);
    }

    #[test]
    fn get_private_chat_supports_object_and_scalar_payloads() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"chatid":77}}"#.to_string(),
        );
        assert_eq!(get_private_chat(h.ctx(), "42").unwrap().chatid, "77");
        assert!(
            h.last_request().url.contains("touid=42"),
            "{}",
            h.last_request().url
        );

        h.http
            .enqueue(200, r#"{"code":1,"msg":"","data":"88"}"#.to_string());
        assert_eq!(get_private_chat(h.ctx(), "42").unwrap().chatid, "88");
    }

    #[test]
    fn get_private_chat_requires_login_with_chat_wording() {
        let h = Harness::new().with_api_config();
        let err = get_private_chat(h.ctx(), "42").unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法私聊");
    }

    #[test]
    fn list_chat_messages_uses_fixed_limit_and_page() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":[{"id":"1","text":"hi"}]}"#.to_string(),
        );
        let out = list_chat_messages(h.ctx(), "12").unwrap();
        assert_eq!(out.items.len(), 1);
        let url = h.last_request().url;
        assert!(url.contains("chatid=12"), "{url}");
        assert!(url.contains("limit=200"), "{url}");
        assert!(url.contains("page=1"), "{url}");
    }

    #[test]
    fn send_chat_message_posts_text_message_and_surfaces_server_msg() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":1,"msg":"","data":null}"#.to_string());
        send_chat_message(h.ctx(), "12", "hello").unwrap();
        let last = h.last_request();
        assert_eq!(last.method, "POST");
        let body = String::from_utf8_lossy(last.body.as_deref().unwrap_or_default()).to_string();
        assert!(body.contains("chatid=12"), "{body}");
        assert!(body.contains("msg=hello"), "{body}");
        assert!(body.contains("type=0"), "{body}");

        h.http
            .enqueue(200, r#"{"code":0,"msg":"对方已拉黑你"}"#.to_string());
        let err = send_chat_message(h.ctx(), "12", "hello").unwrap_err();
        assert_eq!(err.to_string(), "对方已拉黑你");
    }

    #[test]
    fn send_chat_message_without_token_reports_not_logged_in() {
        let h = Harness::new().with_api_config();
        let err = send_chat_message(h.ctx(), "12", "x").unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法私聊");
    }
}
