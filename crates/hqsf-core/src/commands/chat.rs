//! 私聊命令层（1.x `src/main/ipc/chat.handlers.ts` 一行一通道）。
//!
//! 4 条通道在 1.x 都先过 `trusted(event)`（可信来源校验属壳层，内核不重复实现）。

use serde::Deserialize;
use specta::Type;

use crate::adapters::chat::{self, ChatMessageList, ChatSessionList, PrivateChat};
use crate::ctx::CoreCtx;
use crate::domain::user::{JsonScalar, js_str_param};
use crate::error::CoreResult;

/// 与某人私聊：`touid`（1.x 是 `number | string`）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatTouidArgs {
    pub touid: Option<JsonScalar>,
}

/// 会话内操作：`chatid`。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatIdArgs {
    pub chatid: Option<JsonScalar>,
}

/// 发消息：`chatid` + `msg`。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendArgs {
    pub chatid: Option<JsonScalar>,
    pub msg: Option<JsonScalar>,
}

/// 获取/创建与某用户的私聊会话。
pub fn get_private_chat(ctx: &CoreCtx, args: ChatTouidArgs) -> CoreResult<PrivateChat> {
    chat::get_private_chat(ctx, &js_str_param(args.touid.as_ref()))
}

/// 会话列表（未登录返回空列表）。
pub fn list_chat_sessions(ctx: &CoreCtx) -> CoreResult<ChatSessionList> {
    chat::list_chat_sessions(ctx)
}

/// 会话消息（1.x 固定 limit=200 / page=1）。
pub fn list_chat_messages(ctx: &CoreCtx, args: ChatIdArgs) -> CoreResult<ChatMessageList> {
    chat::list_chat_messages(ctx, &js_str_param(args.chatid.as_ref()))
}

/// 发送文本消息。
pub fn send_chat_message(ctx: &CoreCtx, args: ChatSendArgs) -> CoreResult<()> {
    chat::send_chat_message(
        ctx,
        &js_str_param(args.chatid.as_ref()),
        &js_str_param(args.msg.as_ref()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::user::JsonScalar;
    use crate::testkit::Harness;

    #[test]
    fn get_private_chat_passes_touid_as_query() {
        let harness = Harness::new().with_api_config().with_token("tok");
        harness.http.enqueue(
            200,
            serde_json::json!({"code": 1, "data": {"chatid": "12"}}).to_string(),
        );
        let chat = get_private_chat(
            harness.ctx(),
            ChatTouidArgs {
                touid: Some(JsonScalar::Int(9)),
            },
        )
        .expect("chat");
        assert_eq!(chat.chatid, "12");
        let request = harness.last_request();
        assert!(request.url.contains("touid=9"));
        assert!(request.url.contains("token=tok"));
    }
}
