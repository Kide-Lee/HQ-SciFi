//! 窗口控制通道（原 `src/main/ipc/window.handlers.ts`，5 条）。
//!
//! 每条都只转 `ctx.platform.window`（[`crate::ports::WindowOps`]），内核不感知
//! Tauri/Electron；「没有窗口」在 1.x 里是 `windowOf(event) → undefined`，在壳层
//! 表现为端口实现本身不可用，因此内核侧没有对应分支。
//!
//! 函数名按 `commands/registry.rs` 的 `rust_command` 固化（`window_*` 前缀），
//! 壳层一一对应生成 `#[tauri::command]`。
//!
//! 契约异常 A5：1.x `toggle-devtools` 没有 try/catch，失败直接抛到 IPC 层；
//! 这里统一走 `CoreResult`（端口不返回错误 → 恒 `Ok`），是**有意的签名收敛**，
//! 契约行为不变（成功 `null`）。

use crate::ctx::CoreCtx;
use crate::error::CoreResult;

/// `hqsf:window-minimize`：最小化；payload `null`。
pub fn window_minimize(ctx: &CoreCtx) -> CoreResult<()> {
    ctx.platform.window.minimize();
    Ok(())
}

/// `hqsf:window-maximize-toggle`：切换最大化并返回切换后的状态（1.x 裸值 boolean）。
///
/// 直接用端口返回值：1.x 在 `maximize()/unmaximize()` 后同步读 `isMaximized()`，
/// 而 GTK/Win32 的最大化是异步落到窗口系统的，内核再读一次可能读到旧值；
/// 端口契约（`WindowOps::toggle_maximize -> CoreResult<bool>`）要求返回切换后的状态，
/// 由壳层负责等到窗口状态真正生效。
pub fn window_maximize_toggle(ctx: &CoreCtx) -> CoreResult<bool> {
    ctx.platform.window.toggle_maximize()
}

/// `hqsf:window-close`：关闭窗口；payload `null`。
pub fn window_close(ctx: &CoreCtx) -> CoreResult<()> {
    ctx.platform.window.close();
    Ok(())
}

/// `hqsf:window-is-maximized`：是否最大化（1.x 无窗口 `?? false`，由壳层给 false）。
pub fn window_is_maximized(ctx: &CoreCtx) -> CoreResult<bool> {
    Ok(ctx.platform.window.is_maximized())
}

/// `hqsf:toggle-devtools`：开关开发者工具；payload `null`。
///
/// 1.x 的失败分支是「窗口不存在」（A5）；端口层不返回结果，故这里恒成功，
/// 壳层若要在无窗口时报错，应在自己的 `#[tauri::command]` 里先判窗口存在。
pub fn toggle_devtools(ctx: &CoreCtx) -> CoreResult<()> {
    ctx.platform.window.toggle_devtools();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;

    #[test]
    fn window_minimize_records_the_call() {
        let h = Harness::new();
        window_minimize(h.ctx()).unwrap();
        window_minimize(h.ctx()).unwrap();
        assert_eq!(*h.window.minimized.lock().unwrap(), 2);
    }

    #[test]
    fn window_maximize_toggle_returns_the_new_state() {
        let h = Harness::new();
        assert!(!window_is_maximized(h.ctx()).unwrap());
        assert!(window_maximize_toggle(h.ctx()).unwrap());
        assert!(window_is_maximized(h.ctx()).unwrap());
        assert!(!window_maximize_toggle(h.ctx()).unwrap());
        assert!(!window_is_maximized(h.ctx()).unwrap());
    }

    #[test]
    fn window_close_records_the_call() {
        let h = Harness::new();
        window_close(h.ctx()).unwrap();
        assert_eq!(*h.window.closed.lock().unwrap(), 1);
    }

    #[test]
    fn toggle_devtools_records_the_call() {
        let h = Harness::new();
        toggle_devtools(h.ctx()).unwrap();
        assert_eq!(*h.window.devtools.lock().unwrap(), 1);
    }

    #[test]
    fn window_commands_never_touch_the_settings_file() {
        // 窗口命令属于纯转发，不应产生任何落盘副作用。
        let h = Harness::new();
        window_minimize(h.ctx()).unwrap();
        window_maximize_toggle(h.ctx()).unwrap();
        window_is_maximized(h.ctx()).unwrap();
        toggle_devtools(h.ctx()).unwrap();
        window_close(h.ctx()).unwrap();
        assert!(h.files.snapshot().is_empty());
    }
}
