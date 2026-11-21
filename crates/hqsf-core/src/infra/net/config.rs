//! `api.config.json` 的加载与校验（原 `src/main/infra/net/apiconfig.ts`，264 行）。
//!
//! 接口定义不再硬编码在代码里，统一从 `api.config.json` 读取：所有调用经 [`endpoint`] 取值，
//! 未配置的接口报 [`CoreError::Config`]（文案以 `[API 配置] ` 开头，与 1.x 一致，直接弹给开发者看）。
//!
//! 配置文件不入库，仓库提供模板 `api.config.example.json`。

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::error::{CoreError, CoreResult};
use crate::ports::FileStore;

/// HTTP 方法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            _ => None,
        }
    }
}

/// 一个接口的定义（`path` 不含基址，如 `hqUsers/userLogin`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiEndpoint {
    pub path: String,
    /// 接口定义记录的方法；调用处以显式传参为准（contentsInfo 等多形态接口由调用处覆盖）。
    pub method: HttpMethod,
}

/// 已校验的完整配置。
#[derive(Debug, Clone)]
pub struct ApiConfig {
    /// 基址，**保证以 `/` 结尾**（否则拼接会静默丢子路径）。
    pub base_url: String,
    pub endpoints: BTreeMap<String, ApiEndpoint>,
}

/// 接口名的常量（避免各模块手写字符串拼错）。与 [`REQUIRED_ENDPOINTS`] 一一对应。
pub mod endpoints {
    pub const USER_LOGIN: &str = "userLogin";
    pub const SIGN_OUT: &str = "signOut";
    pub const USER_INFO: &str = "userInfo";
    pub const USER_EDIT: &str = "userEdit";
    pub const USER_DATA: &str = "userData";
    pub const USER_STATUS: &str = "userStatus";
    pub const INBOX: &str = "inbox";
    pub const UNREAD_NUM: &str = "unreadNum";
    pub const SET_READ: &str = "setRead";
    pub const USER_LIST: &str = "userList";
    pub const GET_PRIVATE_CHAT: &str = "getPrivateChat";
    pub const MY_CHAT: &str = "myChat";
    pub const MSG_LIST: &str = "msgList";
    pub const SEND_MSG: &str = "sendMsg";
    pub const FOLLOW: &str = "follow";
    pub const IS_FOLLOW: &str = "isFollow";
    pub const FOLLOW_LIST: &str = "followList";
    pub const FAN_LIST: &str = "fanList";
    pub const CONTENTS_LIST: &str = "contentsList";
    pub const CONTENTS_INFO: &str = "contentsInfo";
    pub const CONTENTS_ADD: &str = "contentsAdd";
    pub const CONTENTS_UPDATE: &str = "contentsUpdate";
    pub const UPLOAD_FILE: &str = "uploadFile";
    pub const CHOICE_LIST: &str = "choiceList";
    pub const SELECT_CONTENTS: &str = "selectContents";
    pub const METAS_LIST: &str = "metasList";
    pub const GPT_LIST: &str = "gptList";
    pub const REVIEW_TASK: &str = "reviewTask";
    pub const REVIEW_LIST: &str = "reviewList";
    pub const ADD_REVIEW: &str = "addReview";
    pub const EDIT_REVIEW: &str = "editReview";
    pub const ATTITUDE: &str = "attitude";
    pub const COMMENTS_LIST: &str = "commentsList";
    pub const COMMENTS_ADD: &str = "commentsAdd";
    pub const ADD_LOG: &str = "addLog";
    pub const IS_MARK: &str = "isMark";
    pub const MARK_LIST: &str = "markList";
    pub const REMOVE_LOG: &str = "removeLog";
    pub const USER_TEXT_BLOCK_STATUS: &str = "userTextBlockStatus";
}

/// 程序必需的接口清单：(接口名, 用途说明)。与 `api.config.example.json` 的 `endpoints` 一一对应。
pub const REQUIRED_ENDPOINTS: &[(&str, &str)] = &[
    ("userLogin", "账号密码登录"),
    ("signOut", "退出登录"),
    ("userInfo", "用户资料（按 uid 查公开资料）"),
    (
        "userEdit",
        "编辑用户资料（昵称/头像/背景/简介/邮箱/手机号）",
    ),
    ("userData", "用户计数（粉丝/文章/评论/签到状态）"),
    ("userStatus", "当前用户状态（能量币/等级）"),
    ("inbox", "收件箱（消息中心）"),
    ("unreadNum", "未读消息数"),
    ("setRead", "标记消息已读"),
    ("userList", "用户搜索列表"),
    ("getPrivateChat", "获取/创建私聊会话"),
    ("myChat", "私聊会话列表"),
    ("msgList", "私聊消息列表"),
    ("sendMsg", "发送私聊消息"),
    ("follow", "关注/取关用户"),
    ("isFollow", "查询是否关注"),
    ("followList", "关注列表"),
    ("fanList", "粉丝列表"),
    ("contentsList", "文章列表（按状态/作者拉取）"),
    ("contentsInfo", "文章详情（全文）"),
    ("contentsAdd", "新建文章/草稿"),
    ("contentsUpdate", "更新文章/草稿"),
    ("uploadFile", "multipart 上传文件（配图）"),
    ("choiceList", "精选文章列表"),
    ("selectContents", "按栏目（mid）拉文章列表"),
    ("metasList", "栏目（metas）列表"),
    ("gptList", "AI 模型列表"),
    ("reviewTask", "评审任务列表"),
    ("reviewList", "评审列表"),
    ("addReview", "提交评审"),
    ("editReview", "编辑评审"),
    ("attitude", "评审态度表态"),
    ("commentsList", "评论列表"),
    ("commentsAdd", "发表评论"),
    ("addLog", "用户互动日志（点赞/收藏/投币）"),
    ("isMark", "查询收藏状态"),
    ("markList", "收藏列表（会话有效性探测用，无副作用）"),
    ("removeLog", "取消收藏"),
    ("userTextBlockStatus", "违禁词检测（付费，5 能量币/次）"),
];

/// 查用途说明（报错时提示开发者用）。
pub fn endpoint_desc(name: &str) -> &'static str {
    REQUIRED_ENDPOINTS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, d)| *d)
        .unwrap_or("未知用途")
}

/// 校验原始 JSON → [`ApiConfig`]；任何缺失/非法字段都报错（带开发者可读的修复指引）。
pub fn validate(raw: &serde_json::Value) -> CoreResult<ApiConfig> {
    let obj = raw
        .as_object()
        .ok_or_else(|| CoreError::config("配置文件顶层必须是对象 { baseUrl, endpoints }"))?;

    let raw_base = match obj.get("baseUrl") {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(other) => other.to_string(),
        None => "undefined".to_string(),
    };
    let shown = serde_json::Value::String(raw_base.clone()).to_string();
    if !(raw_base.starts_with("http://") || raw_base.starts_with("https://")) {
        return Err(CoreError::config(format!(
            "baseUrl 缺失或非法（应为 http(s):// 开头的 URL，当前值: {shown}）"
        )));
    }
    let base_url = if raw_base.ends_with('/') {
        raw_base
    } else {
        format!("{raw_base}/")
    };

    let endpoints_raw = obj
        .get("endpoints")
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            CoreError::config("缺少 endpoints 字段（应为对象 { 接口名: { path, method } }）")
        })?;

    let mut endpoints = BTreeMap::new();
    for (name, desc) in REQUIRED_ENDPOINTS {
        let Some(entry) = endpoints_raw.get(*name).and_then(|v| v.as_object()) else {
            return Err(CoreError::config(format!(
                "endpoints 缺少必填接口 \"{name}\"（{desc}）。请复制 api.config.example.json 为 api.config.json 后按需修改。"
            )));
        };
        let path = match entry.get("path") {
            Some(serde_json::Value::String(p)) if !p.is_empty() => p.clone(),
            _ => {
                return Err(CoreError::config(format!(
                    "endpoints.{name}.path 缺失或为空（{desc}；应为接口路径字符串，如 \"hqUsers/userLogin\"）"
                )));
            }
        };
        let method = match entry.get("method") {
            Some(serde_json::Value::String(m)) => HttpMethod::parse(m).ok_or_else(|| {
                CoreError::config(format!(
                    "endpoints.{name}.method 非法（应为 \"GET\" 或 \"POST\"，当前: \"{m}\"）"
                ))
            })?,
            other => {
                return Err(CoreError::config(format!(
                    "endpoints.{name}.method 非法（应为 \"GET\" 或 \"POST\"，当前: {}）",
                    other
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "undefined".to_string())
                )));
            }
        };
        endpoints.insert((*name).to_string(), ApiEndpoint { path, method });
    }
    Ok(ApiConfig {
        base_url,
        endpoints,
    })
}

/// 按优先级尝试候选路径，读取第一个存在的文件并校验。
///
/// 候选列表由壳层给出（它知道 `cwd` / `resources` / 环境变量），内核只负责读取与校验，
/// 这样「开发模式用项目根配置、打包后用 resources 配置」的行为不变而内核可单测。
pub fn load_api_config(files: &dyn FileStore, candidates: &[PathBuf]) -> CoreResult<ApiConfig> {
    let Some(found) = candidates.iter().find(|p| files.exists(p)) else {
        let tried = candidates
            .iter()
            .map(|p| format!("  - {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(CoreError::config(format!(
            "未找到 api.config.json。\n已尝试路径：\n{tried}\n请复制 api.config.example.json 为 api.config.json（可修改 baseUrl 指向自建服务端）。"
        )));
    };
    let bytes = files
        .read(found)
        .map_err(|e| CoreError::config(format!("读取配置文件失败（{}）: {e}", found.display())))?;
    let text = String::from_utf8_lossy(&bytes);
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        CoreError::config(format!(
            "配置文件 JSON 解析失败（{}）: {e}",
            found.display()
        ))
    })?;
    validate(&raw)
}

/// 取接口定义；配置缺失该接口时报错提示补全。
pub fn endpoint<'a>(config: &'a ApiConfig, name: &str) -> CoreResult<&'a ApiEndpoint> {
    config.endpoints.get(name).ok_or_else(|| {
        CoreError::config(format!(
            "配置中缺少接口 \"{name}\"（{}），请检查 api.config.json 的 endpoints 字段。",
            endpoint_desc(name)
        ))
    })
}

/// 荒启 API 基址。
pub fn api_base_url(config: &ApiConfig) -> &str {
    &config.base_url
}

/// `path` → 完整 URL（相对 `baseUrl` 解析；绝对 URL 原样返回）。
pub fn api_url(config: &ApiConfig, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    format!("{}{}", api_base_url(config), path.trim_start_matches('/'))
}
