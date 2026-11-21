//! 应用设置持久化（原 `src/main/infra/settings/index.ts`，逐字段对齐）。
//!
//! 存储 `ctx.paths.settings_path()`（= `data_dir/settings.json`）。1.x 把设置放在
//! userData 下，原因是硬件加速要在 app ready 前读取、缩放/CSS/JS 要主进程介入，
//! 不能只放渲染层 localStorage——这两条在 Tauri 里同样成立。
//!
//! 与 1.x 的差异（有意为之，见各函数注释）：
//! - 1.x 在模块级 `cached` 变量里缓存一份设置；内核 `CoreCtx` 无可变状态，因此**每次调用现读**
//!   （文件只有几百字节）。行为上等价，额外收益是测试隔离。
//! - 1.x `writeFileSync(..., { mode: 0o600 })` 的权限位在 `FileStore` 端口里没有表达，
//!   由壳层实现决定（桌面端建议仍按 0600 落盘）。
//! - 1.x `JSON.stringify(x, null, 2)` 把整数 1 写成 `1`，`serde_json` 会把 `f64` 写成 `1.0`；
//!   读回语义一致，只是文件文本有这一处无害差异。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ctx::CoreCtx;
use crate::error::{CoreError, CoreResult};

/// 缩放比例下限（1.x `normalize`：`Math.max(0.8, zoom)`）。
pub const ZOOM_FACTOR_MIN: f64 = 0.8;
/// 缩放比例上限（1.x `normalize`：`Math.min(1.5, zoom)`）。
pub const ZOOM_FACTOR_MAX: f64 = 1.5;

/// 主进程持久化设置（1.x `AppSettings`，`src/shared/domain/index.ts`）。
///
/// 字段名/语义与 1.x 完全一致；序列化为 camelCase 与 `settings.json` 的既有格式兼容。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 每次启动自动检查 GitHub 新版本。
    pub auto_update: bool,
    /// 是否启用硬件加速（关闭后需重启生效）。
    pub hardware_accel: bool,
    /// 页面缩放比例（0.8 ~ 1.5）。
    pub zoom_factor: f64,
    /// 用户自定义 CSS（最高优先级）。
    pub custom_css: String,
    /// 用户自定义 JS（所有界面加载）。
    pub custom_js: String,
}

/// 默认设置（1.x `DEFAULT_APP_SETTINGS`，`src/main/infra/settings/index.ts:12-18`）。
pub const DEFAULT_APP_SETTINGS: AppSettings = AppSettings {
    auto_update: false,
    hardware_accel: true,
    zoom_factor: 1.0,
    custom_css: String::new(),
    custom_js: String::new(),
};

impl Default for AppSettings {
    fn default() -> Self {
        DEFAULT_APP_SETTINGS
    }
}

/// 逐字段归一化（1.x `normalize`，`src/main/infra/settings/index.ts:26-36`）。
///
/// 刻意复刻 1.x 的 JS 宽松语义（设置文件是用户可手改的外部输入，不能让一条脏数据
/// 让整个设置不可用）：
/// - `!!r.autoUpdate` —— JS 真值：`false`/`0`/`""`/`null`/缺失 为 false，数组/对象为 true；
/// - `r.hardwareAccel !== false` —— 只有显式 `false` 才关闭，缺失/`null`/其它一律 true；
/// - `Number(r.zoomFactor)` —— 字符串数字也接受（`"1.2"` → 1.2），非有限值回退 1，
///   再夹到 0.8~1.5；
/// - `typeof x === 'string' ? x : ''` —— 非字符串回退空串。
fn normalize(raw: &serde_json::Value) -> AppSettings {
    // 1.x：`raw && typeof raw === 'object' ? raw : {}`。
    let r = raw.as_object();
    let zoom = js_number(r.and_then(|m| m.get("zoomFactor")));
    AppSettings {
        auto_update: js_truthy(r.and_then(|m| m.get("autoUpdate"))),
        hardware_accel: !matches!(
            r.and_then(|m| m.get("hardwareAccel")),
            Some(serde_json::Value::Bool(false))
        ),
        zoom_factor: if zoom.is_finite() {
            zoom.clamp(ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX)
        } else {
            1.0
        },
        custom_css: json_string(r.and_then(|m| m.get("customCss"))),
        custom_js: json_string(r.and_then(|m| m.get("customJs"))),
    }
}

/// JS `Number(value)` 的等价物（只覆盖设置文件里可能出现的 JSON 形状）。
fn js_number(value: Option<&serde_json::Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(serde_json::Value::Null) => 0.0,
        Some(serde_json::Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(serde_json::Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        // JS：`[]` → 0、`[x]` → Number(x)、多元素 → NaN。
        Some(serde_json::Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => js_number(items.first()),
            _ => f64::NAN,
        },
        Some(serde_json::Value::Object(_)) => f64::NAN,
    }
}

/// JS 真值判断（`!!value`）。
fn js_truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(serde_json::Value::Array(_) | serde_json::Value::Object(_)) => true,
    }
}

/// `typeof value === 'string' ? value : ''`。
fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 读取设置（1.x `loadAppSettings` / `getAppSettings`，`src/main/infra/settings/index.ts:39-56`）。
///
/// 文件缺失、读失败、JSON 损坏一律回退默认值且**不 panic**——1.x 用 `try/catch` 兜住，
/// 损坏的文件保持原样不覆盖（下一次 `update_settings` 才会重写）。
pub fn load_app_settings(ctx: &CoreCtx) -> AppSettings {
    let path = ctx.paths.settings_path();
    if !ctx.files.exists(&path) {
        return DEFAULT_APP_SETTINGS;
    }
    let Ok(bytes) = ctx.files.read(&path) else {
        return DEFAULT_APP_SETTINGS;
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(raw) => normalize(&raw),
        Err(_) => DEFAULT_APP_SETTINGS,
    }
}

/// 写入设置（1.x `updateAppSettings` 的落盘部分）。
pub fn save_app_settings(ctx: &CoreCtx, settings: &AppSettings) -> CoreResult<()> {
    let path = ctx.paths.settings_path();
    if let Some(parent) = path.parent() {
        ctx.files.create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(settings)?;
    ctx.files.write(&path, &json)
}

/// 应用补丁：校验 + 逐字段按类型过滤 + 浅合并 + 归一化 + 落盘。
///
/// 1.x 的校验在 handler 层（`src/main/ipc/settings.handlers.ts:23-32`），这里收进 infra，
/// 保持「命令层只做一行调用」的约定，同时**不改变错误文案与顺序**：
/// 1. `patch == null || typeof patch !== 'object' || Array.isArray(patch)` → `无效的设置数据`；
/// 2. 只有类型匹配的字段参与合并，其余静默忽略（不是报错）；
/// 3. 合并后整体 `normalize`（缩放会被重新夹到 0.8~1.5）。
pub fn update_app_settings(ctx: &CoreCtx, patch: &serde_json::Value) -> CoreResult<AppSettings> {
    let Some(patch) = patch.as_object() else {
        return Err(CoreError::app("无效的设置数据"));
    };
    let mut next = load_app_settings(ctx);
    if let Some(v) = patch.get("autoUpdate").and_then(serde_json::Value::as_bool) {
        next.auto_update = v;
    }
    if let Some(v) = patch
        .get("hardwareAccel")
        .and_then(serde_json::Value::as_bool)
    {
        next.hardware_accel = v;
    }
    if let Some(v) = patch.get("zoomFactor").and_then(serde_json::Value::as_f64) {
        next.zoom_factor = v;
    }
    if let Some(v) = patch.get("customCss").and_then(serde_json::Value::as_str) {
        next.custom_css = v.to_string();
    }
    if let Some(v) = patch.get("customJs").and_then(serde_json::Value::as_str) {
        next.custom_js = v.to_string();
    }
    // 1.x：`cached = normalize({ ...loadAppSettings(), ...patch })`。
    let next = normalize(&serde_json::to_value(&next)?);
    save_app_settings(ctx, &next)?;
    Ok(next)
}

/// 启动早期判断硬件加速（1.x `isHardwareAccelerationEnabled`，必须在 app ready 前调用）。
pub fn is_hardware_acceleration_enabled(ctx: &CoreCtx) -> bool {
    load_app_settings(ctx).hardware_accel
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FileStore;
    use crate::testkit::Harness;

    fn write_settings(h: &Harness, raw: &str) {
        h.files
            .write(&h.ctx.paths.settings_path(), raw.as_bytes())
            .unwrap();
    }

    #[test]
    fn missing_file_yields_defaults() {
        let h = Harness::new();
        assert_eq!(load_app_settings(h.ctx()), DEFAULT_APP_SETTINGS);
        assert!(is_hardware_acceleration_enabled(h.ctx()));
    }

    #[test]
    fn corrupt_json_yields_defaults_without_panicking() {
        let h = Harness::new();
        write_settings(&h, "{ not json");
        assert_eq!(load_app_settings(h.ctx()), DEFAULT_APP_SETTINGS);
        // 数组/标量也是「非对象」：1.x normalize 会当成 {}。
        write_settings(&h, "[1,2,3]");
        assert_eq!(load_app_settings(h.ctx()), DEFAULT_APP_SETTINGS);
    }

    #[test]
    fn defaults_match_one_x() {
        // 走 `Default`（运行时值）而不是直接断言 const，避免 clippy 的常量断言告警。
        let defaults = AppSettings::default();
        assert!(!defaults.auto_update);
        assert!(defaults.hardware_accel);
        assert_eq!(defaults.zoom_factor, 1.0);
        assert_eq!(defaults.custom_css, "");
        assert_eq!(defaults.custom_js, "");
        assert_eq!(defaults, DEFAULT_APP_SETTINGS);
    }

    #[test]
    fn normalize_coerces_like_the_javascript_version() {
        // 缩放：夹范围 / 字符串数字 / 非数字回退 1。
        assert_eq!(
            normalize(&serde_json::json!({"zoomFactor": 0.1})).zoom_factor,
            0.8
        );
        assert_eq!(
            normalize(&serde_json::json!({"zoomFactor": 9})).zoom_factor,
            1.5
        );
        assert_eq!(
            normalize(&serde_json::json!({"zoomFactor": "1.2"})).zoom_factor,
            1.2
        );
        assert_eq!(
            normalize(&serde_json::json!({"zoomFactor": "abc"})).zoom_factor,
            1.0
        );
        assert_eq!(normalize(&serde_json::json!({})).zoom_factor, 1.0);
        // 真值：0 / "" / false / null 为 false，字符串/数组为 true。
        assert!(!normalize(&serde_json::json!({"autoUpdate": 0})).auto_update);
        assert!(!normalize(&serde_json::json!({"autoUpdate": ""})).auto_update);
        assert!(!normalize(&serde_json::json!({"autoUpdate": null})).auto_update);
        assert!(normalize(&serde_json::json!({"autoUpdate": "no"})).auto_update);
        assert!(normalize(&serde_json::json!({"autoUpdate": []})).auto_update);
        // hardwareAccel：只有显式 false 才关闭。
        assert!(!normalize(&serde_json::json!({"hardwareAccel": false})).hardware_accel);
        assert!(normalize(&serde_json::json!({"hardwareAccel": null})).hardware_accel);
        assert!(normalize(&serde_json::json!({"hardwareAccel": 0})).hardware_accel);
        // 字符串字段：非字符串回退空串。
        assert_eq!(
            normalize(&serde_json::json!({"customCss": 42})).custom_css,
            ""
        );
        assert_eq!(
            normalize(&serde_json::json!({"customCss": "a{}"})).custom_css,
            "a{}"
        );
    }

    #[test]
    fn save_and_load_roundtrip_uses_camel_case_keys() {
        let h = Harness::new();
        let mut settings = DEFAULT_APP_SETTINGS.clone();
        settings.zoom_factor = 1.25;
        settings.custom_css = "body{}".into();
        settings.auto_update = true;
        save_app_settings(h.ctx(), &settings).unwrap();

        let raw = String::from_utf8(
            h.files
                .read(&h.ctx.paths.settings_path())
                .expect("设置文件应已落盘"),
        )
        .unwrap();
        for key in [
            "\"autoUpdate\"",
            "\"hardwareAccel\"",
            "\"zoomFactor\"",
            "\"customCss\"",
            "\"customJs\"",
        ] {
            assert!(raw.contains(key), "缺少 {key}：{raw}");
        }
        assert_eq!(load_app_settings(h.ctx()), settings);
    }

    #[test]
    fn update_merges_only_given_fields_and_ignores_wrong_types() {
        let h = Harness::new();
        let next = update_app_settings(
            h.ctx(),
            &serde_json::json!({"zoomFactor": 1.25, "autoUpdate": "yes", "unknown": 1}),
        )
        .unwrap();
        assert_eq!(next.zoom_factor, 1.25);
        // 错类型字段被静默忽略（1.x `typeof !== 'boolean'` 分支）。
        assert!(!next.auto_update);
        // 未传字段保持默认/当前值。
        assert!(next.hardware_accel);
        assert_eq!(next.custom_css, "");
        assert_eq!(load_app_settings(h.ctx()), next);
    }

    #[test]
    fn update_clamps_zoom_and_rejects_non_object_patch() {
        let h = Harness::new();
        let next = update_app_settings(h.ctx(), &serde_json::json!({"zoomFactor": 5})).unwrap();
        assert_eq!(next.zoom_factor, ZOOM_FACTOR_MAX);

        for bad in [
            serde_json::json!(null),
            serde_json::json!([1]),
            serde_json::json!("x"),
        ] {
            let err = update_app_settings(h.ctx(), &bad).unwrap_err();
            assert_eq!(err.to_string(), "无效的设置数据", "patch={bad}");
        }
    }

    #[test]
    fn is_hardware_acceleration_enabled_follows_file() {
        let h = Harness::new();
        write_settings(&h, r#"{"hardwareAccel": false}"#);
        assert!(!is_hardware_acceleration_enabled(h.ctx()));
    }
}
