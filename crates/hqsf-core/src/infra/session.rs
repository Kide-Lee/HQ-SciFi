//! 会话持久化（原 `src/main/infra/session/index.ts`）。
//!
//! 1.x 用 Electron `safeStorage` 把 token 加密后与 userinfo 一起写进
//! `userData/session.json`；Rust 侧改用系统钥匙串（[`SecretStore`]）后职责分成两处：
//!
//! - **token 只进 `ctx.secrets`**：键 [`SECRET_KEY`]（`"hqsf.session"`），值是 JSON 对象
//!   `{"token": …, "savedAt": …}`。这与 [`crate::services::net`] 的既有契约一致
//!   （`services::net::token` / `require_token` 会读同一个键解析 `token`），
//!   **不要**改成别的键名，否则所有需要登录的命令都会退化成「未登录」。
//! - 非敏感字段（`userinfo`、`savedAt`）按 1.x 语义落 `data_dir/session.json`（JSON 明文，
//!   1.x 也是明文存 userinfo，只是裹在同一个加密文件里）。
//!
//! [`SessionData::token`] 带 `skip_serializing`：任何误把 `SessionData` 直接落盘或塞进
//! 返回载荷的路径都不会泄漏 token（序列化结果里根本没有这个字段）。
//!
//! # 与 1.x 的有意差异（安全语义变化）
//!
//! 1. 不再有 `cipher` / `tokenCipher` 与 `basic_text` 降级：钥匙串不可用时 [`save`] 直接
//!    失败，不会出现「base64 明文 token」这种 insecure 状态。`insecure` 因此恒为
//!    [`STORAGE_INSECURE`]（`false`），渲染层的风险提示分支保留但不再触发。
//! 2. 1.x 遗留的 `session.json`（含 `tokenCipher` 字段、无对应钥匙串条目）在 Rust 侧无法
//!    解密，读取时视为「无会话」并清理该文件，用户需重新登录（1.x 换机器/无 keyring 时
//!    的 `loadSession` 也是同样结果）。
//! 3. 损坏的会话（钥匙串值不是 JSON、会话文件不是 JSON）按 1.x 语义清理并视为未登录；
//!    区别是钥匙串值损坏时 [`load`] 会返回错误（与 `services::net::token` 的文案一致），
//!    而不是静默登出——静默登出会让渲染层以为「本来就没登录」。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ctx::CoreCtx;
use crate::error::{CoreError, CoreResult};

/// 会话在 [`SecretStore`] 里的键。**必须**与
/// [`crate::services::net::SESSION_SECRET_KEY`] 相同（有测试钉住）。
pub const SECRET_KEY: &str = "hqsf.session";

/// 会话文件（`userinfo` 等非敏感字段）文件名，落在 `data_dir` 下（1.x 是 userData）。
pub const SESSION_FILE_NAME: &str = "session.json";

/// `insecure` 的取值。Rust 侧 token 只进系统钥匙串，不存在 1.x 的 `basic_text`/base64 降级。
pub const STORAGE_INSECURE: bool = false;

/// 钥匙串里的会话 JSON 不是合法 JSON 时的文案（与 `services::net::token` 保持一致）。
const CORRUPT_SESSION_MESSAGE: &str = "本地会话已损坏，请重新登录";

/// 进程内会话（对应 1.x `SessionData` + `loadSession()` 的 `insecure` 标记）。
///
/// 只在内核里流转：`token` 字段**不会**被序列化，避免任何落盘/下发路径顺手带出 token。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    /// 会话 token。只允许出现在这里与 [`SecretStore`]，绝不进返回载荷。
    #[serde(default, skip_serializing)]
    pub token: String,
    /// 非敏感用户信息（uid/nickname/avatar/introduce 等）。
    #[serde(default)]
    pub userinfo: Map<String, Value>,
    /// 1.x `loadSession().insecure`：safeStorage 降级标记。Rust 侧恒为 [`STORAGE_INSECURE`]。
    #[serde(default)]
    pub insecure: bool,
}

/// 磁盘上的会话文件（原 1.x `SessionFile`，去掉 `tokenCipher`/`cipher`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    #[serde(default)]
    userinfo: Map<String, Value>,
    #[serde(default)]
    saved_at: i64,
}

/// 会话文件路径：`<data_dir>/session.json`。
pub fn session_path(ctx: &CoreCtx) -> PathBuf {
    ctx.paths.data_dir.join(SESSION_FILE_NAME)
}

/// 保存会话：userinfo 写文件，token 写钥匙串。
///
/// 写入顺序是「先文件、后钥匙串」：如果钥匙串写入失败，磁盘上只有非敏感 userinfo，
/// 而 [`load`] 取不到 token 会按「无会话」处理并顺手清理，不会出现半登录状态。
pub fn save(ctx: &CoreCtx, session: &SessionData) -> CoreResult<()> {
    let file = SessionFile {
        userinfo: session.userinfo.clone(),
        saved_at: ctx.clock.now_ms(),
    };
    ctx.files.create_dir_all(&ctx.paths.data_dir)?;
    ctx.files
        .write(&session_path(ctx), &serde_json::to_vec(&file)?)?;

    let secret = serde_json::json!({
        "token": session.token,
        "savedAt": file.saved_at,
    })
    .to_string();
    ctx.secrets.set(SECRET_KEY, &secret)?;
    Ok(())
}

/// 读取会话；没有会话时返回 `Ok(None)`（干净的「未登录」，不报错）。
///
/// - 钥匙串无条目 → `None`，并清理可能残留的会话文件（见 [`save`] 的失败路径）；
/// - 有 token 但会话文件缺失 → 视为 userinfo 为空的会话（例如测试用
///   `Harness::with_token` 只预置了 token）；
/// - 会话文件损坏 / 1.x 遗留格式 → 清理并把两者一起视为未登录（1.x 语义）。
pub fn load(ctx: &CoreCtx) -> CoreResult<Option<SessionData>> {
    let Some(raw) = ctx.secrets.get(SECRET_KEY)? else {
        discard_stale_file(ctx);
        return Ok(None);
    };
    let secret: Value =
        serde_json::from_str(&raw).map_err(|_| CoreError::app(CORRUPT_SESSION_MESSAGE))?;
    let token = secret
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if token.is_empty() {
        return Ok(None);
    }

    let path = session_path(ctx);
    let bytes = match ctx.files.read(&path) {
        Ok(bytes) => bytes,
        Err(CoreError::NotFound(_)) => {
            return Ok(Some(SessionData {
                token,
                userinfo: Map::new(),
                insecure: STORAGE_INSECURE,
            }));
        }
        Err(err) => return Err(err),
    };

    match serde_json::from_slice::<SessionFile>(&bytes) {
        Ok(file) => Ok(Some(SessionData {
            token,
            userinfo: file.userinfo,
            insecure: STORAGE_INSECURE,
        })),
        Err(_) => {
            // 1.x 语义：损坏的会话文件删除并视为未登录。
            discard(ctx);
            Ok(None)
        }
    }
}

/// 清除会话：先删 token（钥匙串），再删 userinfo 文件。
///
/// 顺序同样是为了安全失败：token 删掉后即使文件删失败，[`load`] 也只会返回「无会话」。
/// 文件不存在不算错误（1.x `rmSync(..., { force: true })`）。
pub fn clear(ctx: &CoreCtx) -> CoreResult<()> {
    ctx.secrets.delete(SECRET_KEY)?;
    match ctx.files.remove_file(&session_path(ctx)) {
        Ok(()) | Err(CoreError::NotFound(_)) => Ok(()),
        Err(err) => Err(err),
    }
}

/// 清理「有文件、无 token」的残留会话文件（不报错；文件本来就不存在也正常）。
fn discard_stale_file(ctx: &CoreCtx) {
    let _ = ctx.files.remove_file(&session_path(ctx));
}

/// 清理损坏的会话文件与 token（不报错——1.x 的清理路径也是尽力而为）。
fn discard(ctx: &CoreCtx) {
    discard_stale_file(ctx);
    let _ = ctx.secrets.delete(SECRET_KEY);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{FileStore, SecretStore};
    use crate::testkit::Harness;

    fn session(token: &str) -> SessionData {
        let mut userinfo = Map::new();
        userinfo.insert("uid".into(), Value::from(7));
        userinfo.insert("nickname".into(), Value::from("阿启"));
        SessionData {
            token: token.into(),
            userinfo,
            insecure: STORAGE_INSECURE,
        }
    }

    #[test]
    fn secret_key_matches_the_services_net_contract() {
        // 其它 29+ 条命令经 services::net 读同一个键；键名漂移会让它们全部「未登录」。
        assert_eq!(SECRET_KEY, crate::services::net::SESSION_SECRET_KEY);
    }

    #[test]
    fn save_puts_token_in_the_secret_store_and_userinfo_on_disk() {
        let h = Harness::new();
        save(h.ctx(), &session("tok-123")).unwrap();

        let raw = h.secrets.get(SECRET_KEY).unwrap().unwrap();
        let secret: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(secret["token"], "tok-123");
        assert_eq!(secret["savedAt"], Value::from(1_700_000_000_000_i64));

        let file = h.files.read(&session_path(h.ctx())).unwrap();
        let file: Value = serde_json::from_slice(&file).unwrap();
        assert_eq!(file["userinfo"]["uid"], 7);
        assert_eq!(file["savedAt"], Value::from(1_700_000_000_000_i64));
        // token 绝不落普通文件。
        assert!(
            !String::from_utf8_lossy(&h.files.read(&session_path(h.ctx())).unwrap())
                .contains("tok-123")
        );
    }

    #[test]
    fn load_roundtrips_token_and_userinfo() {
        let h = Harness::new();
        save(h.ctx(), &session("tok-123")).unwrap();
        let loaded = load(h.ctx()).unwrap().unwrap();
        assert_eq!(loaded.token, "tok-123");
        assert_eq!(loaded.userinfo["nickname"], "阿启");
        assert!(!loaded.insecure);
    }

    #[test]
    fn load_without_any_session_is_a_clean_none() {
        // sp-data 实测：没有 session.json，用户需要重新登录；不能报错。
        let h = Harness::new();
        assert!(load(h.ctx()).unwrap().is_none());
    }

    #[test]
    fn load_with_token_but_no_file_uses_empty_userinfo() {
        // 等价 testkit 的 `Harness::with_token`：只预置钥匙串条目。
        let h = Harness::new();
        h.secrets
            .set(
                SECRET_KEY,
                r#"{"token":"tok-only","savedAt":1700000000000}"#,
            )
            .unwrap();
        let loaded = load(h.ctx()).unwrap().unwrap();
        assert_eq!(loaded.token, "tok-only");
        assert!(loaded.userinfo.is_empty());
    }

    #[test]
    fn stale_session_file_without_token_is_cleaned_up() {
        let h = Harness::new();
        h.files
            .write(&session_path(h.ctx()), br#"{"userinfo":{},"savedAt":1}"#)
            .unwrap();
        assert!(load(h.ctx()).unwrap().is_none());
        assert!(!h.files.exists(&session_path(h.ctx())));
    }

    #[test]
    fn corrupt_session_file_is_discarded_and_logs_out() {
        let h = Harness::new();
        h.secrets.set(SECRET_KEY, r#"{"token":"tok"}"#).unwrap();
        h.files.write(&session_path(h.ctx()), b"{not json").unwrap();
        assert!(load(h.ctx()).unwrap().is_none());
        assert!(!h.files.exists(&session_path(h.ctx())));
        assert!(h.secrets.get(SECRET_KEY).unwrap().is_none());
    }

    #[test]
    fn legacy_electron_session_file_is_not_decrypted_and_is_cleaned() {
        // 1.x 的 SessionFile 形状：tokenCipher/cipher + userinfo。Rust 无法解密 safeStorage
        // 密文，只能当作「无会话」（用户重新登录）。
        let h = Harness::new();
        h.files
            .write(
                &session_path(h.ctx()),
                br#"{"tokenCipher":"AAAA","cipher":"safeStorage","userinfo":{"uid":1},"savedAt":1}"#,
            )
            .unwrap();
        assert!(load(h.ctx()).unwrap().is_none());
        assert!(!h.files.exists(&session_path(h.ctx())));
    }

    #[test]
    fn corrupt_secret_value_reports_the_shared_message() {
        let h = Harness::new();
        h.secrets.set(SECRET_KEY, "not json").unwrap();
        let err = load(h.ctx()).unwrap_err();
        assert_eq!(err.to_string(), "本地会话已损坏，请重新登录");
    }

    #[test]
    fn empty_token_counts_as_no_session() {
        let h = Harness::new();
        h.secrets
            .set(SECRET_KEY, r#"{"token":"","savedAt":1}"#)
            .unwrap();
        assert!(load(h.ctx()).unwrap().is_none());
    }

    #[test]
    fn clear_removes_token_and_file() {
        let h = Harness::new();
        save(h.ctx(), &session("tok-123")).unwrap();
        clear(h.ctx()).unwrap();
        assert!(load(h.ctx()).unwrap().is_none());
        assert!(!h.files.exists(&session_path(h.ctx())));
        assert!(h.secrets.get(SECRET_KEY).unwrap().is_none());
    }

    #[test]
    fn clear_without_a_session_is_not_an_error() {
        let h = Harness::new();
        clear(h.ctx()).unwrap();
    }

    #[test]
    fn serializing_session_data_never_includes_the_token() {
        let value = serde_json::to_value(session("tok-secret")).unwrap();
        assert!(value.get("token").is_none());
        assert!(value.get("userinfo").is_some());
        assert!(value.get("insecure").is_some());
        assert!(!value.to_string().contains("tok-secret"));
    }
}
