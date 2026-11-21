//! 设置领域服务：设置读写编排、更新日志、清缓存、应用内卸载。
//!
//! 对应 1.x：`src/main/ipc/settings.handlers.ts` + `src/main/services/settings-service.ts`。
//! 命令层（`commands/settings.rs`）只做参数转发，平台判定/文件候选/窗口即时生效都在这里，
//! 这样每条通道的分支都能用 `testkit::Harness` 单测。

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::ctx::CoreCtx;
use crate::error::{CoreError, CoreResult};
use crate::infra::settings as infra_settings;
use crate::infra::settings::AppSettings;

/// `hqsf:get-changelog` 的载荷（1.x `ChangelogData`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogData {
    /// 当前版本号（壳层注入，1.x `app.getVersion()`）。
    pub version: String,
    /// `changelog.md` 原文。
    pub markdown: String,
}

/// `hqsf:clear-cache` 的载荷（1.x `{ freedBytes }`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    /// 释放的图片缓存字节数（1.x `clearImageCache()` 的返回值）。
    pub freed_bytes: u64,
}

/// 1.x 文案：非 Windows 不支持应用内卸载。
pub const UNINSTALL_UNSUPPORTED: &str =
    "当前平台不支持应用内卸载；请使用系统包管理器或删除应用目录";
/// 1.x 文案：Windows 下找不到 NSIS 卸载器。
pub const UNINSTALLER_NOT_FOUND: &str = "未找到卸载程序，请打开系统设置中的应用列表手动卸载";
/// 1.x 文案：三处候选都没有更新日志。
pub const CHANGELOG_NOT_FOUND: &str = "找不到更新日志文件";

/// 读取设置（`hqsf:get-settings`）。
pub fn get(ctx: &CoreCtx) -> AppSettings {
    infra_settings::load_app_settings(ctx)
}

/// 应用设置补丁（`hqsf:update-settings`）。
///
/// 除落盘外，还复刻 1.x handler 的窗口即时生效：**只有补丁里带了** `zoomFactor`（number）/
/// `customCss`（string）/`customJs`（string）才调 `applyWindowCustomCode`；只是改开关类
/// 字段（autoUpdate/hardwareAccel）时不重跑用户 JS——1.x 的 condition 就是这三个字段。
pub fn update(ctx: &CoreCtx, patch: &serde_json::Value) -> CoreResult<AppSettings> {
    let next = infra_settings::update_app_settings(ctx, patch)?;
    let touches_window = patch
        .get("zoomFactor")
        .is_some_and(serde_json::Value::is_f64)
        || patch
            .get("customCss")
            .is_some_and(serde_json::Value::is_string)
        || patch
            .get("customJs")
            .is_some_and(serde_json::Value::is_string);
    if touches_window {
        apply_settings_to_window(ctx, &next);
    }
    Ok(next)
}

/// 窗口即时生效（1.x `applyWindowCustomCode`，`src/main/window/index.ts:95-122`）。
///
/// 逐项容错（1.x 里 zoom 用 try/catch、CSS 用 `.catch()`、JS 用 `.catch(log)`）：
/// 任一端口失败都不影响设置已经落盘、也不让通道返回错误。
///
/// 接缝：1.x 会保存上次注入 CSS 的 key 并先 `removeInsertedCSS`；内核无窗口状态，
/// 因此这里只负责“注入新 CSS”，**替换/清空旧 CSS 由壳层 `WindowOps::insert_css`
/// 实现为“重新注入即替换”**（已与 shell-tauri 对齐）。
pub fn apply_settings_to_window(ctx: &CoreCtx, settings: &AppSettings) {
    let window = &ctx.platform.window;
    let _ = window.set_zoom(settings.zoom_factor);
    if !settings.custom_css.is_empty() {
        let _ = window.insert_css(&settings.custom_css);
    }
    if !settings.custom_js.is_empty() {
        let _ = window.execute_js(&settings.custom_js);
    }
}

/// 读取更新日志（`hqsf:get-changelog`，1.x `getChangelogData()`）。
///
/// 候选顺序对齐 1.x（`process.resourcesPath/changelog.md` → `app.getAppPath()/doc/CHANGELOG.md`
/// → `process.cwd()/doc/CHANGELOG.md`）；桌面打包后后两者都落在
/// `resource_dir/doc/CHANGELOG.md`（对应 `src-tauri/tauri.conf.json` 的 resources 映射）。
pub fn changelog(ctx: &CoreCtx, version: &str) -> CoreResult<ChangelogData> {
    let candidates = [
        ctx.paths.resource_dir.join("changelog.md"),
        ctx.paths.resource_dir.join("doc").join("CHANGELOG.md"),
    ];
    let Some(path) = candidates.iter().find(|path| ctx.files.exists(path)) else {
        return Err(CoreError::app(CHANGELOG_NOT_FOUND));
    };
    // 1.x `readFileSync(file,'utf8')` 遇到非法 UTF-8 是替换字符、不抛错，这里同样 lossy。
    let markdown = String::from_utf8_lossy(&ctx.files.read(path)?).into_owned();
    Ok(ChangelogData {
        version: version.to_string(),
        markdown,
    })
}

/// 清缓存（`hqsf:clear-cache`，1.x handler 里 `clearImageCache()` + `clearReadCache()` + `session.clearCache()`）。
///
/// 顺序与 1.x `settings.handlers.ts` 一致：先清图片缓存（磁盘 + 内存），再清 DB 的
/// `read_cache`，最后（壳层可选）`session.clearCache()`——后者内核无端口且 1.x 就忽略失败。
pub fn clear_cache(ctx: &CoreCtx) -> CoreResult<ClearCacheResult> {
    let freed_bytes = crate::infra::media::clear_image_cache(ctx);
    ctx.db.clear_read_cache()?;
    Ok(ClearCacheResult { freed_bytes })
}

/// 应用内卸载（`hqsf:uninstall`，1.x `uninstallApplication()`）。
///
/// - 非 Windows：返回 1.x 原文错误（契约 errors 唯一列出的一条）。
/// - Windows：在 exe 同目录找 NSIS 卸载器（1.x 只认 `Uninstall huangqi-scifi.exe`，
///   这里额外容忍 `uninstall.exe`/`Uninstall.exe` —— 后者是 Tauri NSIS 的默认文件名，
///   属于壳层打包名差异，不影响错误文案）；找不到报 1.x 原文。
///
/// 偏差：1.x `spawn(detached)` 后 `app.quit()`；内核无进程端口，改为
/// `Launcher::open_path` 交给壳层启动卸载器，**壳层在命令返回后自行 `app.exit(0)`**。
pub fn uninstall(ctx: &CoreCtx, platform: &str, exe_path: &Path) -> CoreResult<()> {
    if !is_windows(platform) {
        return Err(CoreError::app(UNINSTALL_UNSUPPORTED));
    }
    let Some(dir) = exe_path.parent() else {
        return Err(CoreError::app(UNINSTALLER_NOT_FOUND));
    };
    let candidates = [
        dir.join("Uninstall huangqi-scifi.exe"),
        dir.join("uninstall.exe"),
        dir.join("Uninstall.exe"),
    ];
    let Some(uninstaller) = candidates
        .iter()
        .find(|path| ctx.files.exists(path.as_path()))
    else {
        return Err(CoreError::app(UNINSTALLER_NOT_FOUND));
    };
    ctx.platform.launcher.open_path(uninstaller)
}

/// 平台判定：既接受 1.x `process.platform` 的 `"win32"`，也接受 Rust 侧习惯的 `"windows"`。
fn is_windows(platform: &str) -> bool {
    matches!(
        platform.trim().to_ascii_lowercase().as_str(),
        "windows" | "win32"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::settings::{DEFAULT_APP_SETTINGS, load_app_settings};
    use crate::ports::FileStore;
    use crate::testkit::Harness;

    #[test]
    fn get_reads_persisted_settings() {
        let h = Harness::new();
        let settings = get(h.ctx());
        assert_eq!(settings, DEFAULT_APP_SETTINGS);
    }

    #[test]
    fn update_persists_and_applies_zoom_css_js() {
        let h = Harness::new();
        let next = update(
            h.ctx(),
            &serde_json::json!({
                "zoomFactor": 1.25,
                "customCss": "body { color: red; }",
                "customJs": "console.log('hi')",
            }),
        )
        .unwrap();
        assert_eq!(next.zoom_factor, 1.25);
        assert_eq!(load_app_settings(h.ctx()), next);
        assert_eq!(*h.window.zoom.lock().unwrap(), vec![1.25]);
        assert_eq!(
            *h.window.css.lock().unwrap(),
            vec!["body { color: red; }".to_string()]
        );
        assert_eq!(
            *h.window.js.lock().unwrap(),
            vec!["console.log('hi')".to_string()]
        );
    }

    #[test]
    fn update_without_window_fields_does_not_touch_the_window() {
        let h = Harness::new();
        update(h.ctx(), &serde_json::json!({"autoUpdate": true})).unwrap();
        assert!(h.window.zoom.lock().unwrap().is_empty());
        assert!(h.window.css.lock().unwrap().is_empty());
        assert!(h.window.js.lock().unwrap().is_empty());
    }

    #[test]
    fn update_rejects_non_object_patch() {
        let h = Harness::new();
        let err = update(h.ctx(), &serde_json::json!([])).unwrap_err();
        assert_eq!(err.to_string(), "无效的设置数据");
    }

    #[test]
    fn changelog_reads_resource_changelog_md() {
        let h = Harness::new();
        h.files
            .write(
                &h.ctx.paths.resource_dir.join("changelog.md"),
                "# 2.0.0\n- 新内核".as_bytes(),
            )
            .unwrap();
        let data = changelog(h.ctx(), "2.0.0").unwrap();
        assert_eq!(data.version, "2.0.0");
        assert_eq!(data.markdown, "# 2.0.0\n- 新内核");
    }

    #[test]
    fn changelog_falls_back_to_doc_directory() {
        let h = Harness::new();
        h.files
            .write(
                &h.ctx.paths.resource_dir.join("doc").join("CHANGELOG.md"),
                "doc 版本".as_bytes(),
            )
            .unwrap();
        assert_eq!(changelog(h.ctx(), "2.0.0").unwrap().markdown, "doc 版本");
    }

    #[test]
    fn changelog_missing_uses_one_x_message() {
        let h = Harness::new();
        let err = changelog(h.ctx(), "2.0.0").unwrap_err();
        assert_eq!(err.to_string(), "找不到更新日志文件");
    }

    #[test]
    fn clear_cache_clears_read_cache_only() {
        let h = Harness::new();
        h.ctx
            .db
            .set_read_cache("a", &serde_json::json!({"x": 1}), 1_700_000_000_000)
            .unwrap();
        assert_eq!(h.ctx.db.read_cache_len().unwrap(), 1);
        let result = clear_cache(h.ctx()).unwrap();
        assert_eq!(result.freed_bytes, 0);
        assert_eq!(h.ctx.db.read_cache_len().unwrap(), 0);
    }

    #[test]
    fn uninstall_rejects_non_windows_platforms() {
        let h = Harness::new();
        for platform in ["linux", "darwin", "macos"] {
            let err = uninstall(h.ctx(), platform, Path::new("/opt/hqsf/hqsf")).unwrap_err();
            assert_eq!(
                err.to_string(),
                "当前平台不支持应用内卸载；请使用系统包管理器或删除应用目录",
                "platform={platform}"
            );
        }
        assert!(h.launcher.opened_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn uninstall_opens_the_windows_uninstaller() {
        let h = Harness::new();
        let exe = Path::new("/tmp/hqsf/huangqi-scifi.exe");
        let uninstaller = Path::new("/tmp/hqsf/Uninstall huangqi-scifi.exe");
        h.files.write(uninstaller, b"x").unwrap();
        for platform in ["win32", "windows", " Windows "] {
            uninstall(h.ctx(), platform, exe).unwrap();
        }
        assert_eq!(
            *h.launcher.opened_paths.lock().unwrap(),
            vec![uninstaller.to_path_buf(); 3]
        );
    }

    #[test]
    fn uninstall_without_uninstaller_uses_one_x_message() {
        let h = Harness::new();
        let err =
            uninstall(h.ctx(), "win32", Path::new("/tmp/hqsf/huangqi-scifi.exe")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "未找到卸载程序，请打开系统设置中的应用列表手动卸载"
        );
        assert!(h.launcher.opened_paths.lock().unwrap().is_empty());
    }

    #[test]
    fn is_windows_accepts_both_spellings() {
        assert!(is_windows("win32"));
        assert!(is_windows("windows"));
        assert!(is_windows("WINDOWS"));
        assert!(!is_windows("linux"));
        assert!(!is_windows("darwin"));
    }
}
