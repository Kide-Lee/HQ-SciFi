//! 荒启 API 调用层（原 `src/main/infra/net/api.ts`，142 行）。
//!
//! 这一层只做四件事：拼 URL、编码 query/body、发请求、把响应解成 `{code,msg,data,total}`。
//! **业务字段规整不在这里**（在 `adapters/`），token 也**不在这里**（各命令从 `SecretStore`
//! 取出后经 [`ApiOptions::header`] 显式传入），这样本模块可以完全脱网单测。
//!
//! 错误文案与 1.x 逐字一致：网络层失败 `网络请求失败: …`、非 JSON `接口返回非 JSON（HTTP n）: …`、
//! `code != 1` 走 [`CoreError::Api`]（`msg` 原样给用户看）。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::config::{ApiConfig, HttpMethod, api_url};
use crate::error::{CoreError, CoreResult};
use crate::ports::{HttpRequest, HttpResponse, HttpTransport};

/// 1.x 沿用的 UA（服务端可能据此区分客户端，保持一致）。
pub const USER_AGENT: &str = "HuangqiSciFi-Client/0.1.0";

const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
const SNIPPET_LIMIT: usize = 200;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// 一次调用的参数。
#[derive(Debug, Clone)]
pub struct ApiOptions {
    pub method: HttpMethod,
    /// GET 的 query（顺序保留；调用方不传 `None`，所以不存在「跳过 undefined」的问题）。
    pub query: Vec<(String, String)>,
    /// POST 的表单字段。
    pub body: Vec<(String, String)>,
    /// 额外请求头（如 `token`）。
    pub headers: BTreeMap<String, String>,
    /// 跳过 `code == 1` 校验（下载/上传这类裸响应）。
    pub raw: bool,
    pub timeout_ms: u64,
}

impl Default for ApiOptions {
    fn default() -> Self {
        Self {
            method: HttpMethod::Get,
            query: Vec::new(),
            body: Vec::new(),
            headers: BTreeMap::new(),
            raw: false,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl ApiOptions {
    pub fn get() -> Self {
        Self::default()
    }

    pub fn post() -> Self {
        Self {
            method: HttpMethod::Post,
            ..Self::default()
        }
    }

    pub fn query(mut self, key: &str, value: impl Into<String>) -> Self {
        self.query.push((key.to_string(), value.into()));
        self
    }

    pub fn body(mut self, key: &str, value: impl Into<String>) -> Self {
        self.body.push((key.to_string(), value.into()));
        // 传了 body 却仍是 GET 是最常见的坑（1.x 的 GET 分支直接忽略 body），这里顺手纠正。
        if self.method == HttpMethod::Get {
            self.method = HttpMethod::Post;
        }
        self
    }

    pub fn header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.headers.insert(key.to_string(), value.into());
        self
    }

    /// 带 token 的调用（token 只在本进程内存里拼进请求头，绝不下发渲染层）。
    pub fn token(self, token: &str) -> Self {
        self.header("token", token)
    }

    pub fn with_raw(mut self) -> Self {
        self.raw = true;
        self
    }

    pub fn timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }
}

/// 荒启接口的统一响应壳：`{ code, msg, data, total }`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    #[serde(default)]
    pub code: i64,
    #[serde(default)]
    pub msg: String,
    #[serde(default)]
    pub data: T,
    #[serde(default)]
    pub total: Option<i64>,
}

/// 组装并发出请求（`api_request` / `api_request_value` 共用）。
fn send_request(
    http: &dyn HttpTransport,
    config: &ApiConfig,
    path: &str,
    options: &ApiOptions,
) -> CoreResult<HttpResponse> {
    let mut url = api_url(config, path);
    if options.method == HttpMethod::Get && !options.query.is_empty() {
        url.push('?');
        url.push_str(&encode_form(&options.query));
    }

    let mut headers = BTreeMap::new();
    headers.insert("Content-Type".to_string(), FORM_CONTENT_TYPE.to_string());
    headers.insert("User-Agent".to_string(), USER_AGENT.to_string());
    for (k, v) in &options.headers {
        headers.insert(k.clone(), v.clone());
    }

    let body = if options.method == HttpMethod::Post {
        Some(encode_form(&options.body).into_bytes())
    } else {
        None
    };

    send(
        http,
        HttpRequest {
            method: options.method.as_str().to_string(),
            url,
            headers,
            body,
            timeout_ms: options.timeout_ms,
        },
    )
}

/// 调接口并解包 `data`。
pub fn api_request<T>(
    http: &dyn HttpTransport,
    config: &ApiConfig,
    path: &str,
    options: &ApiOptions,
) -> CoreResult<ApiResponse<T>>
where
    T: DeserializeOwned + Default,
{
    let response = send_request(http, config, path, options)?;
    let text = String::from_utf8_lossy(&response.body).to_string();
    if options.raw {
        return serde_json::from_str::<ApiResponse<T>>(&text).map_err(|_| {
            CoreError::app(format!(
                "接口返回非 JSON（HTTP {}）: {}",
                response.status,
                snippet(&text)
            ))
        });
    }

    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        CoreError::app(format!(
            "接口返回非 JSON（HTTP {}）: {}",
            response.status,
            snippet(&text)
        ))
    })?;

    // 1.x 用 `code !== 1`：非数字/缺失/布尔 true 都算失败。
    let ok = value.get("code").and_then(|c| c.as_i64()) == Some(1);
    if !ok {
        let code = value.get("code");
        let code_num = code.and_then(|c| c.as_i64());
        let msg = value
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        let shown_code = match code {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Bool(b)) => b.to_string(),
            Some(serde_json::Value::Null) | None => "undefined".to_string(),
            Some(other) => other.to_string(),
        };
        let message = if msg.is_empty() {
            format!("接口错误（code={shown_code}）: {}", snippet(&text))
        } else {
            msg
        };
        return Err(CoreError::Api {
            code: code_num.unwrap_or(-1),
            msg: message,
        });
    }

    serde_json::from_value::<ApiResponse<T>>(value).map_err(CoreError::Json)
}

/// 不校验 `code` 的调用（等价 1.x `raw: true`）。
pub fn api_request_raw<T>(
    http: &dyn HttpTransport,
    config: &ApiConfig,
    path: &str,
    options: &ApiOptions,
) -> CoreResult<ApiResponse<T>>
where
    T: DeserializeOwned + Default,
{
    let raw = ApiOptions {
        raw: true,
        ..options.clone()
    };
    api_request(http, config, path, &raw)
}

/// 取整个响应体（1.x `raw: true` 的裸对象接口，如 `contentsInfo`）。
///
/// 与 [`api_request_raw`] 的区别：`api_request_raw` 仍按 `{code,msg,data}` 解包，
/// 这里**原样返回整个 JSON**——服务端有些接口直接返回对象，包成 `ApiResponse`
/// 会把内容丢成 `null`。
pub fn api_request_value(
    http: &dyn HttpTransport,
    config: &ApiConfig,
    path: &str,
    options: &ApiOptions,
) -> CoreResult<serde_json::Value> {
    let response = send_request(http, config, path, options)?;
    let text = String::from_utf8_lossy(&response.body).to_string();
    serde_json::from_str::<serde_json::Value>(&text).map_err(|_| {
        CoreError::app(format!(
            "接口返回非 JSON（HTTP {}）: {}",
            response.status,
            snippet(&text)
        ))
    })
}

/// 下载二进制（配图缓存用）。
pub fn download_binary(http: &dyn HttpTransport, url: &str) -> CoreResult<Vec<u8>> {
    let response = http
        .send(HttpRequest {
            method: "GET".to_string(),
            url: url.to_string(),
            headers: BTreeMap::new(),
            body: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        })
        .map_err(|e| CoreError::app(format!("图片下载失败: {e}")))?;
    if !response.is_success() {
        return Err(CoreError::app(format!(
            "图片下载失败（HTTP {}）",
            response.status
        )));
    }
    if response.body.is_empty() {
        return Err(CoreError::app("图片内容为空"));
    }
    Ok(response.body)
}

/// multipart 上传（配图）。成功返回服务端给的图片 URL。
pub fn upload_multipart(
    http: &dyn HttpTransport,
    url: &str,
    token: &str,
    filename: &str,
    bytes: &[u8],
) -> CoreResult<String> {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let boundary = format!("----hqsf-boundary-{}", SEQ.fetch_add(1, Ordering::Relaxed));

    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n",
            filename.replace('"', "_")
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"token\"\r\n\r\n");
    body.extend_from_slice(token.as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let mut headers = BTreeMap::new();
    headers.insert(
        "Content-Type".to_string(),
        format!("multipart/form-data; boundary={boundary}"),
    );
    headers.insert("User-Agent".to_string(), USER_AGENT.to_string());

    let response = send(
        http,
        HttpRequest {
            method: "POST".to_string(),
            url: url.to_string(),
            headers,
            body: Some(body),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        },
    )?;

    let text = String::from_utf8_lossy(&response.body).to_string();
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        CoreError::app(format!(
            "接口返回非 JSON（HTTP {}）: {}",
            response.status,
            snippet(&text)
        ))
    })?;
    let code_num = value.get("code").and_then(|c| c.as_i64());
    if code_num != Some(1) {
        let msg = value
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        let shown = match value.get("code") {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Null) | None => "undefined".to_string(),
            Some(other) => other.to_string(),
        };
        return Err(CoreError::Api {
            code: code_num.unwrap_or(-1),
            msg: if msg.is_empty() {
                format!("上传失败（code={shown}）")
            } else {
                msg
            },
        });
    }
    value
        .get("data")
        .and_then(|d| d.get("url"))
        .and_then(|u| u.as_str())
        .map(|u| u.to_string())
        .ok_or_else(|| CoreError::app("上传成功但响应缺少 data.url"))
}

fn send(http: &dyn HttpTransport, req: HttpRequest) -> CoreResult<HttpResponse> {
    http.send(req)
        .map_err(|e| CoreError::app(format!("网络请求失败: {e}")))
}

/// `application/x-www-form-urlencoded` 编码（等价 `URLSearchParams`：空格变 `+`，
/// 字母数字与 `*` `-` `.` `_` 原样，其余百分号编码）。
pub fn encode_form(pairs: &[(String, String)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&encode_component(k));
        out.push('=');
        out.push_str(&encode_component(v));
    }
    out
}

fn encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn snippet(text: &str) -> String {
    text.chars().take(SNIPPET_LIMIT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::net::config::{REQUIRED_ENDPOINTS, validate};
    use crate::testkit::ScriptedHttp;
    use serde_json::json;

    fn config() -> ApiConfig {
        let mut endpoints = serde_json::Map::new();
        for (name, _) in REQUIRED_ENDPOINTS {
            endpoints.insert(
                (*name).to_string(),
                json!({ "path": format!("api/{name}"), "method": "POST" }),
            );
        }
        validate(&json!({
            "baseUrl": "https://api.example.com/v1",
            "endpoints": endpoints
        }))
        .expect("配置应通过校验")
    }

    #[test]
    fn get_builds_query_and_default_headers() {
        let http = ScriptedHttp::new().push(200, r#"{"code":1,"msg":"ok","data":{"n":1}}"#);
        let resp: ApiResponse<serde_json::Value> = api_request(
            &http,
            &config(),
            "api/userLogin",
            &ApiOptions::get()
                .query("a", "1")
                .query("kw", "荒 启")
                .query("skip", "x"),
        )
        .expect("应成功");
        assert_eq!(resp.data["n"], 1);
        let call = &http.calls.lock().unwrap()[0];
        assert_eq!(call.method, "GET");
        assert_eq!(
            call.url,
            "https://api.example.com/v1/api/userLogin?a=1&kw=%E8%8D%92+%E5%90%AF&skip=x"
        );
        assert_eq!(call.headers["User-Agent"], USER_AGENT);
        assert_eq!(call.headers["Content-Type"], FORM_CONTENT_TYPE);
        assert!(call.body.is_none());
    }

    #[test]
    fn post_sends_form_body_and_custom_token_header() {
        let http = ScriptedHttp::new().push(200, r#"{"code":1,"msg":"","data":null}"#);
        let _: ApiResponse<()> = api_request(
            &http,
            &config(),
            "api/signOut",
            &ApiOptions::post().body("uid", "7").token("T0KEN"),
        )
        .expect("应成功");
        let call = &http.calls.lock().unwrap()[0];
        assert_eq!(call.method, "POST");
        assert_eq!(call.headers["token"], "T0KEN");
        assert_eq!(
            String::from_utf8_lossy(call.body.as_ref().unwrap()),
            "uid=7"
        );
    }

    #[test]
    fn body_turns_a_get_into_a_post() {
        let opts = ApiOptions::get().body("k", "v");
        assert_eq!(opts.method, HttpMethod::Post);
    }

    #[test]
    fn non_one_code_becomes_api_error_with_server_message() {
        let http = ScriptedHttp::new().push(200, r#"{"code":401,"msg":"请先登录","data":null}"#);
        let err =
            api_request::<serde_json::Value>(&http, &config(), "api/userInfo", &ApiOptions::get())
                .unwrap_err();
        assert_eq!(err.code(), "api");
        assert_eq!(err.api_code(), Some(401));
        assert_eq!(err.to_string(), "请先登录");
    }

    #[test]
    fn empty_message_falls_back_to_snippet() {
        let http = ScriptedHttp::new().push(200, r#"{"code":500,"msg":""}"#);
        let err =
            api_request::<serde_json::Value>(&http, &config(), "api/userInfo", &ApiOptions::get())
                .unwrap_err();
        let shown_code = "500";
        assert!(
            err.to_string()
                .contains(&format!("接口错误（code={shown_code}）"))
        );
        assert_eq!(err.api_code(), Some(500));
    }

    #[test]
    fn missing_code_is_treated_as_failure() {
        let http = ScriptedHttp::new().push(200, r#"{"msg":""}"#);
        let err =
            api_request::<serde_json::Value>(&http, &config(), "api/userInfo", &ApiOptions::get())
                .unwrap_err();
        assert_eq!(err.api_code(), Some(-1));
        assert!(err.to_string().contains("code=undefined"));
    }

    #[test]
    fn non_json_body_reports_status_and_snippet() {
        let http = ScriptedHttp::new().push(502, "<html>bad gateway</html>");
        let err =
            api_request::<serde_json::Value>(&http, &config(), "api/userInfo", &ApiOptions::get())
                .unwrap_err();
        assert_eq!(err.code(), "app");
        assert_eq!(
            err.to_string(),
            "接口返回非 JSON（HTTP 502）: <html>bad gateway</html>"
        );
    }

    #[test]
    fn transport_failure_is_wrapped_as_network_error() {
        let http = ScriptedHttp::new();
        let err =
            api_request::<serde_json::Value>(&http, &config(), "api/userInfo", &ApiOptions::get())
                .unwrap_err();
        assert!(err.to_string().starts_with("网络请求失败: "), "{err}");
    }

    #[test]
    fn raw_mode_skips_the_code_check() {
        let http = ScriptedHttp::new().push(
            200,
            r#"{"code":0,"data":{"url":"https://img.example.com/a.png"}}"#,
        );
        let resp: ApiResponse<serde_json::Value> =
            api_request_raw(&http, &config(), "api/uploadFile", &ApiOptions::post())
                .expect("raw 应成功");
        assert_eq!(resp.code, 0);
        assert_eq!(resp.data["url"], "https://img.example.com/a.png");
    }

    #[test]
    fn download_binary_covers_its_three_failure_messages() {
        let empty = ScriptedHttp::new().push(200, "");
        assert_eq!(
            download_binary(&empty, "https://img.example.com/a.png")
                .unwrap_err()
                .to_string(),
            "图片内容为空"
        );

        let http = ScriptedHttp::new().push(200, "PNGDATA");
        assert_eq!(
            download_binary(&http, "https://img.example.com/a.png").unwrap(),
            b"PNGDATA"
        );
        let call = &http.calls.lock().unwrap()[0];
        assert_eq!(call.method, "GET");
    }

    #[test]
    fn download_binary_reports_http_status() {
        let http = ScriptedHttp::new().push(404, "nope");
        assert_eq!(
            download_binary(&http, "https://img.example.com/a.png")
                .unwrap_err()
                .to_string(),
            "图片下载失败（HTTP 404）"
        );
    }

    #[test]
    fn upload_multipart_sends_file_and_token_and_returns_url() {
        let http = ScriptedHttp::new().push(
            200,
            r#"{"code":1,"msg":"ok","data":{"url":"https://img.example.com/x.png"}}"#,
        );
        let url = upload_multipart(
            &http,
            "https://api.example.com/v1/api/uploadFile",
            "TK",
            "x.png",
            b"BYTES",
        )
        .expect("应成功");
        assert_eq!(url, "https://img.example.com/x.png");
        let call = &http.calls.lock().unwrap()[0];
        let body = String::from_utf8_lossy(call.body.as_ref().unwrap()).to_string();
        assert!(body.contains("name=\"file\"; filename=\"x.png\""));
        assert!(body.contains("BYTES"));
        assert!(body.contains("name=\"token\""));
        assert!(body.contains("TK"));
        let ctype = &call.headers["Content-Type"];
        assert!(ctype.starts_with("multipart/form-data; boundary="));
    }

    #[test]
    fn upload_multipart_error_uses_message_or_bare_code() {
        let http = ScriptedHttp::new().push(200, r#"{"code":4001,"msg":"图片过大"}"#);
        let err =
            upload_multipart(&http, "https://api.example.com/u", "TK", "x.png", b"B").unwrap_err();
        assert_eq!(err.to_string(), "图片过大");

        let http = ScriptedHttp::new().push(200, r#"{"code":4002,"msg":""}"#);
        let err =
            upload_multipart(&http, "https://api.example.com/u", "TK", "x.png", b"B").unwrap_err();
        assert_eq!(err.to_string(), "上传失败（code=4002）");
    }
}
