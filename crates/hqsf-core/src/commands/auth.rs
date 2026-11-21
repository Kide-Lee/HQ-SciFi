//! 认证域命令（对应 `src/main/ipc/auth.handlers.ts`，4 条通道）。
//!
//! 逐条对应：
//! - `hqsf:login-password` → [`login_password`]
//! - `hqsf:get-session` → [`get_session`]
//! - `hqsf:verify-session` → [`verify_session`]
//! - `hqsf:logout` → [`logout`]
//!
//! 壳层的 `#[tauri::command]` 只做「入参反序列化 → 调本模块 → 包 `Result`」；
//! 登录成功后的「清本地文章索引（防串号）」属于 1.x handler 的职责，放在本层
//! （`auth.handlers.ts:7-18`：`if (res.ok) clearArticles()`）。

use serde::Deserialize;
use specta::Type;

use crate::ctx::CoreCtx;
use crate::error::CoreResult;
use crate::services::auth::{self, LoginResult, UserSession, VerifySessionResult};

/// `hqsf:login-password` 的入参（1.x handler 解构 `{ name, password }`）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginPasswordArgs {
    pub name: String,
    pub password: String,
}

/// `hqsf:login-password`：账号密码登录。
///
/// 返回 `LoginResult` 而不是「失败即 Err」，复刻 1.x：接口/网络失败是**载荷里的**
/// `{ok:false,error}`，IPC 信封仍是 `ok:true`；只有「登录成功但清索引失败」这种
/// 本地异常才会变成 Err（与 1.x handler 的 try/catch 一致）。
pub fn login_password(ctx: &CoreCtx, args: LoginPasswordArgs) -> CoreResult<LoginResult> {
    let result = auth::login_with_password(ctx, &args.name, &args.password);
    if result.ok {
        // 1.x `clearArticles()`：`DELETE FROM articles`，避免换账号后看到上一个账号的索引。
        ctx.db.clear_articles()?;
    }
    Ok(result)
}

/// `hqsf:get-session`：启动时恢复登录态，未登录返回 `null`（无失败分支）。
pub fn get_session(ctx: &CoreCtx) -> CoreResult<Option<UserSession>> {
    auth::get_session(ctx)
}

/// `hqsf:verify-session`：探测 token 是否仍有效（判定规则见服务层）。
pub fn verify_session(ctx: &CoreCtx) -> CoreResult<VerifySessionResult> {
    auth::verify_session_token(ctx)
}

/// `hqsf:logout`：远端 signOut（失败静默）+ 清本地会话。
pub fn logout(ctx: &CoreCtx) -> CoreResult<()> {
    auth::logout(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::article::{ArticleRow, ArticleType};
    use crate::infra::session::session_path;
    use crate::ports::SecretStore;
    use crate::testkit::Harness;

    const TOKEN_KEY: &str = crate::services::net::SESSION_SECRET_KEY;

    fn args(name: &str, password: &str) -> LoginPasswordArgs {
        LoginPasswordArgs {
            name: name.to_string(),
            password: password.to_string(),
        }
    }

    #[test]
    fn login_clears_the_local_article_index_on_success() {
        let h = Harness::new().with_api_config();
        h.ctx
            .db
            .upsert_article(&ArticleRow::new(
                "cid-1",
                ArticleType::Post,
                1_700_000_000_000,
            ))
            .unwrap();
        assert_eq!(h.ctx.db.list_articles(None).unwrap().len(), 1);
        h.http.enqueue(
            200,
            serde_json::json!({
                "code": 1,
                "msg": "",
                "data": { "token": "tok-1", "userinfo": { "uid": 7, "nickname": "小明" } }
            })
            .to_string(),
        );

        let result = login_password(h.ctx(), args("小明", "pw")).unwrap();

        assert!(result.ok);
        assert_eq!(result.insecure, Some(false));
        assert_eq!(result.userinfo.unwrap()["uid"], serde_json::json!(7));
        assert_eq!(
            h.ctx.db.list_articles(None).unwrap().len(),
            0,
            "登录成功必须清空本地文章索引"
        );
        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_some());
    }

    #[test]
    fn login_failure_keeps_the_article_index_and_returns_a_failure_payload() {
        let h = Harness::new().with_api_config();
        h.ctx
            .db
            .upsert_article(&ArticleRow::new(
                "cid-1",
                ArticleType::Post,
                1_700_000_000_000,
            ))
            .unwrap();
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 2, "msg": "账号或密码错误" }).to_string(),
        );

        let result = login_password(h.ctx(), args("小明", "wrong")).unwrap();

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("账号或密码错误"));
        assert_eq!(h.ctx.db.list_articles(None).unwrap().len(), 1);
        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_none());
    }

    #[test]
    fn get_session_verify_and_logout_round_trip() {
        let h = Harness::new().with_api_config();
        assert_eq!(get_session(h.ctx()).unwrap(), None);

        h.http.enqueue(
            200,
            serde_json::json!({
                "code": 1,
                "msg": "",
                "data": { "token": "tok-1", "userinfo": { "uid": 7, "nickname": "小明" } }
            })
            .to_string(),
        );
        assert!(login_password(h.ctx(), args("小明", "pw")).unwrap().ok);

        let session = get_session(h.ctx()).unwrap().expect("登录后应有会话");
        assert_eq!(session.userinfo["nickname"], serde_json::json!("小明"));

        // verify-session：token 有效。
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": [] }).to_string(),
        );
        let verified = verify_session(h.ctx()).unwrap();
        assert!(verified.valid);
        assert!(verified.reachable);

        // logout：清会话。
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": null }).to_string(),
        );
        logout(h.ctx()).unwrap();
        assert_eq!(get_session(h.ctx()).unwrap(), None);
        assert!(!h.ctx.files.exists(&session_path(h.ctx())));
    }

    #[test]
    fn logout_without_a_session_is_fine() {
        let h = Harness::new().with_api_config();
        logout(h.ctx()).unwrap();
        assert!(h.requests().is_empty(), "未登录时不应请求远端 signOut");
    }
}
