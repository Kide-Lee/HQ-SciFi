//! 更新服务（原 `src/main/infra/updater/index.ts` 的编排部分）。
//!
//! 1.x 的 `checkForGitHubUpdate` 同时承担三件事：置 `checking` → 请求 GitHub →
//! 决定最终状态 → `setState` 广播 `hqsf:update-state`。Rust 侧把纯逻辑放进
//! [`crate::infra::updater`]（可脱网单测），本模块只做「状态机 + 广播 + 打开下载页」。
//!
//! 注意 A2：`hqsf:update-state` 既是 invoke 通道（读最近一次状态）也是推送事件
//! （每次状态变化广播），两条语义共用 [`crate::infra::updater::EVENT_UPDATE_STATE`]。

use crate::ctx::CoreCtx;
use crate::error::{CoreError, CoreResult};
use crate::infra::updater::{self, EVENT_UPDATE_STATE, UpdateState, UpdateStateStore};

/// 没有可下载更新时的文案（1.x `updater.handlers.ts:17-19` 逐字）。
pub const NO_DOWNLOAD_MESSAGE: &str = "当前没有可下载的更新";

/// 没有可安装更新时的文案（1.x `updater.handlers.ts:29-31` 逐字）。
pub const NO_INSTALL_MESSAGE: &str = "当前没有可安装的更新";

/// `hqsf:update-state`：读取最近一次状态（1.x `getLastState()`，对渲染层是同步 getter）。
pub fn get_update_state(store: &UpdateStateStore) -> UpdateState {
    store.get()
}

/// `hqsf:update-check`：检查 GitHub 最新 release 并广播状态（1.x `checkForGitHubUpdate`）。
///
/// 流程与 1.x 一致：先置 `checking` 并广播，再请求；无论成功失败都写回最终状态并广播，
/// 同时把最终状态作为返回值。因此「检查失败」**不是** IPC 错误——渲染层从状态里的
/// `error` 拿文案（1.x 的 catch 也是如此）。
pub fn check_for_github_update(ctx: &CoreCtx, store: &UpdateStateStore) -> CoreResult<UpdateState> {
    set_state(ctx, store, UpdateState::Checking);

    let next = match updater::fetch_latest_release(&*ctx.http) {
        Ok(release) => updater::state_for_release(store.app_version(), &release),
        Err(err) => UpdateState::Error {
            message: err.to_string(),
        },
    };

    Ok(set_state(ctx, store, next))
}

/// `hqsf:update-download`：用系统浏览器打开 release 页面（1.x `shell.openExternal(url)`）。
///
/// 1.x 没有自动下载/自动安装：deb/AppImage 都是「打开下载页，用户手动装」。
pub fn download_update(ctx: &CoreCtx, store: &UpdateStateStore) -> CoreResult<()> {
    let url = available_url(&store.get()).ok_or_else(|| CoreError::app(NO_DOWNLOAD_MESSAGE))?;
    ctx.platform.launcher.open_external(&url)
}

/// `hqsf:update-install`：与 [`download_update`] 同语义——打开下载页让用户手动安装。
///
/// 1.x `update-install` 也是 `shell.openExternal(state.url)`（不是 electron-updater 的
/// quitAndInstall），因此这里不做更激进的事，保持行为一致。
pub fn install_update(ctx: &CoreCtx, store: &UpdateStateStore) -> CoreResult<()> {
    let url = available_url(&store.get()).ok_or_else(|| CoreError::app(NO_INSTALL_MESSAGE))?;
    ctx.platform.launcher.open_external(&url)
}

/// 写入状态并广播事件（1.x `setState`：先存 `lastState`，再 `broadcast('hqsf:update-state', state)`）。
fn set_state(ctx: &CoreCtx, store: &UpdateStateStore, state: UpdateState) -> UpdateState {
    let state = store.set(state);
    if let Ok(payload) = serde_json::to_value(&state) {
        ctx.events.emit(EVENT_UPDATE_STATE, payload);
    }
    state
}

/// 「可下载/可安装」的判定（1.x：`status !== 'available' || !state.url` 即视为没有）。
///
/// 空串 url 与 `None` 一样按「没有」处理，与 1.x 的 falsy 判断一致。
fn available_url(state: &UpdateState) -> Option<String> {
    match state {
        UpdateState::Available { url: Some(url), .. } if !url.is_empty() => Some(url.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    const RELEASE: &str = r#"{
        "tag_name": "v0.2.0",
        "html_url": "https://github.com/Kide-Lee/HQ-SciFi/releases/tag/v0.2.0",
        "body": "本次更新：修复若干问题"
    }"#;

    fn store() -> UpdateStateStore {
        UpdateStateStore::new("0.1.0")
    }

    fn available(store: &UpdateStateStore, url: Option<&str>) -> UpdateState {
        store.set(UpdateState::Available {
            version: "0.2.0".into(),
            notes: Some("说明".into()),
            url: url.map(str::to_string),
        })
    }

    #[test]
    fn initial_state_is_idle() {
        assert_eq!(get_update_state(&store()), UpdateState::Idle);
    }

    #[test]
    fn check_publishes_checking_then_available() {
        let h = Harness::new();
        let store = store();
        h.http.enqueue(200, RELEASE);

        let state = check_for_github_update(h.ctx(), &store).unwrap();

        assert_eq!(
            state,
            UpdateState::Available {
                version: "0.2.0".into(),
                notes: Some("本次更新：修复若干问题".into()),
                url: Some("https://github.com/Kide-Lee/HQ-SciFi/releases/tag/v0.2.0".into()),
            }
        );
        assert_eq!(get_update_state(&store), state);

        let events = h.events.emitted.lock().unwrap();
        assert_eq!(events.len(), 2, "应先广播 checking、再广播最终状态");
        assert_eq!(events[0].0, EVENT_UPDATE_STATE);
        assert_eq!(events[0].1, json!({ "status": "checking" }));
        assert_eq!(
            events[1].1,
            json!({
                "status": "available",
                "version": "0.2.0",
                "notes": "本次更新：修复若干问题",
                "url": "https://github.com/Kide-Lee/HQ-SciFi/releases/tag/v0.2.0"
            })
        );
    }

    #[test]
    fn check_reports_not_available_for_an_equal_or_older_release() {
        let h = Harness::new();
        let store = UpdateStateStore::new("0.2.0");
        h.http.enqueue(
            200,
            json!({ "tag_name": "v0.2.0", "html_url": "u", "body": "" }).to_string(),
        );

        let state = check_for_github_update(h.ctx(), &store).unwrap();

        assert_eq!(state, UpdateState::NotAvailable);
        assert_eq!(
            h.events.last().unwrap().1,
            json!({ "status": "not-available" })
        );
    }

    #[test]
    fn check_failure_becomes_error_state_with_the_1x_message() {
        let h = Harness::new();
        let store = store();
        h.http.enqueue(404, r#"{"message":"Not Found"}"#);

        let state = check_for_github_update(h.ctx(), &store).unwrap();

        assert_eq!(
            state,
            UpdateState::Error {
                message: "GitHub 请求失败（HTTP 404）".into()
            }
        );
        assert_eq!(get_update_state(&store), state);
        assert_eq!(
            h.events.last().unwrap().1,
            json!({ "status": "error", "message": "GitHub 请求失败（HTTP 404）" })
        );
    }

    #[test]
    fn download_opens_the_release_page() {
        let h = Harness::new();
        let store = store();
        available(&store, Some("https://example.test/download"));

        download_update(h.ctx(), &store).unwrap();

        assert_eq!(
            h.launcher.opened.lock().unwrap().as_slice(),
            ["https://example.test/download"]
        );
    }

    #[test]
    fn download_without_an_available_update_uses_the_1x_message() {
        let h = Harness::new();
        let store = store();

        let err = download_update(h.ctx(), &store).unwrap_err();
        assert_eq!(err.to_string(), NO_DOWNLOAD_MESSAGE);

        // available 但没有 url / url 为空串 → 同样视为「没有可下载的更新」。
        store.set(UpdateState::Available {
            version: "0.2.0".into(),
            notes: None,
            url: None,
        });
        let err = download_update(h.ctx(), &store).unwrap_err();
        assert_eq!(err.to_string(), NO_DOWNLOAD_MESSAGE);

        available(&store, Some(""));
        let err = download_update(h.ctx(), &store).unwrap_err();
        assert_eq!(err.to_string(), NO_DOWNLOAD_MESSAGE);
        assert!(h.launcher.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn install_opens_the_release_page_like_download() {
        let h = Harness::new();
        let store = store();
        available(&store, Some("https://example.test/install"));

        install_update(h.ctx(), &store).unwrap();

        assert_eq!(
            h.launcher.opened.lock().unwrap().as_slice(),
            ["https://example.test/install"]
        );
    }

    #[test]
    fn install_without_an_available_update_uses_the_1x_message() {
        let h = Harness::new();
        let store = store();

        let err = install_update(h.ctx(), &store).unwrap_err();
        assert_eq!(err.to_string(), NO_INSTALL_MESSAGE);
        assert!(h.launcher.opened.lock().unwrap().is_empty());
    }
}
