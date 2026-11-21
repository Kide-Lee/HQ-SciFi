//! 互动适配层（1.x `adapters/read.adapter.ts` 的「用户互动」段 + `ipc/interact.handlers.ts`）。
//!
//! - `addLog`：likes 走 **POST** + `params` JSON；mark / reward 走 **GET** + `params` JSON
//!   （1.x 注释：官方 H5 实测如此；GET 分支忽略 body、POST 分支忽略 query）。
//! - `isMark`：`type=content` 固定值，返回 `{isMark, logid}`。
//! - `removeLog`：`key` 是收藏日志 id（来自 `isMark` 的 `logid`）。
//!
//! 1.x 的 `addUserLog` / `removeUserLog` 内部 `try/catch` 成 `{ok:false,error}`（不 reject），
//! 这里保持同语义：返回 `LogOpResult` 而不是 `CoreResult`。`getMarkStatus` 1.x 不 catch，
//! 所以它仍返回 `CoreResult`（失败 → 信封 `{ok:false,error}`）。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::ctx::CoreCtx;
use crate::domain::user::{first, num};
use crate::error::CoreResult;
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::services::net;

/// 点赞/收藏/投币/取消收藏的统一结果（1.x `LogOpResult`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogOpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LogOpResult {
    pub fn success() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// 收藏状态（1.x `MarkStatus`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MarkStatus {
    pub marked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logid: Option<String>,
}

/// `hqsf:add-log` 的合法操作类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    Likes,
    Mark,
    Reward,
}

impl LogKind {
    /// 1.x `type` 字符串。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Likes => "likes",
            Self::Mark => "mark",
            Self::Reward => "reward",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "likes" => Some(Self::Likes),
            "mark" => Some(Self::Mark),
            "reward" => Some(Self::Reward),
            _ => None,
        }
    }
}

/// 用户日志操作（`hqUserlog/addLog`）。内部 catch 成 `{ok:false,error}`，与 1.x 一致。
pub fn add_user_log(ctx: &CoreCtx, kind: LogKind, params: &Map<String, Value>) -> LogOpResult {
    let token = match net::require_token(ctx, "未登录，无法操作") {
        Ok(token) => token,
        Err(err) => return LogOpResult::failure(err.to_string()),
    };
    let mut payload = Map::new();
    payload.insert("type".to_string(), Value::String(kind.as_str().to_string()));
    for (key, value) in params {
        payload.insert(key.clone(), value.clone());
    }
    let params_json = Value::Object(payload).to_string();

    let options = match kind {
        // 点赞：POST + body（1.x `{ method: 'POST', body: { params, token } }`）
        LogKind::Likes => ApiOptions::post()
            .body("params", &params_json)
            .body("token", &token),
        // 收藏/投币：GET + query
        LogKind::Mark | LogKind::Reward => ApiOptions::get()
            .query("params", &params_json)
            .query("token", &token),
    };
    match net::request::<Value>(ctx, endpoints::ADD_LOG, &options) {
        Ok(_) => LogOpResult::success(),
        Err(err) => LogOpResult::failure(err.to_string()),
    }
}

/// 查询收藏状态（`hqUserlog/isMark`）。
pub fn get_mark_status(ctx: &CoreCtx, cid: &str) -> CoreResult<MarkStatus> {
    let token = net::require_token(ctx, "未登录")?;
    let resp = net::request::<Value>(
        ctx,
        endpoints::IS_MARK,
        &ApiOptions::get()
            .query("cid", cid)
            .query("type", "content")
            .query("token", &token),
    )?;
    let data = &resp.data;
    let logid = first(data, &["logid"]).map(crate::domain::user::str_of);
    Ok(MarkStatus {
        marked: first(data, &["isMark"]).map(num).unwrap_or(0) > 0,
        logid: logid.filter(|v| num(&Value::String(v.clone())) > 0),
    })
}

/// 取消收藏（`hqUserlog/removeLog`）。内部 catch 成 `{ok:false,error}`。
pub fn remove_user_log(ctx: &CoreCtx, key: &str) -> LogOpResult {
    let token = match net::require_token(ctx, "未登录") {
        Ok(token) => token,
        Err(err) => return LogOpResult::failure(err.to_string()),
    };
    match net::request::<Value>(
        ctx,
        endpoints::REMOVE_LOG,
        &ApiOptions::get().query("key", key).query("token", &token),
    ) {
        Ok(_) => LogOpResult::success(),
        Err(err) => LogOpResult::failure(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::testkit::Harness;

    use super::*;

    fn params(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn add_likes_posts_params_json() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(200, r#"{"code":1,"msg":""}"#.to_string());
        let out = add_user_log(
            &h.ctx,
            LogKind::Likes,
            &params(json!({"cid": "12", "num": 1})),
        );
        assert!(out.ok, "{out:?}");
        let last = h.last_request();
        assert_eq!(last.method, "POST");
        let body = String::from_utf8_lossy(last.body.as_deref().unwrap_or_default()).to_string();
        assert!(body.contains("token=tok"), "{body}");
        assert!(body.contains("%22cid%22"), "{body}");
    }

    #[test]
    fn add_mark_and_reward_use_get_query() {
        for (kind, extra) in [
            (LogKind::Mark, json!({})),
            (LogKind::Reward, json!({"num": 5})),
        ] {
            let h = Harness::new().with_api_config().with_token("tok");
            h.http.enqueue(200, r#"{"code":1,"msg":""}"#.to_string());
            let mut p = params(json!({"cid": "12"}));
            for (k, v) in params(extra) {
                p.insert(k, v);
            }
            let out = add_user_log(&h.ctx, kind, &p);
            assert!(out.ok);
            let last = h.last_request();
            assert_eq!(last.method, "GET", "{kind:?}");
            assert!(last.url.contains("params="), "{}", last.url);
            assert!(last.url.contains("token=tok"), "{}", last.url);
        }
    }

    #[test]
    fn add_user_log_turns_server_failure_into_error_result() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":0,"msg":"已收藏过"}"#.to_string());
        let out = add_user_log(&h.ctx, LogKind::Mark, &params(json!({"cid": "12"})));
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("已收藏过"));
    }

    #[test]
    fn add_user_log_without_token_reports_business_error_not_result_err() {
        let h = Harness::new().with_api_config();
        let out = add_user_log(&h.ctx, LogKind::Likes, &params(json!({"cid": "12"})));
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("未登录，无法操作"));
        assert!(h.requests().is_empty());
    }

    #[test]
    fn get_mark_status_parses_marked_and_logid() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"isMark":1,"logid":"88"}}"#.to_string(),
        );
        let out = get_mark_status(&h.ctx, "12").unwrap();
        assert!(out.marked);
        assert_eq!(out.logid.as_deref(), Some("88"));
        let url = h.last_request().url;
        assert!(url.contains("cid=12"), "{url}");
        assert!(url.contains("type=content"), "{url}");
    }

    #[test]
    fn get_mark_status_drops_non_positive_logid() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"isMark":0,"logid":"0"}}"#.to_string(),
        );
        let out = get_mark_status(&h.ctx, "12").unwrap();
        assert!(!out.marked);
        assert_eq!(out.logid, None);
    }

    #[test]
    fn get_mark_status_without_token_errors() {
        let h = Harness::new().with_api_config();
        assert_eq!(
            get_mark_status(&h.ctx, "12").unwrap_err().to_string(),
            "未登录"
        );
    }

    #[test]
    fn remove_user_log_reports_success_and_failure() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(200, r#"{"code":1,"msg":""}"#.to_string());
        assert!(remove_user_log(&h.ctx, "88").ok);
        assert!(h.last_request().url.contains("key=88"));

        h.http
            .enqueue(200, r#"{"code":0,"msg":"记录不存在"}"#.to_string());
        let out = remove_user_log(&h.ctx, "88");
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("记录不存在"));
    }

    #[test]
    fn log_kind_parses_only_known_types() {
        assert_eq!(LogKind::parse("likes"), Some(LogKind::Likes));
        assert_eq!(LogKind::parse("mark"), Some(LogKind::Mark));
        assert_eq!(LogKind::parse("reward"), Some(LogKind::Reward));
        assert_eq!(LogKind::parse("clock"), None);
    }
}
