//! 互动命令层（1.x `src/main/ipc/interact.handlers.ts`）。
//!
//! `hqsf:add-log` 在 1.x 里**没有 try/catch**（A4）：handler 自身校验失败会 reject，
//! `addUserLog` 内部又把网络错误 catch 成 `{ok:false,error}`。内核统一用 `Result`：
//! 校验失败 → `CoreError::App`（壳层输出 `{ok:false,error}`）；请求失败仍是
//! `Ok(LogOpResult{ok:false,error})`，与 1.x 的双层语义一致。

use serde::Deserialize;
use serde_json::{Map, Value};
use specta::Type;

use crate::adapters::interact::{self, LogKind, LogOpResult, MarkStatus};
use crate::ctx::CoreCtx;
use crate::domain::user::{JsonScalar, js_str_param, number, str_of};
use crate::error::{CoreError, CoreResult};
use crate::services::net;

/// `add-log` 参数：操作类型 + 附加参数（`cid`/`num`）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddLogArgs {
    /// TS 字段名就是 `type`（`likes` / `mark` / `reward`）。
    #[serde(rename = "type")]
    pub kind: Option<JsonScalar>,
    #[serde(default)]
    pub params: Option<Map<String, Value>>,
}

/// `is-mark` 参数。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IsMarkArgs {
    pub cid: Option<JsonScalar>,
}

/// `remove-log` 参数（收藏记录 ID）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLogArgs {
    pub key: Option<JsonScalar>,
}

/// 点赞 / 收藏 / 投币。
pub fn add_log(ctx: &CoreCtx, args: AddLogArgs) -> CoreResult<LogOpResult> {
    if net::token(ctx)?.is_none() {
        return Err(CoreError::app("未登录，无法操作"));
    }
    let raw_kind = args
        .kind
        .as_ref()
        .map(JsonScalar::js_string)
        .unwrap_or_default();
    let Some(kind) = LogKind::parse(&raw_kind) else {
        return Err(CoreError::app("未知的操作类型"));
    };
    let params = args.params.unwrap_or_default();
    let cid = params
        .get("cid")
        .map(str_of)
        .unwrap_or_default()
        .trim()
        .to_string();
    if cid.is_empty() {
        return Err(CoreError::app("缺少目标文章 ID"));
    }

    let mut payload: Map<String, Value> = Map::new();
    payload.insert("cid".to_string(), Value::String(cid));
    match kind {
        LogKind::Reward => {
            let amount = params.get("num").and_then(number).unwrap_or(f64::NAN);
            if !amount.is_finite() || amount.fract() != 0.0 || amount <= 0.0 || amount > 10000.0 {
                return Err(CoreError::app("投币数量需为 1-10000 的整数"));
            }
            payload.insert("num".to_string(), Value::from(amount as i64));
        }
        LogKind::Likes => {
            let direction = params.get("num").and_then(number).unwrap_or(f64::NAN);
            if direction != 1.0 && direction != -1.0 {
                return Err(CoreError::app("点赞参数错误（num 需为 1 或 -1）"));
            }
            payload.insert("num".to_string(), Value::from(direction as i64));
        }
        LogKind::Mark => {}
    }
    Ok(interact::add_user_log(ctx, kind, &payload))
}

/// 当前文章是否已收藏。
pub fn is_mark(ctx: &CoreCtx, args: IsMarkArgs) -> CoreResult<MarkStatus> {
    net::require_token(ctx, "未登录")?;
    let cid = js_str_param(args.cid.as_ref()).trim().to_string();
    if cid.is_empty() {
        return Err(CoreError::app("缺少文章 ID"));
    }
    interact::get_mark_status(ctx, &cid)
}

/// 取消收藏（`key` 是收藏记录 ID）。
pub fn remove_log(ctx: &CoreCtx, args: RemoveLogArgs) -> CoreResult<LogOpResult> {
    net::require_token(ctx, "未登录")?;
    let key = js_str_param(args.key.as_ref()).trim().to_string();
    if key.is_empty() {
        return Err(CoreError::app("缺少收藏记录 ID"));
    }
    Ok(interact::remove_user_log(ctx, &key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::user::JsonScalar;
    #[allow(unused_imports)]
    use crate::ports::SecretStore;
    use crate::testkit::Harness;

    fn params(pairs: &[(&str, Value)]) -> Option<Map<String, Value>> {
        Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    fn args(kind: &str, pairs: &[(&str, Value)]) -> AddLogArgs {
        AddLogArgs {
            kind: Some(JsonScalar::Text(kind.to_string())),
            params: params(pairs),
        }
    }

    #[test]
    fn add_log_rejects_unknown_kind() {
        let harness = Harness::new().with_api_config().with_token("tok");
        let err = add_log(harness.ctx(), args("share", &[("cid", Value::from("1"))]))
            .expect_err("should fail");
        assert_eq!(err.to_string(), "未知的操作类型");
    }

    #[test]
    fn add_log_rejects_missing_cid() {
        let harness = Harness::new().with_api_config().with_token("tok");
        let err = add_log(harness.ctx(), args("mark", &[])).expect_err("should fail");
        assert_eq!(err.to_string(), "缺少目标文章 ID");
    }

    #[test]
    fn add_log_requires_login() {
        let harness = Harness::new().with_api_config();
        let err = add_log(harness.ctx(), args("mark", &[("cid", Value::from("1"))]))
            .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录，无法操作");
    }

    #[test]
    fn add_log_reward_validates_amount() {
        let harness = Harness::new().with_api_config().with_token("tok");
        let err = add_log(
            harness.ctx(),
            args(
                "reward",
                &[("cid", Value::from("1")), ("num", Value::from(0))],
            ),
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "投币数量需为 1-10000 的整数");

        let err = add_log(
            harness.ctx(),
            args(
                "reward",
                &[("cid", Value::from("1")), ("num", Value::from(10001))],
            ),
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "投币数量需为 1-10000 的整数");
    }

    #[test]
    fn add_log_likes_validates_direction() {
        let harness = Harness::new().with_api_config().with_token("tok");
        let err = add_log(
            harness.ctx(),
            args(
                "likes",
                &[("cid", Value::from("1")), ("num", Value::from(0))],
            ),
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "点赞参数错误（num 需为 1 或 -1）");
    }

    #[test]
    fn add_log_mark_posts_params() {
        let harness = Harness::new().with_api_config().with_token("tok");
        harness
            .http
            .enqueue(200, serde_json::json!({"code": 1, "data": []}).to_string());
        let result =
            add_log(harness.ctx(), args("mark", &[("cid", Value::from("42"))])).expect("add");
        assert!(result.ok);
    }

    #[test]
    fn is_mark_requires_login_then_cid() {
        let harness = Harness::new().with_api_config();
        let err = is_mark(
            harness.ctx(),
            IsMarkArgs {
                cid: Some(JsonScalar::Text("1".to_string())),
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录");

        harness
            .secrets
            .set(
                crate::services::net::SESSION_SECRET_KEY,
                r#"{"token":"tok","savedAt":1}"#,
            )
            .expect("session");
        let err = is_mark(harness.ctx(), IsMarkArgs { cid: None }).expect_err("should fail");
        assert_eq!(err.to_string(), "缺少文章 ID");
    }

    #[test]
    fn remove_log_requires_login_then_key() {
        let harness = Harness::new().with_api_config();
        let err = remove_log(
            harness.ctx(),
            RemoveLogArgs {
                key: Some(JsonScalar::Int(3)),
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录");
    }
}
