//! `EventSink` 的 Tauri 实现：`AppHandle::emit`。
//!
//! 迁移来源：1.x `src/main/window/index.ts:70-71`（`mainWindow.webContents.send('hqsf:window-maximized-changed', bool)`）
//! 与 `src/main/infra/*` 里所有 `webContents.send('hqsf:*')` 推送（token 过期、同步进度、更新状态）。
//!
//! 与 Electron 的差异：
//!   - 事件名原样保留 `hqsf:*`（渲染层 `window.hqsf.on('hqsf:xxx')` 的订阅契约不变；
//!     tauri 的事件名允许 `:`，无需改写）。
//!   - 1.x 是「发给指定 window 的 webContents」；这里用 `AppHandle::emit` 广播给所有 webview。
//!     本应用只有一个窗口，行为等价；若将来有多个窗口，需要改成 `emit_to("main", ...)`
//!     （见 TODO）。
//!   - `emit` 的载荷走 serde_json::Value，与 1.x `ipcRenderer.on` 的 structured clone 等价。
//!   - 失败不抛：事件是旁路通知（1.x `webContents.send` 在窗口已销毁时也是静默失效），
//!     这里 eprintln 留痕后返回。

use hqsf_core::ports::EventSink;
use tauri::{AppHandle, Emitter};

/// 基于 AppHandle 的事件端口。
#[derive(Clone)]
pub struct TauriEvents {
    app: AppHandle,
}

impl TauriEvents {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl std::fmt::Debug for TauriEvents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TauriEvents")
    }
}

impl EventSink for TauriEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        // TODO(verify): 多窗口时改为 emit_to("main", event, payload)。
        if let Err(err) = self.app.emit(event, payload) {
            eprintln!("[hqsf] 事件发送失败 event={event}: {err}");
        }
    }
}
