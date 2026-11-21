//! 网络与 API 配置的共享入口：所有需要打荒启接口的命令都从这里进。
//!
//! 1.x 里每个 handler 都要自己 `endpoint('x').path` + `apiRequest(...)` + 从
//! `loadSession()` 取 token 塞进 query。翻译成 Rust 后这三件事各自重复 85 次没有价值，
//! 所以收敛到本模块：
//!
//! - [`api_config`]：按 `ctx.paths` 找 `api.config.json` 并校验（**每次调用现读**，
//!   文件只有 1KB 级，换来的是测试隔离与「改配置立刻生效」，不做进程级缓存）。
//! - [`request`] / [`request_raw`]：具名接口 + 参数 → 解包后的 `ApiResponse<T>`。
//! - [`authed`]：额外把会话 token 作为 `token` 查询参数附上（1.x 的通用约定，见
//!   `src/main/adapters/*.adapter.ts` 里 `query: { token }`）。
//! - [`token`] / [`require_token`]：顺手拿 token；**文案由调用方给**，因为 1.x 每个
//!   handler 的未登录提示都不同（「未登录，无法评论」等），不能统一。
//!
//! 配置候选路径由内核按 `ctx.paths` 推导；`HQSF_API_CONFIG` 环境变量、`cwd`、
//! 测试模式这几条**由壳层解析**后通过 `resource_dir` 表达（见 `src-tauri` 的 path 实现），
//! 这样内核不读 `std::env`，单测可控。

use std::path::PathBuf;

use serde::de::DeserializeOwned;

use crate::ctx::CoreCtx;
use crate::error::{CoreError, CoreResult};
use crate::infra::net::api::{self, ApiOptions, ApiResponse};
use crate::infra::net::config::{self, ApiConfig};

/// 会话在 `SecretStore` 里的键。
///
/// 值是一个 JSON 对象，**至少**含 `"token"` 字段；其余字段（`userinfo`、`savedAt` 等）
/// 由 L4（`infra::session`）自己定义，本模块只读 `token`。
pub const SESSION_SECRET_KEY: &str = "hqsf.session";

/// `api.config.json` 的候选路径（按优先级）。
///
/// 顺序与 1.x `src/main/infra/net/apiconfig.ts` 的语义对齐：打包资源优先，
/// 其次是数据目录里用户自带的覆盖配置（开发/自建服务端场景）。
pub fn api_config_candidates(ctx: &CoreCtx) -> Vec<PathBuf> {
    vec![
        ctx.paths.resource_dir.join("api.config.json"),
        ctx.paths.data_dir.join("api.config.json"),
    ]
}

/// 读取并校验 API 配置。
pub fn api_config(ctx: &CoreCtx) -> CoreResult<ApiConfig> {
    config::load_api_config(&*ctx.files, &api_config_candidates(ctx))
}

/// 按裸对象语义请求接口：返回**整个响应体**，不校验 `code`。
///
/// 对应用 1.x `apiRequest(..., { raw: true })`——仅 `contentsInfo` 这类返回裸对象的
/// 接口需要；用 `request`/`request_raw` 会因缺 `code`/`data` 而丢内容。
pub fn request_value(
    ctx: &CoreCtx,
    endpoint_name: &str,
    options: &ApiOptions,
) -> CoreResult<serde_json::Value> {
    let config = api_config(ctx)?;
    let path = config::endpoint(&config, endpoint_name)?.path.clone();
    crate::infra::net::api::api_request_value(&*ctx.http, &config, &path, options)
}

/// 调具名接口并解包 `data`（校验 `code == 1`）。
pub fn request<T>(
    ctx: &CoreCtx,
    endpoint_name: &str,
    options: &ApiOptions,
) -> CoreResult<ApiResponse<T>>
where
    T: DeserializeOwned + Default,
{
    let config = api_config(ctx)?;
    let path = config::endpoint(&config, endpoint_name)?.path.clone();
    api::api_request(&*ctx.http, &config, &path, options)
}

/// 同 [`request`]，但不校验 `code`（1.x 的 `raw: true`）。
pub fn request_raw<T>(
    ctx: &CoreCtx,
    endpoint_name: &str,
    options: &ApiOptions,
) -> CoreResult<ApiResponse<T>>
where
    T: DeserializeOwned + Default,
{
    let config = api_config(ctx)?;
    let path = config::endpoint(&config, endpoint_name)?.path.clone();
    api::api_request_raw(&*ctx.http, &config, &path, options)
}

/// 带会话的请求：自动把 token 作为 `token` 查询参数附上。
///
/// 1.x 的约定是 query 参数（不是请求头）；`upload_multipart` 除外——它把 token
/// 放在 multipart 表单里，见 [`upload`]。
pub fn authed<T>(
    ctx: &CoreCtx,
    endpoint_name: &str,
    options: &ApiOptions,
    not_logged_in: &str,
) -> CoreResult<ApiResponse<T>>
where
    T: DeserializeOwned + Default,
{
    let token = require_token(ctx, not_logged_in)?;
    let mut opts = options.clone();
    opts.query.push(("token".to_string(), token));
    request(ctx, endpoint_name, &opts)
}

/// 取当前会话 token（未登录返回 `None`，不报错——公开接口可匿名访问）。
pub fn token(ctx: &CoreCtx) -> CoreResult<Option<String>> {
    let Some(raw) = ctx.secrets.get(SESSION_SECRET_KEY)? else {
        return Ok(None);
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| CoreError::app("本地会话已损坏，请重新登录"))?;
    let token = value
        .get("token")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if token.is_empty() {
        return Ok(None);
    }
    Ok(Some(token))
}

/// 取 token，没有就按调用方给的文案报错（1.x 各 handler 文案不统一）。
pub fn require_token(ctx: &CoreCtx, not_logged_in: &str) -> CoreResult<String> {
    token(ctx)?.ok_or_else(|| CoreError::app(not_logged_in))
}

/// 下载图片字节（配图缓存 / 头像预览）。
pub fn download_image(ctx: &CoreCtx, url: &str) -> CoreResult<Vec<u8>> {
    api::download_binary(&*ctx.http, url)
}

/// 上传图片到 `uploadFile`，返回服务端 URL。
pub fn upload(ctx: &CoreCtx, token: &str, filename: &str, bytes: &[u8]) -> CoreResult<String> {
    let config = api_config(ctx)?;
    let path = config::endpoint(&config, "uploadFile")?.path.clone();
    let url = config::api_url(&config, &path);
    api::upload_multipart(&*ctx.http, &url, token, filename, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::net::api::ApiOptions;
    use crate::infra::net::config::endpoint as lookup;
    use crate::ports::SecretStore;
    use crate::testkit::{Harness, api_config_json};

    #[test]
    fn api_config_reads_resource_dir() {
        let h = Harness::new().with_api_config();
        let cfg = api_config(h.ctx()).unwrap();
        assert_eq!(cfg.base_url, "https://api.hqsf.test/");
        assert_eq!(lookup(&cfg, "userLogin").unwrap().path, "/api/userlogin");
    }

    #[test]
    fn missing_config_reports_tried_paths() {
        let h = Harness::new();
        let err = api_config(h.ctx()).unwrap_err();
        assert!(err.to_string().contains("未找到 api.config.json"), "{err}");
        assert!(
            err.to_string().contains("/resources/api.config.json"),
            "{err}"
        );
    }

    #[test]
    fn request_hits_endpoint_path_and_unwraps_data() {
        let h = Harness::new().with_api_config();
        h.http
            .enqueue(200, r#"{"code":1,"msg":"","data":{"uid":7}}"#);
        let resp: ApiResponse<serde_json::Value> =
            request(h.ctx(), "userInfo", &ApiOptions::get().query("uid", "7")).unwrap();
        assert_eq!(resp.data["uid"], 7);
        let last = h.last_request();
        assert_eq!(last.method, "GET");
        assert_eq!(last.url, "https://api.hqsf.test/api/userinfo?uid=7");
    }

    #[test]
    fn authed_appends_token_query() {
        let h = Harness::new().with_api_config().with_token("tok-123");
        h.http.enqueue(200, r#"{"code":1,"msg":"","data":null}"#);
        authed::<serde_json::Value>(h.ctx(), "userStatus", &ApiOptions::get(), "未登录").unwrap();
        assert_eq!(
            h.last_request().url,
            "https://api.hqsf.test/api/userstatus?token=tok-123"
        );
    }

    #[test]
    fn authed_without_session_uses_callers_wording() {
        let h = Harness::new().with_api_config();
        let err = authed::<serde_json::Value>(
            h.ctx(),
            "userStatus",
            &ApiOptions::get(),
            "未登录，无法查看收藏",
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法查看收藏");
        assert!(h.requests().is_empty(), "未登录不该发出请求");
    }

    #[test]
    fn token_is_none_when_absent_and_some_when_set() {
        let h = Harness::new();
        assert_eq!(token(h.ctx()).unwrap(), None);
        SecretStore::set(
            &*h.secrets,
            SESSION_SECRET_KEY,
            r#"{"token":"abc","userinfo":{}}"#,
        )
        .unwrap();
        assert_eq!(token(h.ctx()).unwrap().as_deref(), Some("abc"));
    }

    #[test]
    fn token_rejects_empty_and_corrupt_payloads() {
        let h = Harness::new();
        SecretStore::set(&*h.secrets, SESSION_SECRET_KEY, r#"{"token":""}"#).unwrap();
        assert_eq!(token(h.ctx()).unwrap(), None);
        SecretStore::set(&*h.secrets, SESSION_SECRET_KEY, "not json").unwrap();
        assert!(
            token(h.ctx())
                .unwrap_err()
                .to_string()
                .contains("会话已损坏")
        );
    }

    #[test]
    fn upload_uses_upload_file_endpoint_and_returns_url() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"url":"https://img.test/a.png"}}"#,
        );
        let url = upload(h.ctx(), "tok", "a.png", b"\x89PNG").unwrap();
        assert_eq!(url, "https://img.test/a.png");
        let last = h.last_request();
        assert_eq!(last.method, "POST");
        assert!(last.url.ends_with("/api/uploadfile"), "{}", last.url);
        let body = String::from_utf8_lossy(last.body.as_deref().unwrap_or_default()).to_string();
        assert!(body.contains("name=\"file\"; filename=\"a.png\""));
        assert!(body.contains("name=\"token\""));
    }

    #[test]
    fn test_config_json_covers_all_required_endpoints() {
        let value: serde_json::Value = serde_json::from_str(&api_config_json()).unwrap();
        for (name, _) in config::REQUIRED_ENDPOINTS {
            assert!(
                value["endpoints"].get(name).is_some(),
                "测试配置缺少接口 {name}"
            );
        }
    }
}
