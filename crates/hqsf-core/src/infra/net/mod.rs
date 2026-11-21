//! 网络层：API 配置（`api.config.json`）+ HTTP 调用。
//!
//! 分两半：`config` 负责「接口路径从哪来、怎么校验」，`api` 负责「怎么发、怎么解、怎么报错」。
//! 两者都不直接触网/读盘——分别经 [`crate::ports::HttpTransport`] 与 [`crate::ports::FileStore`]，
//! 所以本层可在无网络、无 WebView 的沙箱里全量单测。

pub mod api;
pub mod config;

pub use api::{
    ApiOptions, ApiResponse, USER_AGENT, api_request, api_request_raw, download_binary,
    encode_form, upload_multipart,
};
pub use config::{
    ApiConfig, ApiEndpoint, HttpMethod, REQUIRED_ENDPOINTS, api_base_url, api_url, endpoint,
    endpoint_desc, endpoints, load_api_config, validate,
};
