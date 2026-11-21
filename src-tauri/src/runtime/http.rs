//! `HttpTransport` 的 reqwest 实现（1.x `src/main/infra/net/*` 的 undici/fetch 调用）。
//!
//! 迁移来源：`src/main/infra/net/client.ts`（`fetch(url, {method, headers, body, signal})` 封装）
//! 与 `src/main/infra/net/apiconfig.ts` 的请求发送部分。迁移计划 §L3 指定网络层用 reqwest。
//!
//! # 为什么是「专用 tokio runtime + spawn + recv_timeout」而不是 `block_on`
//! `HttpTransport::send` 是**同步** trait（内核不依赖 async 运行时），而 reqwest 只能 async 调用。
//! 三种做法：
//!   1. `tauri::async_runtime::block_on(...)`：在 `#[tauri::command] async fn` 里调用会嵌套进同一个
//!      runtime → **panic**（"Cannot start a runtime from within a runtime"），而我们的命令层正是
//!      async 的，所以不可取。
//!   2. reqwest 的 `blocking` feature：内部自建 runtime + `block_on`，语义与 1 相同，且会随调用线程
//!      数量膨胀 runtime；更重要的是 `blocking::Client` 不能在 async 上下文构造，限制太大。
//!   3. **本实现**：壳层自建一个 2 线程 tokio runtime，每次 `send` 把请求 `spawn` 过去，再用
//!      `std::sync::mpsc::recv_timeout` 等结果。
//!
//! 风险（必须在评审时知晓）：
//!   - `send` 会**阻塞调用线程**（tokio worker 或主线程）。命令层都是 async，因此阻塞的是 tokio
//!     worker 线程，不会卡 UI；但**绝不能在主线程调用**（启动路径里的同步探测、`setup` 阶段）。
//!   - 超时是双保险：reqwest 自身 `.timeout(...)` + `recv_timeout(timeout + 5s)`；后者触发时后台请求
//!     可能仍在跑（结果被丢弃），只是调用方不再等待。这不会泄漏连接，reqwest 会自行超时。
//!   - 与 1.x 的差异：Node 的 undici **不使用系统代理**（默认直连）；这里 `default-features = false`
//!     也关掉了 system-proxy，行为一致。若以后需要代理，改 `features` 并加 `proxy()`。
//!   - 与 1.x 的差异：1.x 用 `AbortController` 取消；这里只有超时，没有取消句柄（命令层不需要取消）。
//!   - 与 1.x 的差异：重定向策略沿用 reqwest 默认（跟随最多 10 跳），undici 默认 0 跳？——
//!     TODO(verify): 1.x 的 `apiRequest` 依赖 undici 默认 `redirect: 'follow'`，与 reqwest 一致，暂按跟随实现。

use std::sync::Arc;
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::time::Duration;

use hqsf_core::error::{CoreError, CoreResult};
use hqsf_core::ports::{HttpRequest, HttpResponse, HttpTransport};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

/// 未指定 `timeout_ms`（=0）时的默认超时。1.x `apiRequest` 默认 15s（api.config 里的 timeout）。
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 等待后台 task 的额外宽限，避免 reqwest 超时与通道超时同一瞬间抖动。
const CHANNEL_GRACE_MS: u64 = 5_000;
/// 后台 HTTP runtime 的 worker 线程数：并发命令很少，2 个足够。
const HTTP_WORKERS: usize = 2;
/// 与 1.x 的 UA 对齐（`hqsf-desktop/<version>`）。
const USER_AGENT: &str = concat!("hqsf-desktop/", env!("CARGO_PKG_VERSION"));

/// 基于 reqwest 的 HTTP 端口。
pub struct ReqwestHttp {
    client: reqwest::Client,
    runtime: Arc<tokio::runtime::Runtime>,
}

impl ReqwestHttp {
    /// 构造客户端与专用 runtime。失败返回 CoreError（启动路径由 `lib.rs` 转成弹框 + 退出）。
    pub fn new() -> CoreResult<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(HTTP_WORKERS)
            .thread_name("hqsf-http")
            .enable_all()
            .build()
            .map_err(|e| CoreError::app(format!("初始化网络运行时失败：{e}")))?;
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS))
            .build()
            .map_err(|e| CoreError::app(format!("初始化网络客户端失败：{e}")))?;
        Ok(Self {
            client,
            runtime: Arc::new(runtime),
        })
    }
}

impl std::fmt::Debug for ReqwestHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReqwestHttp")
    }
}

/// 真正发请求（在 runtime 线程里执行）。
async fn execute(client: reqwest::Client, request: HttpRequest) -> CoreResult<HttpResponse> {
    let timeout_ms = if request.timeout_ms == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        request.timeout_ms
    };

    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| CoreError::app(format!("非法的 HTTP 方法：{e}")))?;
    let url = reqwest::Url::parse(&request.url)
        .map_err(|e| CoreError::app(format!("非法的请求地址：{e}")))?;

    // header 透传：非法名/值的条目跳过（1.x 直接交给 undici，会抛错；这里宽松处理并留 TODO）。
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        // TODO(verify): 是否要把非法 header 当成错误（1.x 会抛 TypeError）。
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(value) else {
            continue;
        };
        headers.append(name, value);
    }

    let mut builder = client
        .request(method, url)
        .headers(headers)
        .timeout(Duration::from_millis(timeout_ms));
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| CoreError::app(format!("网络请求失败：{e}")))?;

    let status = resp.status().as_u16();
    let mut resp_headers = std::collections::BTreeMap::new();
    for (name, value) in resp.headers() {
        // 非 UTF-8 header 值丢弃（1.x `Headers.get` 也拿不到合法字符串）。
        if let Ok(v) = value.to_str() {
            resp_headers.insert(name.as_str().to_string(), v.to_string());
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| CoreError::app(format!("读取响应失败：{e}")))?
        .to_vec();
    Ok(HttpResponse {
        status,
        headers: resp_headers,
        body,
    })
}

impl HttpTransport for ReqwestHttp {
    fn send(&self, request: HttpRequest) -> CoreResult<HttpResponse> {
        // 同步阻塞：只能在 tokio worker（async 命令）里调，主线程会冻结 UI。
        // 这里只留痕不报错 —— 万一被主线程调用，至少日志能说明卡顿原因。
        if crate::runtime::is_main_thread() {
            eprintln!(
                "[hqsf] 警告：HttpTransport::send 在主线程调用（{}），界面会卡住",
                request.url
            );
        }
        let timeout_ms = if request.timeout_ms == 0 {
            DEFAULT_TIMEOUT_MS
        } else {
            request.timeout_ms
        };
        let client = self.client.clone();
        let (tx, rx) = channel();
        self.runtime.spawn(async move {
            // 发送端被丢弃（调用方已超时返回）时 `send` 失败，忽略即可。
            let _ = tx.send(execute(client, request).await);
        });
        match rx.recv_timeout(Duration::from_millis(timeout_ms + CHANNEL_GRACE_MS)) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(CoreError::app("网络请求超时，请稍后重试")),
            Err(RecvTimeoutError::Disconnected) => Err(CoreError::app("网络请求异常终止")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_url_without_panicking() {
        let http = ReqwestHttp::new().expect("runtime");
        let err = http
            .send(HttpRequest {
                method: "GET".into(),
                url: "not a url".into(),
                ..Default::default()
            })
            .expect_err("must fail");
        assert!(err.to_string().contains("请求地址"));
    }
}
