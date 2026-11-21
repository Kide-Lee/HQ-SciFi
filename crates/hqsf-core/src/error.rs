//! 内核错误类型。
//!
//! IPC 约定是 `{ok:true,data} | {ok:false,error:string}`（见 `src/main/ipc/shared.ts`）。
//! 壳层用 [`CoreError::to_envelope`] 生产错误分支，保证渲染层看到的仍是字符串，
//! 且**不泄漏内部细节**（路径、SQL、URL 只在 `code()` 里区分，不进 `message`）。

use serde::Serialize;

/// 内核统一错误。
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// 业务/接口错误，文案可直接给用户看（对应 TS `fail(msg)`）。
    #[error("{0}")]
    App(String),

    /// API 配置缺失或非法（`api.config.json` 缺项等）。文案与 1.x `ApiConfigError` 同前缀。
    #[error("[API 配置] {0}")]
    Config(String),

    /// 目标不存在。
    #[error("未找到：{0}")]
    NotFound(String),

    /// 越界访问（路径穿越、非白名单端点等）。
    #[error("拒绝访问：{0}")]
    Forbidden(String),

    /// 会话失效，渲染层应引导重新登录。
    #[error("登录已失效，请重新登录")]
    SessionExpired,

    /// 远端返回非 2xx。
    #[error("请求失败（HTTP {status}）")]
    Http { status: u16, body: String },

    /// 接口业务错误（对应 1.x `ApiError`：`code != 1`）。`msg` 直接给用户看。
    #[error("{msg}")]
    Api { code: i64, msg: String },

    /// 本地 IO 失败。
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),

    /// 本地库失败。
    #[error("本地数据操作失败：{0}")]
    Db(#[from] rusqlite::Error),

    /// JSON 解析失败。
    #[error("数据解析失败：{0}")]
    Json(#[from] serde_json::Error),
}

impl CoreError {
    /// 稳定的错误分类，便于测试与前端做统一处理；不面向前端展示。
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::App(_) => "app",
            CoreError::Config(_) => "config",
            CoreError::NotFound(_) => "not_found",
            CoreError::Forbidden(_) => "forbidden",
            CoreError::SessionExpired => "session_expired",
            CoreError::Http { .. } => "http",
            CoreError::Api { .. } => "api",
            CoreError::Io(_) => "io",
            CoreError::Db(_) => "db",
            CoreError::Json(_) => "json",
        }
    }

    /// 生成 IPC 错误载荷：`{"ok":false,"error":"<用户可读文案>"}`。
    pub fn to_envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            ok: false,
            error: self.to_string(),
        }
    }

    /// 是否是「用户该重新登录」这一类错误。
    pub fn is_session_expired(&self) -> bool {
        matches!(self, CoreError::SessionExpired)
    }

    /// 便捷构造。
    pub fn app(msg: impl Into<String>) -> Self {
        CoreError::App(msg.into())
    }

    /// 便捷构造：API 配置错误。
    pub fn config(msg: impl Into<String>) -> Self {
        CoreError::Config(msg.into())
    }

    /// 接口业务错误的 code（成功约定是 1，其它都算失败）。
    pub fn api_code(&self) -> Option<i64> {
        match self {
            CoreError::Api { code, .. } => Some(*code),
            _ => None,
        }
    }
}

/// IPC 失败载荷。
#[derive(Debug, Clone, Serialize)]
pub struct ErrorEnvelope {
    pub ok: bool,
    pub error: String,
}

pub type CoreResult<T> = Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_keeps_message_and_marks_failure() {
        let env = CoreError::App("请先登录".into()).to_envelope();
        assert!(!env.ok);
        assert_eq!(env.error, "请先登录");
        let json = serde_json::to_string(&env).unwrap();
        assert_eq!(json, r#"{"ok":false,"error":"请先登录"}"#);
    }

    #[test]
    fn codes_are_stable() {
        assert_eq!(CoreError::SessionExpired.code(), "session_expired");
        assert_eq!(
            CoreError::Http {
                status: 401,
                body: String::new()
            }
            .code(),
            "http"
        );
    }

    #[test]
    fn http_error_does_not_leak_body_into_message() {
        let err = CoreError::Http {
            status: 500,
            body: "internal stack trace".into(),
        };
        assert!(!err.to_string().contains("stack trace"));
    }

    #[test]
    fn api_config_error_uses_the_1x_prefix() {
        let err = CoreError::config("未找到 api.config.json");
        assert_eq!(err.to_string(), "[API 配置] 未找到 api.config.json");
        assert_eq!(err.code(), "config");
    }

    #[test]
    fn api_error_shows_message_verbatim_and_keeps_code() {
        let err = CoreError::Api {
            code: 401,
            msg: "请先登录".into(),
        };
        assert_eq!(err.to_string(), "请先登录");
        assert_eq!(err.code(), "api");
        assert_eq!(err.api_code(), Some(401));
    }
}
