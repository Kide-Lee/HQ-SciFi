//! 壳层运行时：把 `hqsf_core::ports` 的每个端口服到 Tauri 2 / 系统 API 上。
//!
//! 迁移来源：1.x 主进程里「直接调用 Electron 能力」的那些地方，逐个替换为 host 端口实现：
//!   - `src/main/infra/fs/index.ts`            → [`files`]（std::fs）
//!   - `src/main/infra/session/index.ts`       → [`secrets`]（safeStorage → 系统钥匙串 keyring）
//!   - `src/main/infra/net/*`（undici/fetch）  → [`http`]（reqwest async + 专用 tokio runtime）
//!   - `window.webContents.send('hqsf:*')`      → [`events`]（AppHandle::emit）
//!   - `Date.now()` 等                        → [`clock`]
//!   - `app.getPath('userData'/'documents'/'resourcesPath')` → [`paths`]
//!   - 剪贴板 / dialog / shell.openExternal / BrowserWindow 操作 → [`platform`]
//!
//! 分层约定（`doc/design/Rust实现约定.md`）：本目录只允许依赖 tauri / 系统 crate，
//! 不实现业务；所有业务都在 `hqsf-core`。壳层不导出通用能力给 webview，命令出口一律 `CoreResult`。

pub mod clock;
pub mod events;
pub mod files;
pub mod http;
pub mod paths;
pub mod platform;
pub mod resources;
pub mod secrets;

/// 主线程 id（启动时由 [`mark_main_thread`] 记录）。
///
/// 用途：tauri-plugin-dialog / clipboard 的 **blocking** API 都要求在非主线程调用 ——
/// 它们内部把真正的 UI 投递到 main thread 再在调用线程 `recv()` 等待；如果在 main thread 上调用，
/// UI 永远排不上队 → 永久死锁。Tauri 没有公开「当前是否主线程」的 API，所以自己记一次。
static MAIN_THREAD_ID: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// 在 `setup`（必然运行在主线程）里调用一次。
pub fn mark_main_thread() {
    let _ = MAIN_THREAD_ID.set(std::thread::current().id());
}

/// 当前线程是否主线程。
///
/// 未标记时返回 `true`（保守：宁可退化成非阻塞调用，也不要在未知线程上冒死锁风险）。
pub fn is_main_thread() -> bool {
    match MAIN_THREAD_ID.get() {
        Some(main) => *main == std::thread::current().id(),
        None => true,
    }
}

/// 给「必须在非主线程调用」的 API 留痕（诊断日志用）。
pub fn main_thread_note(what: &str) {
    if is_main_thread() {
        eprintln!("[hqsf] 注意：{what} 在主线程上调用（应为 tokio worker），已按非阻塞路径处理");
    }
}
