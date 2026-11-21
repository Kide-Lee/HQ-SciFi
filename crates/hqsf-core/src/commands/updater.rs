//! 更新域命令（对应 `src/main/ipc/updater.handlers.ts`，4 条通道 + 1 个事件）。
//!
//! 逐条对应：
//! - `hqsf:update-state` → [`update_state`]（读最近一次状态；**同时是推送事件名**，见 A2）
//! - `hqsf:update-check` → [`update_check`]（检查并广播 `hqsf:update-state`）
//! - `hqsf:update-download` → [`update_download`]（打开 release 页面）
//! - `hqsf:update-install` → [`update_install`]（同下载：1.x 是「横幅 + 手动下载」）
//!
//! 进程内状态 `lastState` 在 1.x 是模块级变量；Rust 内核无全局状态，
//! [`UpdateStateStore`] 由壳层构造并作为 Tauri managed state 注入，因此这里的
//! 命令都多一个 `store` 参数（壳层一行转发即可）。

use crate::ctx::CoreCtx;
use crate::error::CoreResult;
use crate::infra::updater::{UpdateState, UpdateStateStore};
use crate::services::updater;

/// `hqsf:update-state`（invoke）：返回最近一次的更新状态，不发起任何请求。
///
/// 与推送事件同名（契约 A2）：事件 payload 就是这里返回的 [`UpdateState`]。
pub fn update_state(store: &UpdateStateStore) -> CoreResult<UpdateState> {
    Ok(updater::get_update_state(store))
}

/// `hqsf:update-check`：检查 GitHub 最新 release。
///
/// 检查失败不以 Err 返回，而是 `{status:"error",message}` 状态（1.x 的 catch 同理），
/// 渲染层从事件/返回值里拿文案。
pub fn update_check(ctx: &CoreCtx, store: &UpdateStateStore) -> CoreResult<UpdateState> {
    updater::check_for_github_update(ctx, store)
}

/// `hqsf:update-download`：打开下载页（1.x `shell.openExternal(state.url)`）。
pub fn update_download(ctx: &CoreCtx, store: &UpdateStateStore) -> CoreResult<()> {
    updater::download_update(ctx, store)
}

/// `hqsf:update-install`：打开下载页让用户手动安装（1.x 同语义，不做 quitAndInstall）。
pub fn update_install(ctx: &CoreCtx, store: &UpdateStateStore) -> CoreResult<()> {
    updater::install_update(ctx, store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::updater::EVENT_UPDATE_STATE;
    use crate::testkit::Harness;
    use serde_json::json;

    fn store() -> UpdateStateStore {
        UpdateStateStore::new("0.1.0")
    }

    #[test]
    fn update_state_returns_the_stored_state() {
        let store = store();
        assert_eq!(update_state(&store).unwrap(), UpdateState::Idle);

        store.set(UpdateState::NotAvailable);
        assert_eq!(update_state(&store).unwrap(), UpdateState::NotAvailable);
    }

    #[test]
    fn update_check_returns_and_broadcasts_the_final_state() {
        let h = Harness::new();
        let store = store();
        h.http.enqueue(
            200,
            json!({
                "tag_name": "v0.2.0",
                "html_url": "https://example.test/r",
                "body": "说明"
            })
            .to_string(),
        );

        let state = update_check(h.ctx(), &store).unwrap();

        assert_eq!(
            state,
            UpdateState::Available {
                version: "0.2.0".into(),
                notes: Some("说明".into()),
                url: Some("https://example.test/r".into()),
            }
        );
        assert_eq!(update_state(&store).unwrap(), state);
        let events = h.events.emitted.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, EVENT_UPDATE_STATE);
        assert_eq!(events[0].1, json!({ "status": "checking" }));
        assert_eq!(events[1].0, EVENT_UPDATE_STATE);
        assert_eq!(events[1].1["status"], json!("available"));
    }

    #[test]
    fn update_download_opens_the_url_and_reports_missing_updates() {
        let h = Harness::new();
        let store = store();
        let err = update_download(h.ctx(), &store).unwrap_err();
        assert_eq!(err.to_string(), "当前没有可下载的更新");

        store.set(UpdateState::Available {
            version: "0.2.0".into(),
            notes: None,
            url: Some("https://example.test/dl".into()),
        });
        update_download(h.ctx(), &store).unwrap();
        assert_eq!(
            h.launcher.opened.lock().unwrap().as_slice(),
            ["https://example.test/dl"]
        );
    }

    #[test]
    fn update_install_opens_the_url_and_reports_missing_updates() {
        let h = Harness::new();
        let store = store();
        let err = update_install(h.ctx(), &store).unwrap_err();
        assert_eq!(err.to_string(), "当前没有可安装的更新");

        store.set(UpdateState::Available {
            version: "0.2.0".into(),
            notes: None,
            url: Some("https://example.test/install".into()),
        });
        update_install(h.ctx(), &store).unwrap();
        assert_eq!(
            h.launcher.opened.lock().unwrap().as_slice(),
            ["https://example.test/install"]
        );
    }
}
