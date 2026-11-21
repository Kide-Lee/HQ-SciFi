//! 会话/鉴权服务（原 `src/main/services/auth-service.ts`，202 行）。
//!
//! 1.x 的职责拆分：
//! - 登录：`POST userLogin`，从响应里**容错**提取 token/uid/nickname，规范化 userinfo
//!   （嵌套 `userinfo` 与顶层字段合并、剔除 token），然后把 token 存进 safeStorage、
//!   userinfo 存进 session.json；
//! - `getSession`：给渲染层的登录态（**不含 token**）；
//! - `verifySessionToken`：用 `markList?limit=1&page=1&token=…` 探测 token 是否仍有效；
//! - `updateSessionUserinfo`：改完资料后把 patch 合并回会话；
//! - `logout`：远端 signOut（失败静默）+ 清本地会话。
//!
//! Rust 侧的差别只有存储：token 进系统钥匙串（[`crate::ports::SecretStore`]），
//! userinfo 进 `data_dir/session.json`（见 [`crate::infra::session`]）。因此 1.x 的
//! `insecure`（safeStorage 退化为 base64）在 Rust 侧恒为 `false`——这是**有意的行为差异**，
//! 不再存在「明文/base64 降级」这条路径。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::ctx::CoreCtx;
use crate::error::{CoreError, CoreResult};
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::infra::session::{self, STORAGE_INSECURE, SessionData};
use crate::services::net;

/// 登录响应里没有 token 时的文案（1.x 逐字，`auth-service.ts:69`）。
pub const MISSING_TOKEN_MESSAGE: &str = "登录响应缺少 token（接口结构可能变化）";

/// `hqsf:get-session` 的载荷（1.x `UserSession`，`src/shared/domain/index.ts:110-114`）。
///
/// 故意**不含 token**：token 只在本进程内存与系统钥匙串里，绝不下发渲染层。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserSession {
    /// 规范化后的用户信息（uid/nickname/avatar/headImg/…，字段名以服务端为准）。
    pub userinfo: Map<String, Value>,
    /// 1.x safeStorage 降级标记；Rust 侧恒为 `false`（钥匙串加密，无降级）。
    pub insecure: bool,
}

/// `hqsf:login-password` 的载荷（1.x `LoginResult`，`src/shared/domain/index.ts:116-121`）。
///
/// 注意 1.x 的语义：登录失败**不是** IPC 失败——命令仍返回 `ok:true` 的信封，载荷里
/// `ok:false` + `error`。所以这里不返回 `CoreResult::Err`（除存储层之外的异常都在
/// [`login_with_password`] 内被收敛成 `LoginResult`，与 1.x 的 try/catch 一致）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub userinfo: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insecure: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `hqsf:verify-session` 的载荷（1.x 匿名返回类型 `{ valid, reachable }`）。
///
/// - `valid=false, reachable=true`：服务端明确判定 token 失效（可安全清会话）；
/// - `valid=false, reachable=false`：网络异常，无法判定（调用方应保留会话）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VerifySessionResult {
    pub valid: bool,
    pub reachable: bool,
}

impl LoginResult {
    fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            userinfo: None,
            insecure: None,
            error: Some(message.into()),
        }
    }
}

/// 登录响应里容错提取出的身份信息（1.x `extractIdentity` 的返回）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Identity {
    token: Option<String>,
    uid: Option<String>,
    nickname: Option<String>,
}

/// 从登录响应 `data` 里容错提取 token/uid/nickname（1.x `extractIdentity`，逐分支照抄）。
///
/// 兼容实测中出现的多种形态：token/uid/nickname 既可能在顶层，也可能在 `userinfo` 下；
/// uid 也常叫 `id`，nickname 也常叫 `nick`。
fn extract_identity(data: &Value) -> Identity {
    let Some(map) = data.as_object() else {
        return Identity::default();
    };
    let token = map.get("token").and_then(Value::as_str).map(str::to_string);
    let info = match map.get("userinfo") {
        Some(Value::Object(nested)) => nested,
        _ => map,
    };
    let uid = info
        .get("uid")
        .filter(|value| !value.is_null())
        .map(js_string)
        .or_else(|| {
            info.get("id")
                .filter(|value| !value.is_null())
                .map(js_string)
        });
    let nickname = info
        .get("nickname")
        .and_then(Value::as_str)
        .or_else(|| info.get("nick").and_then(Value::as_str))
        .map(str::to_string);
    Identity {
        token,
        uid,
        nickname,
    }
}

/// 规范化用户信息（1.x `normalizeUserinfo`，逐行照抄）：
/// 嵌套 `userinfo` 先铺底，再合并顶层字段（**顶层覆盖嵌套**）并剔除 `token`。
///
/// 注意 1.x 的 `rest` 里仍带着 `userinfo` 这个键，所以结果里会保留嵌套对象本身——
/// 渲染层依赖这一点（不同接口把字段放在两层里的都有），必须原样复刻。
fn normalize_userinfo(data: &Value) -> Map<String, Value> {
    let Some(map) = data.as_object() else {
        return Map::new();
    };
    let mut merged = match map.get("userinfo") {
        Some(Value::Object(nested)) => nested.clone(),
        _ => Map::new(),
    };
    for (key, value) in map {
        if key == "token" {
            continue;
        }
        merged.insert(key.clone(), value.clone());
    }
    merged
}

/// JS `String(value)` 的近似实现（uid 可能是字符串或数字；其余形态在真实数据里不出现）。
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// `hqsf:login-password`：账号密码登录（1.x `loginWithPassword`）。
///
/// 任何失败（接口错误、网络、会话落盘）都收敛成 `{ok:false, error}`，与 1.x 的
/// try/catch 一致；只有「成功」路径才会写入钥匙串与会话文件。
pub fn login_with_password(ctx: &CoreCtx, name: &str, password: &str) -> LoginResult {
    let params = serde_json::json!({ "name": name, "password": password }).to_string();
    let options = ApiOptions::post().body("params", params);

    let response = match net::request::<Value>(ctx, endpoints::USER_LOGIN, &options) {
        Ok(response) => response,
        Err(err) => return LoginResult::failure(err.to_string()),
    };
    let data = response.data;

    let identity = extract_identity(&data);
    let Some(token) = identity.token.filter(|token| !token.is_empty()) else {
        return LoginResult::failure(MISSING_TOKEN_MESSAGE);
    };

    let mut userinfo = normalize_userinfo(&data);
    // 1.x：`if (uid && userinfo.uid == null) userinfo.uid = uid`——空串是 falsy，跳过。
    if let Some(uid) = identity.uid.as_deref()
        && !uid.is_empty()
        && userinfo.get("uid").is_none_or(Value::is_null)
    {
        userinfo.insert("uid".to_string(), Value::String(uid.to_string()));
    }
    if let Some(nickname) = identity.nickname.as_deref()
        && !nickname.is_empty()
        && userinfo.get("nickname").is_none_or(Value::is_null)
    {
        userinfo.insert("nickname".to_string(), Value::String(nickname.to_string()));
    }

    let stored = SessionData {
        token,
        userinfo: userinfo.clone(),
        insecure: STORAGE_INSECURE,
    };
    if let Err(err) = session::save(ctx, &stored) {
        return LoginResult::failure(err.to_string());
    }

    LoginResult {
        ok: true,
        userinfo: Some(userinfo),
        insecure: Some(STORAGE_INSECURE),
        error: None,
    }
}

/// `hqsf:get-session`：读取持久化会话（启动恢复登录态），未登录返回 `None`。
pub fn get_session(ctx: &CoreCtx) -> CoreResult<Option<UserSession>> {
    Ok(session::load(ctx)?.map(|session| UserSession {
        userinfo: session.userinfo,
        insecure: session.insecure,
    }))
}

/// `hqsf:verify-session`：探测 token 是否仍有效（1.x `verifySessionToken`）。
///
/// 判定规则与 1.x 完全一致：
/// - 没有 token（未登录）→ `{valid:false, reachable:true}`，不发请求；
/// - 请求成功（`code == 1`）→ `{valid:true, reachable:true}`；
/// - 服务端明确拒绝（1.x `ApiError`，Rust 侧 [`CoreError::Api`]）→ `{valid:false, reachable:true}`；
/// - 网络异常/配置错误（无法判定）→ `{valid:false, reachable:false}`。
///
/// 这里**不把**探测失败变成 `Err`：1.x 的 catch 总是返回结果对象，调用方据此决定是否登出。
pub fn verify_session_token(ctx: &CoreCtx) -> CoreResult<VerifySessionResult> {
    let Some(token) = stored_token(ctx)? else {
        return Ok(VerifySessionResult {
            valid: false,
            reachable: true,
        });
    };
    let options = ApiOptions::get()
        .query("limit", "1")
        .query("page", "1")
        .query("token", token);
    match net::request::<Value>(ctx, endpoints::MARK_LIST, &options) {
        Ok(_) => Ok(VerifySessionResult {
            valid: true,
            reachable: true,
        }),
        Err(err) => Ok(VerifySessionResult {
            valid: false,
            // ApiError = 服务端已响应且判定 token 失效；其余视为不可判定。
            reachable: matches!(err, CoreError::Api { .. }),
        }),
    }
}

/// 把 patch 合并进会话的 userinfo 并落盘（1.x `updateSessionUserinfo`）：
/// 没有会话时是 no-op（不报错）；patch 覆盖同名字段。
pub fn update_session_userinfo(ctx: &CoreCtx, patch: &Map<String, Value>) -> CoreResult<()> {
    let Some(mut current) = session::load(ctx)? else {
        return Ok(());
    };
    for (key, value) in patch {
        current.userinfo.insert(key.clone(), value.clone());
    }
    session::save(ctx, &current)
}

/// 主进程内部使用的 token（1.x `getStoredToken`）：未登录返回 `None`。
pub fn stored_token(ctx: &CoreCtx) -> CoreResult<Option<String>> {
    let Some(session) = session::load(ctx)? else {
        return Ok(None);
    };
    if session.token.is_empty() {
        return Ok(None);
    }
    Ok(Some(session.token))
}

/// 当前会话的 uid 字符串（1.x `ipc/shared.ts:35-38` 的 `sessionUid`）：
/// `userinfo.uid ?? userinfo.id ?? ''`。读取失败按空串处理（调用方多为「是否本人」判断）。
pub fn session_uid(ctx: &CoreCtx) -> String {
    let Ok(Some(session)) = session::load(ctx) else {
        return String::new();
    };
    session
        .userinfo
        .get("uid")
        .filter(|value| !value.is_null())
        .map(js_string)
        .or_else(|| {
            session
                .userinfo
                .get("id")
                .filter(|value| !value.is_null())
                .map(js_string)
        })
        .unwrap_or_default()
}

/// `hqsf:logout`：远端 signOut（失败静默）+ 清本地会话（1.x `logout`）。
pub fn logout(ctx: &CoreCtx) -> CoreResult<()> {
    if let Some(token) = stored_token(ctx)? {
        let options = ApiOptions::get().query("token", token);
        // 1.x：`catch { /* 远端退出失败不阻塞本地清除 */ }`
        let _ = net::request::<Value>(ctx, endpoints::SIGN_OUT, &options);
    }
    session::clear(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::net::api::encode_form;
    use crate::infra::session::session_path;
    use crate::ports::SecretStore;
    use crate::testkit::Harness;

    const TOKEN_KEY: &str = crate::services::net::SESSION_SECRET_KEY;

    fn login_body(token: &str, userinfo: Value) -> String {
        serde_json::json!({ "code": 1, "msg": "", "data": { "token": token, "userinfo": userinfo } })
            .to_string()
    }

    fn secret_token(h: &Harness) -> Option<String> {
        let raw = h.secrets.get(TOKEN_KEY).unwrap()?;
        let value: Value = serde_json::from_str(&raw).unwrap();
        value
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn session_file(h: &Harness) -> Option<Value> {
        let bytes = h.ctx.files.read(&session_path(h.ctx())).ok()?;
        Some(serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn login_stores_token_in_secret_store_and_userinfo_on_disk() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            login_body(
                "tok-1",
                serde_json::json!({ "uid": 7, "nickname": "小明", "avatar": "a.png" }),
            ),
        );

        let result = login_with_password(h.ctx(), "小明", "pw");

        assert!(result.ok);
        assert_eq!(result.insecure, Some(false));
        assert_eq!(result.error, None);
        let userinfo = result.userinfo.unwrap();
        assert_eq!(userinfo["uid"], serde_json::json!(7));
        assert_eq!(userinfo["nickname"], serde_json::json!("小明"));
        assert_eq!(userinfo["avatar"], serde_json::json!("a.png"));

        // token 只进钥匙串。
        assert_eq!(secret_token(&h).as_deref(), Some("tok-1"));
        // 会话文件只有非敏感字段，**不含 token**。
        let file = session_file(&h).expect("session.json 应该已写入");
        let text = file.to_string();
        assert!(!text.contains("tok-1"), "会话文件不得包含 token: {text}");
        assert_eq!(file["userinfo"]["nickname"], serde_json::json!("小明"));

        // 请求形状：POST userLogin，body 是 `params=<JSON>` 表单。
        let request = h.last_request();
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.hqsf.test/api/userlogin");
        let expected = encode_form(&[(
            "params".to_string(),
            serde_json::json!({ "name": "小明", "password": "pw" }).to_string(),
        )]);
        assert_eq!(
            String::from_utf8_lossy(request.body.as_deref().unwrap()),
            expected
        );
    }

    #[test]
    fn login_merges_nested_and_top_level_userinfo() {
        let h = Harness::new().with_api_config();
        // 顶层 nickname 覆盖嵌套；顶层 token 被剔除；嵌套 userinfo 对象本身保留。
        h.http.enqueue(
            200,
            serde_json::json!({
                "code": 1,
                "msg": "",
                "data": {
                    "token": "tok-1",
                    "userinfo": { "uid": 7, "nickname": "嵌套昵称", "introduce": "hi" },
                    "nickname": "顶层昵称",
                    "headImg": "h.png"
                }
            })
            .to_string(),
        );

        let result = login_with_password(h.ctx(), "u", "p");
        let userinfo = result.userinfo.unwrap();
        assert_eq!(userinfo["uid"], serde_json::json!(7));
        assert_eq!(userinfo["nickname"], serde_json::json!("顶层昵称"));
        assert_eq!(userinfo["introduce"], serde_json::json!("hi"));
        assert_eq!(userinfo["headImg"], serde_json::json!("h.png"));
        assert!(userinfo.get("token").is_none(), "token 不得进入 userinfo");
        assert_eq!(
            userinfo["userinfo"]["nickname"],
            serde_json::json!("嵌套昵称"),
            "1.x 的 rest 里保留嵌套 userinfo 键"
        );
    }

    #[test]
    fn login_falls_back_to_top_level_id_and_nick() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({
                "code": 1,
                "msg": "",
                "data": { "token": "tok-1", "id": 42, "nick": "阿离" }
            })
            .to_string(),
        );

        let result = login_with_password(h.ctx(), "u", "p");
        let userinfo = result.userinfo.unwrap();
        assert_eq!(userinfo["id"], serde_json::json!(42));
        assert_eq!(userinfo["nick"], serde_json::json!("阿离"));
        // uid/nickname 从 id/nick 补齐（字符串化，与 1.x `String(info.uid)` 一致）。
        assert_eq!(userinfo["uid"], serde_json::json!("42"));
        assert_eq!(userinfo["nickname"], serde_json::json!("阿离"));
    }

    #[test]
    fn login_without_token_returns_the_1x_message() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": { "uid": 1 } }).to_string(),
        );

        let result = login_with_password(h.ctx(), "u", "p");

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some(MISSING_TOKEN_MESSAGE));
        assert_eq!(result.userinfo, None);
        assert_eq!(result.insecure, None);
        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_none());
        assert!(!h.ctx.files.exists(&session_path(h.ctx())));
    }

    #[test]
    fn login_api_error_becomes_failure_result() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 2, "msg": "账号或密码错误" }).to_string(),
        );

        let result = login_with_password(h.ctx(), "u", "p");

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("账号或密码错误"));
        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_none());
    }

    #[test]
    fn login_network_failure_becomes_failure_result() {
        // 没有预设响应 → transport 报错（不是 panic）。
        let h = Harness::new().with_api_config();

        let result = login_with_password(h.ctx(), "u", "p");

        assert!(!result.ok);
        let error = result.error.unwrap();
        assert!(error.starts_with("网络请求失败: "), "实际文案：{error}");
    }

    #[test]
    fn get_session_is_none_without_a_stored_session() {
        let h = Harness::new().with_api_config();
        assert_eq!(get_session(h.ctx()).unwrap(), None);
    }

    #[test]
    fn get_session_returns_userinfo_without_token() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            login_body("tok-1", serde_json::json!({ "uid": 7, "nickname": "小明" })),
        );
        assert!(login_with_password(h.ctx(), "u", "p").ok);

        let session = get_session(h.ctx()).unwrap().expect("应有会话");

        assert_eq!(session.userinfo["nickname"], serde_json::json!("小明"));
        assert!(!session.insecure);
        let wire = serde_json::to_value(&session).unwrap();
        // 1.x `normalizeUserinfo` = `{...nested, ...rest}`，而 `rest` 里仍带着
        // 顶层 `userinfo` 键，所以规整结果会把嵌套对象原样保留一份（有意复刻）。
        assert_eq!(
            wire,
            serde_json::json!({
                "userinfo": {
                    "uid": 7,
                    "nickname": "小明",
                    "userinfo": { "uid": 7, "nickname": "小明" }
                },
                "insecure": false
            })
        );
        assert!(wire.get("token").is_none());
    }

    #[test]
    fn verify_session_without_a_session_is_not_reachable_but_skips_network() {
        let h = Harness::new().with_api_config();
        let result = verify_session_token(h.ctx()).unwrap();
        assert_eq!(
            result,
            VerifySessionResult {
                valid: false,
                reachable: true
            }
        );
        assert!(h.requests().is_empty(), "未登录不应发出探测请求");
    }

    #[test]
    fn verify_session_with_a_valid_token_returns_valid() {
        let h = Harness::new().with_api_config().with_token("tok-1");
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": [] }).to_string(),
        );

        let result = verify_session_token(h.ctx()).unwrap();

        assert_eq!(
            result,
            VerifySessionResult {
                valid: true,
                reachable: true
            }
        );
        let request = h.last_request();
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.url,
            "https://api.hqsf.test/api/marklist?limit=1&page=1&token=tok-1"
        );
    }

    #[test]
    fn verify_session_with_api_error_is_reachable_but_invalid() {
        let h = Harness::new().with_api_config().with_token("tok-1");
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 0, "msg": "用户未登录或Token验证失败" }).to_string(),
        );

        let result = verify_session_token(h.ctx()).unwrap();

        assert_eq!(
            result,
            VerifySessionResult {
                valid: false,
                reachable: true
            }
        );
    }

    #[test]
    fn verify_session_with_network_error_is_unreachable() {
        let h = Harness::new().with_api_config().with_token("tok-1");
        // 非 JSON 响应 → 1.x 抛普通 Error（非 ApiError）→ reachable=false。
        h.http.enqueue(502, "bad gateway");

        let result = verify_session_token(h.ctx()).unwrap();

        assert_eq!(
            result,
            VerifySessionResult {
                valid: false,
                reachable: false
            }
        );
    }

    #[test]
    fn update_session_userinfo_merges_the_patch() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            login_body(
                "tok-1",
                serde_json::json!({ "uid": 7, "nickname": "旧昵称" }),
            ),
        );
        assert!(login_with_password(h.ctx(), "u", "p").ok);

        let mut patch = Map::new();
        patch.insert("nickname".to_string(), Value::String("新昵称".into()));
        patch.insert("introduce".to_string(), Value::String("你好".into()));
        update_session_userinfo(h.ctx(), &patch).unwrap();

        let session = get_session(h.ctx()).unwrap().unwrap();
        assert_eq!(session.userinfo["nickname"], serde_json::json!("新昵称"));
        assert_eq!(session.userinfo["introduce"], serde_json::json!("你好"));
        assert_eq!(session.userinfo["uid"], serde_json::json!(7));
        // token 不受影响。
        assert_eq!(secret_token(&h).as_deref(), Some("tok-1"));
    }

    #[test]
    fn update_session_userinfo_without_a_session_is_a_noop() {
        let h = Harness::new().with_api_config();
        let mut patch = Map::new();
        patch.insert("nickname".to_string(), Value::String("新昵称".into()));

        update_session_userinfo(h.ctx(), &patch).unwrap();

        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_none());
        assert!(!h.ctx.files.exists(&session_path(h.ctx())));
    }

    #[test]
    fn stored_token_is_none_without_a_session_and_some_with_one() {
        let anonymous = Harness::new().with_api_config();
        assert_eq!(stored_token(anonymous.ctx()).unwrap(), None);

        let logged_in = Harness::new().with_api_config().with_token("tok-1");
        assert_eq!(
            stored_token(logged_in.ctx()).unwrap().as_deref(),
            Some("tok-1")
        );
    }

    #[test]
    fn session_uid_prefers_uid_then_id_then_empty() {
        let h = Harness::new().with_api_config();
        assert_eq!(session_uid(h.ctx()), "");

        let mut userinfo = Map::new();
        userinfo.insert("uid".to_string(), serde_json::json!(7));
        session::save(
            h.ctx(),
            &SessionData {
                token: "tok-1".into(),
                userinfo,
                insecure: false,
            },
        )
        .unwrap();
        assert_eq!(session_uid(h.ctx()), "7");

        let mut userinfo = Map::new();
        userinfo.insert("uid".to_string(), Value::Null);
        userinfo.insert("id".to_string(), serde_json::json!("abc"));
        session::save(
            h.ctx(),
            &SessionData {
                token: "tok-1".into(),
                userinfo,
                insecure: false,
            },
        )
        .unwrap();
        assert_eq!(session_uid(h.ctx()), "abc");
    }

    #[test]
    fn logout_calls_sign_out_and_clears_the_session() {
        let h = Harness::new().with_api_config().with_token("tok-1");
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": null }).to_string(),
        );

        logout(h.ctx()).unwrap();

        let request = h.last_request();
        assert_eq!(request.method, "GET");
        assert_eq!(request.url, "https://api.hqsf.test/api/signout?token=tok-1");
        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_none());
        assert!(!h.ctx.files.exists(&session_path(h.ctx())));
        assert_eq!(get_session(h.ctx()).unwrap(), None);
    }

    #[test]
    fn logout_clears_local_session_even_when_sign_out_fails() {
        let h = Harness::new().with_api_config().with_token("tok-1");
        // 非 JSON → request 报错，但 1.x 静默忽略远端失败。
        h.http.enqueue(500, "boom");

        logout(h.ctx()).unwrap();

        assert!(h.secrets.get(TOKEN_KEY).unwrap().is_none());
        assert_eq!(get_session(h.ctx()).unwrap(), None);
    }

    #[test]
    fn normalize_userinfo_matches_the_1x_merge_order() {
        let data = serde_json::json!({
            "token": "t",
            "nickname": "顶层",
            "userinfo": { "nickname": "嵌套", "uid": 7 },
            "extra": true
        });
        let merged = normalize_userinfo(&data);
        assert_eq!(merged["nickname"], serde_json::json!("顶层"));
        assert_eq!(merged["uid"], serde_json::json!(7));
        assert_eq!(merged["extra"], serde_json::json!(true));
        assert!(merged.get("token").is_none());
        assert_eq!(merged["userinfo"]["nickname"], serde_json::json!("嵌套"));

        // 非对象输入 → 空 map（1.x 的 `typeof data !== 'object'` 分支）。
        assert!(normalize_userinfo(&serde_json::json!("oops")).is_empty());
        assert!(normalize_userinfo(&Value::Null).is_empty());
    }

    #[test]
    fn extract_identity_covers_nested_and_flat_shapes() {
        let nested = extract_identity(&serde_json::json!({
            "token": "t",
            "userinfo": { "uid": 7, "nickname": "小明" }
        }));
        assert_eq!(
            nested,
            Identity {
                token: Some("t".into()),
                uid: Some("7".into()),
                nickname: Some("小明".into()),
            }
        );

        let flat = extract_identity(&serde_json::json!({
            "token": "t",
            "id": 9,
            "nick": "阿离"
        }));
        assert_eq!(flat.uid.as_deref(), Some("9"));
        assert_eq!(flat.nickname.as_deref(), Some("阿离"));

        // token 非字符串 / 数据非对象 → 都当缺失处理，不 panic。
        let invalid = extract_identity(&serde_json::json!({ "token": 1 }));
        assert_eq!(invalid.token, None);
        assert_eq!(extract_identity(&Value::Null), Identity::default());
    }

    #[test]
    fn login_result_and_verify_result_use_the_1x_wire_shape() {
        let ok = LoginResult {
            ok: true,
            userinfo: Some(Map::new()),
            insecure: Some(false),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "ok": true, "userinfo": {}, "insecure": false })
        );

        let failure = LoginResult::failure("账号或密码错误");
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({ "ok": false, "error": "账号或密码错误" })
        );

        assert_eq!(
            serde_json::to_value(VerifySessionResult {
                valid: true,
                reachable: false
            })
            .unwrap(),
            serde_json::json!({ "valid": true, "reachable": false })
        );
    }
}
