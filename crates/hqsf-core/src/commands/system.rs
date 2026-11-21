//! 系统域命令（对应 `src/main/ipc/system.handlers.ts`，5 条通道）。
//!
//! 逐条对应：
//! - `hqsf:ping` → [`ping`]
//! - `hqsf:get-app-info` → [`app_info`]
//! - `hqsf:copy-text` / `hqsf:read-clipboard-text` / `hqsf:read-clipboard-html` → 剪贴板（走端口，待 L1）

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::CoreResult;
use crate::ctx::CoreCtx;
use crate::ports::{MessageBoxKind, MessageBoxOptions};

/// 宿主信息：由壳层注入（内核不去问操作系统）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// `"linux" | "windows" | "macos"`，与 Electron `process.platform` 取值一致。
    pub platform: String,
    /// `process.arch` 取值：`x64` / `arm64`。
    pub arch: String,
    /// 应用版本，来自构建时的 `CARGO_PKG_VERSION` 或壳层注入。
    pub app_version: String,
    /// 是否测试模式（`HQSF_TEST=1`）。
    pub is_test_mode: bool,
    /// 是否打包发行版（1.x `app.isPackaged`；壳层按 `cfg!(debug_assertions)` 填）。
    pub packaged: bool,
    /// 是否是 AppImage 包（1.x `!!process.env.APPIMAGE`；非 Linux/非 AppImage 为 `None`）。
    pub is_app_image: Option<bool>,
}

/// `hqsf:get-app-info` 的载荷。字段与 1.x 保持同名同义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub is_test_mode: bool,
    /// 当前文档根目录（绝对路径）；壳层还没初始化时为空串（1.x 该通道永不失败）。
    pub docs_root: String,
    /// 是否打包发行版（1.x `app.isPackaged`，渲染层用来判断 deb 包）。
    pub packaged: bool,
    /// 是否是 AppImage 包（1.x `isAppImage?`；`None` 时序列化省略该字段）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_app_image: Option<bool>,
}

/// `hqsf:ping`：M0 遗留裸值接口（不套 `{ok,data}` 信封）。
pub fn ping() -> &'static str {
    "pong"
}

/// `hqsf:get-app-info`（1.x `get-app-info` **永不失败**）。
///
/// `docs_root` 为空（首次运行、壳层尚未初始化文档目录）时返回空串而不是报错：
/// 1.x 的 `TopBar`/`LoginView`/`FirstRunAgreement` 直接 `.then(...)` 没有 catch，
/// 这里一旦 Err 就会变成渲染层 unhandled rejection。
pub fn app_info(host: &HostInfo, docs_root: impl Into<String>) -> CoreResult<AppInfo> {
    Ok(AppInfo {
        version: host.app_version.clone(),
        platform: host.platform.clone(),
        arch: host.arch.clone(),
        is_test_mode: host.is_test_mode,
        docs_root: docs_root.into(),
        packaged: host.packaged,
        is_app_image: host.is_app_image,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> HostInfo {
        HostInfo {
            platform: "linux".into(),
            arch: "x64".into(),
            app_version: "2.0.0".into(),
            is_test_mode: false,
            packaged: true,
            is_app_image: None,
        }
    }

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn app_info_uses_camel_case_on_the_wire() {
        let info = app_info(&host(), "/home/u/文档").unwrap();
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""isTestMode":false"#), "实际：{json}");
        assert!(
            json.contains(r#""docsRoot":"/home/u/文档""#),
            "实际：{json}"
        );
        assert_eq!(info.version, "2.0.0");
    }

    #[test]
    fn app_info_returns_empty_docs_root_instead_of_failing() {
        // 1.x 该通道永不失败：空文档目录降级为空串（渲染层 .then 无 catch）。
        let info = app_info(&host(), "").unwrap();
        assert_eq!(info.docs_root, "");
        let padded = app_info(&host(), "  ").unwrap();
        assert_eq!(padded.docs_root, "  ");
    }

    #[test]
    fn app_info_carries_packaged_and_is_app_image() {
        let mut packaged = host();
        packaged.is_app_image = Some(true);
        let info = app_info(&packaged, "/docs").unwrap();
        assert!(info.packaged);
        assert_eq!(info.is_app_image, Some(true));
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["packaged"], serde_json::json!(true));
        assert_eq!(json["isAppImage"], serde_json::json!(true));

        // 非 AppImage：字段按 1.x `isAppImage?` 省略（不是 null）。
        let json = serde_json::to_value(app_info(&host(), "/docs").unwrap()).unwrap();
        assert!(json.get("isAppImage").is_none(), "实际：{json}");
    }
}

// ---------------------------------------------------------------------------
// L1 追加：剪贴板 3 条 + 消息框 1 条（原有 ping/get-app-info 未改）
// ---------------------------------------------------------------------------

/// `hqsf:show-message-box` 的图标类型（原 Electron `MessageBoxOptions['type']`）。
///
/// 缺省为 `Info`——1.x 是 `options?.type ?? 'info'`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ShowMessageBoxType {
    None,
    #[default]
    Info,
    Error,
    Question,
    Warning,
}

impl From<ShowMessageBoxType> for MessageBoxKind {
    fn from(value: ShowMessageBoxType) -> Self {
        match value {
            ShowMessageBoxType::None => MessageBoxKind::None,
            ShowMessageBoxType::Info => MessageBoxKind::Info,
            ShowMessageBoxType::Error => MessageBoxKind::Error,
            ShowMessageBoxType::Question => MessageBoxKind::Question,
            ShowMessageBoxType::Warning => MessageBoxKind::Warning,
        }
    }
}

/// `hqsf:show-message-box` 的入参（原 `MessageBoxOptions` 的内核子集）。
///
/// `message` 按契约 A8 是**必填**（1.x 代码里 `?? ''` 是历史兜底，渲染层始终会传）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShowMessageBoxOptions {
    /// wire 字段名是 `type`（Electron 的命名），不是 `kind`。
    #[serde(rename = "type")]
    pub kind: Option<ShowMessageBoxType>,
    pub title: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub buttons: Option<Vec<String>>,
    pub cancel_id: Option<i32>,
    pub default_id: Option<i32>,
}

/// `hqsf:show-message-box` 的载荷（原 `{ response }`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShowMessageBoxResult {
    /// 被点按钮的索引（`MessageBoxOptions.defaultId` 决定默认项）。
    pub response: i32,
}

/// `hqsf:get-app-info` 的注册名（`registry.rs` 的 `rust_command` 是 `get_app_info`）。
///
/// 内核历史 API 叫 [`app_info`]（已实现且有测试），这里保留两者：壳层按 registry 用
/// `get_app_info`，内核内部调用方继续用 `app_info`，行为完全一致。
pub fn get_app_info(host: &HostInfo, docs_root: impl Into<String>) -> CoreResult<AppInfo> {
    app_info(host, docs_root)
}

/// `hqsf:copy-text`：写系统剪贴板；成功 payload 为 `null`（1.x `ok(null)`）。
///
/// 1.x 对入参做了 `String(text ?? '')` 的兜底；wire 上是必填 `string`，
/// 兜底由壳层反序列化时静默处理（不可达分支，不在这里伪造）。
pub fn copy_text(ctx: &CoreCtx, text: impl Into<String>) -> CoreResult<()> {
    ctx.platform.clipboard.write_text(&text.into())
}

/// `hqsf:read-clipboard-text` → 剪贴板纯文本（1.x `clipboard.readText()`）。
pub fn read_clipboard_text(ctx: &CoreCtx) -> CoreResult<String> {
    ctx.platform.clipboard.read_text()
}

/// `hqsf:read-clipboard-html` → 剪贴板 HTML（1.x `clipboard.readHTML()`）。
pub fn read_clipboard_html(ctx: &CoreCtx) -> CoreResult<String> {
    ctx.platform.clipboard.read_html()
}

/// `hqsf:show-message-box` → `{ response }`。
///
/// 复刻 1.x `system.handlers.ts` 的默认值链：
/// `type ?? 'info'`、`title ?? '黄芪饮片'`、`detail` 为空串时不下发、
/// `buttons` 为空/缺失时 `['确定']`、超过 4 个按钮截断到 4 个（`slice(0,4)`）。
pub fn show_message_box(
    ctx: &CoreCtx,
    options: &ShowMessageBoxOptions,
) -> CoreResult<ShowMessageBoxResult> {
    let mut buttons = options.buttons.clone().unwrap_or_default();
    if buttons.is_empty() {
        buttons.push("确定".to_string());
    }
    buttons.truncate(4);
    let message_box = MessageBoxOptions {
        kind: options.kind.unwrap_or_default().into(),
        title: options
            .title
            .clone()
            .unwrap_or_else(|| "黄芪饮片".to_string()),
        message: options.message.clone(),
        // 1.x：`...(options?.detail ? { detail } : {})`（空串按真值判假，不下发）。
        detail: options.detail.clone().filter(|detail| !detail.is_empty()),
        buttons,
        cancel_id: options.cancel_id,
        default_id: options.default_id,
    };
    let response = ctx.platform.dialog.show_message_box(&message_box)?;
    Ok(ShowMessageBoxResult { response })
}

#[cfg(test)]
mod l1_clipboard_and_dialog_tests {
    use super::*;
    use crate::testkit::Harness;

    #[test]
    fn copy_text_writes_the_exact_string() {
        let h = Harness::new();
        copy_text(h.ctx(), "荒启科幻").unwrap();
        assert_eq!(*h.clipboard.written.lock().unwrap(), vec!["荒启科幻"]);
        assert_eq!(*h.clipboard.text.lock().unwrap(), "荒启科幻");
    }

    #[test]
    fn read_clipboard_text_and_html_return_port_values() {
        let h = Harness::new();
        *h.clipboard.text.lock().unwrap() = "纯文本".into();
        *h.clipboard.html.lock().unwrap() = "<b>富文本</b>".into();
        assert_eq!(read_clipboard_text(h.ctx()).unwrap(), "纯文本");
        assert_eq!(read_clipboard_html(h.ctx()).unwrap(), "<b>富文本</b>");
    }

    #[test]
    fn show_message_box_applies_one_x_defaults() {
        let h = Harness::new();
        *h.dialog.message_box_response.lock().unwrap() = 0;
        let result = show_message_box(
            h.ctx(),
            &serde_json::from_value(serde_json::json!({"message": "确定删除？"})).unwrap(),
        )
        .unwrap();
        assert_eq!(result, ShowMessageBoxResult { response: 0 });
        let boxes = h.dialog.message_boxes.lock().unwrap();
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].kind, MessageBoxKind::Info);
        assert_eq!(boxes[0].title, "黄芪饮片");
        assert_eq!(boxes[0].message, "确定删除？");
        assert_eq!(boxes[0].buttons, vec!["确定".to_string()]);
        assert_eq!(boxes[0].detail, None);
        assert_eq!(boxes[0].cancel_id, None);
        assert_eq!(boxes[0].default_id, None);
    }

    #[test]
    fn show_message_box_forwards_options_and_truncates_buttons() {
        let h = Harness::new();
        *h.dialog.message_box_response.lock().unwrap() = 2;
        let options: ShowMessageBoxOptions = serde_json::from_value(serde_json::json!({
            "type": "warning",
            "title": "确认",
            "message": "要覆盖吗？",
            "detail": "覆盖后无法恢复",
            "buttons": ["保存", "不保存", "取消", "另存为", "第五个"],
            "cancelId": 2,
            "defaultId": 1,
        }))
        .unwrap();
        let result = show_message_box(h.ctx(), &options).unwrap();
        assert_eq!(result.response, 2);
        let boxes = h.dialog.message_boxes.lock().unwrap();
        assert_eq!(boxes[0].kind, MessageBoxKind::Warning);
        assert_eq!(boxes[0].title, "确认");
        assert_eq!(boxes[0].detail.as_deref(), Some("覆盖后无法恢复"));
        assert_eq!(
            boxes[0].buttons,
            vec![
                "保存".to_string(),
                "不保存".to_string(),
                "取消".to_string(),
                "另存为".to_string()
            ]
        );
        assert_eq!(boxes[0].cancel_id, Some(2));
        assert_eq!(boxes[0].default_id, Some(1));
    }

    #[test]
    fn show_message_box_empty_detail_is_not_sent() {
        let h = Harness::new();
        let options: ShowMessageBoxOptions =
            serde_json::from_value(serde_json::json!({"message": "m", "detail": ""})).unwrap();
        show_message_box(h.ctx(), &options).unwrap();
        assert_eq!(h.dialog.message_boxes.lock().unwrap()[0].detail, None);
    }

    #[test]
    fn show_message_box_requires_message_a8() {
        let missing = serde_json::from_value::<ShowMessageBoxOptions>(serde_json::json!({}));
        assert!(missing.is_err(), "A8：message 必填");
        let null =
            serde_json::from_value::<ShowMessageBoxOptions>(serde_json::json!({"message": null}));
        assert!(null.is_err(), "A8：message 不接受 null");
    }

    #[test]
    fn show_message_box_type_serializes_lowercase() {
        let options = ShowMessageBoxOptions {
            kind: Some(ShowMessageBoxType::Question),
            title: None,
            message: "m".into(),
            detail: None,
            buttons: None,
            cancel_id: None,
            default_id: None,
        };
        let wire = serde_json::to_value(&options).unwrap();
        assert_eq!(wire["type"], serde_json::json!("question"));
        assert_eq!(wire["cancelId"], serde_json::Value::Null);
        assert_eq!(wire["defaultId"], serde_json::Value::Null);
    }
}
