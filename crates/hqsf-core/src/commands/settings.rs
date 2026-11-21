//! 设置领域通道（原 `src/main/ipc/settings.handlers.ts`，5 条）。
//!
//! 命令层只做转发：参数校验、平台判定、文件候选、窗口即时生效都在
//! `services::settings`，因此每条通道都能用 `testkit::Harness` 直接单测。
//! 壳层还需要实现的部分（1.x 在 handler/壳里做）：`update-settings` 之后
//! 若窗口还没建好，打开窗口时自行 `applyWindowCustomCode` 等价逻辑；
//! `uninstall` 成功返回后 `app.exit(0)`。

use std::path::Path;

use crate::commands::system::HostInfo;
use crate::ctx::CoreCtx;
use crate::error::CoreResult;
use crate::infra::settings;
use crate::services::settings as settings_service;

pub use crate::infra::settings::AppSettings;
pub use crate::services::settings::{ChangelogData, ClearCacheResult};

/// `hqsf:get-settings` → `AppSettings`。
pub fn get_settings(ctx: &CoreCtx) -> CoreResult<AppSettings> {
    Ok(settings_service::get(ctx))
}

/// `hqsf:update-settings`（`patch: Partial<AppSettings>`）→ 合并后的 `AppSettings`。
///
/// `patch` 用原始 `serde_json::Value`：1.x 对「非对象/数组」有专门错误文案
/// （`无效的设置数据`），对错类型字段是静默忽略——用强类型结构体会把这两种情况
/// 都变成反序列化失败，丢掉契约里的错误语义。
pub fn update_settings(ctx: &CoreCtx, patch: &serde_json::Value) -> CoreResult<AppSettings> {
    settings_service::update(ctx, patch)
}

/// `hqsf:get-changelog` → `ChangelogData`；版本号取壳层注入的 `HostInfo.app_version`。
pub fn get_changelog(ctx: &CoreCtx, host: &HostInfo) -> CoreResult<ChangelogData> {
    settings_service::changelog(ctx, &host.app_version)
}

/// `hqsf:clear-cache` → `ClearCacheResult`。
pub fn clear_cache(ctx: &CoreCtx) -> CoreResult<ClearCacheResult> {
    settings_service::clear_cache(ctx)
}

/// `hqsf:uninstall` → `null`（成功）/ 1.x 原文错误（非 Windows、找不到卸载器）。
///
/// `exe_path` 由壳层给（1.x `process.execPath`），用于定位同目录的 NSIS 卸载器；
/// 成功后壳层负责 `app.exit(0)`。
pub fn uninstall(ctx: &CoreCtx, host: &HostInfo, exe_path: &Path) -> CoreResult<()> {
    settings_service::uninstall(ctx, &host.platform, exe_path)
}

/// 供壳层在窗口创建/`did-finish-load` 时复用：把 `settings.json` 里的
/// 缩放/CSS/JS 应用到新窗口（1.x `applyWindowCustomCode` 的等价入口）。
///
/// 1.x 在 `window/index.ts` 的 did-finish-load/focus 里自动调用；Tauri 壳层在
/// `WebviewWindowBuilder` 完成后调一次即可。
pub fn apply_settings_to_window(ctx: &CoreCtx) -> CoreResult<()> {
    let current = settings::load_app_settings(ctx);
    crate::services::settings::apply_settings_to_window(ctx, &current);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::settings::DEFAULT_APP_SETTINGS;
    use crate::ports::FileStore;
    use crate::testkit::Harness;

    fn host(platform: &str) -> HostInfo {
        HostInfo {
            platform: platform.to_string(),
            arch: "x64".to_string(),
            app_version: "2.0.0".to_string(),
            is_test_mode: false,
            packaged: true,
            is_app_image: None,
        }
    }

    #[test]
    fn get_settings_returns_defaults_on_a_fresh_install() {
        let h = Harness::new();
        assert_eq!(get_settings(h.ctx()).unwrap(), DEFAULT_APP_SETTINGS);
    }

    #[test]
    fn update_settings_returns_merged_payload_and_camel_case() {
        let h = Harness::new();
        let next = update_settings(h.ctx(), &serde_json::json!({"zoomFactor": 1.1})).unwrap();
        assert_eq!(next.zoom_factor, 1.1);
        // 契约要求 AppSettings 走 camelCase（1.x TS 字段名）。
        let wire = serde_json::to_value(&next).unwrap();
        assert_eq!(wire["zoomFactor"], serde_json::json!(1.1));
        assert!(wire.get("hardwareAccel").is_some());
    }

    #[test]
    fn update_settings_rejects_array_patch_with_one_x_message() {
        let h = Harness::new();
        let err = update_settings(h.ctx(), &serde_json::json!([])).unwrap_err();
        assert_eq!(err.to_string(), "无效的设置数据");
    }

    #[test]
    fn get_changelog_uses_host_version() {
        let h = Harness::new();
        h.files
            .write(
                &h.ctx.paths.resource_dir.join("changelog.md"),
                "更新内容".as_bytes(),
            )
            .unwrap();
        let data = get_changelog(h.ctx(), &host("linux")).unwrap();
        assert_eq!(data.version, "2.0.0");
        assert_eq!(data.markdown, "更新内容");
    }

    #[test]
    fn get_changelog_missing_file_reports_one_x_error() {
        let h = Harness::new();
        let err = get_changelog(h.ctx(), &host("linux")).unwrap_err();
        assert_eq!(err.to_string(), "找不到更新日志文件");
    }

    #[test]
    fn clear_cache_reports_freed_bytes() {
        let h = Harness::new();
        let result = clear_cache(h.ctx()).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"freedBytes": 0})
        );
    }

    #[test]
    fn uninstall_non_windows_uses_contract_error() {
        let h = Harness::new();
        let err = uninstall(h.ctx(), &host("linux"), Path::new("/opt/hqsf/hqsf")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "当前平台不支持应用内卸载；请使用系统包管理器或删除应用目录"
        );
    }

    #[test]
    fn uninstall_windows_opens_uninstaller() {
        let h = Harness::new();
        let exe = Path::new("/tmp/hqsf/huangqi-scifi.exe");
        let uninstaller = Path::new("/tmp/hqsf/Uninstall huangqi-scifi.exe");
        h.files.write(uninstaller, b"x").unwrap();
        uninstall(h.ctx(), &host("win32"), exe).unwrap();
        assert_eq!(
            *h.launcher.opened_paths.lock().unwrap(),
            vec![uninstaller.to_path_buf()]
        );
    }

    #[test]
    fn apply_settings_to_window_pushes_zoom_css_js() {
        let h = Harness::new();
        h.files
            .write(
                &h.ctx.paths.settings_path(),
                br#"{"zoomFactor":1.3,"customCss":"body{}","customJs":"void 0"}"#,
            )
            .unwrap();
        apply_settings_to_window(h.ctx()).unwrap();
        assert_eq!(*h.window.zoom.lock().unwrap(), vec![1.3]);
        assert_eq!(*h.window.css.lock().unwrap(), vec!["body{}".to_string()]);
        assert_eq!(*h.window.js.lock().unwrap(), vec!["void 0".to_string()]);
    }
}
