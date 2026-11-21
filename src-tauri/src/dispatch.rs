//! 命令分发层（**占位**）：85 个 `#[tauri::command]` 由下一张卡生成。
//!
//! 迁移来源：
//!   - `src/main/ipc/index.ts` / `src/main/ipc.ts`（85 个 `ipcMain.handle('hqsf:*')` 白名单）
//!   - `src/preload/index.ts`（`window.hqsf` 暴露 85 个 invoke + 2 个事件订阅）
//!   - `src/shared/contracts/commands.ts`（通道名/入参/返回的单一来源）
//!   冻结契约：`crates/hqsf-core/src/commands/registry.rs`（`COMMANDS` / `EVENTS` /
//!   `EXPECTED_INVOKE_TOTAL = 85`）与 `src-tauri/testdata/contracts/commands.json`。
//!
//! 与 Electron 的差异：
//!   1. Electron 的 `ipcMain.handle` 直接返回 `{ok,data}|{ok,error}`；Tauri 的 command 返回值
//!      序列化后就是 JS Promise 的 resolve 值，**失败走 reject**。所以这里约定：
//!        - 成功：T 原样序列化（下一张卡的 preload 等价层负责包成 `{ok:true,data}`）；
//!        - 失败：[`HqsfError`] 序列化成 `{ok:false,error:"<中文消息>"}`（与 1.x 的错误信封同形），
//!          这样渲染层包装层两侧都能用同一个结构判断。
//!      `hqsf-core` 的 `CoreError` 没有（也不该）实现 `serde::Serialize`，故壳层用 newtype 适配。
//!   2. 通道名与命令名的映射是**扁平**的：Tauri command 名就是 core 函数名（`add_comment`），
//!      不存在 `hqsf:add-comment` 这种带冒号的通道 —— preload 等价层负责把 1.x 通道名映射到
//!      Tauri 命令名（映射表由 `commands.json` 的 `channel`↔`rustCommand` 字段生成）。
//!   3. 事件名保持原样（`hqsf:window-maximized-changed`、`hqsf:update-state`），见 `lib.rs` 与
//!      `runtime/events.rs`；Tauri 不限制事件名里的冒号。
//!
//! 本文件当前只放两样东西：
//!   - [`invoke_placeholder`]：未接入通道的统一错误（给 preload 等价层兜底，不注册为命令）；
//!   - [`__hqsf_toggle_devtools`]：内部命令，给注入的 Ctrl+F12 监听用（不是 85 条对外通道之一）。
//!
//! ## 下一张卡：生成 85 个命令所需信息（已就位）
//!   - 契约：`src-tauri/testdata/contracts/commands.json`（每条含 `channel` / `method` / `params` /
//!     `returns` / `errors` / `handler` / `rustCommand` / `rustModule` / `lane` / `kind`）；
//!   - 内核注册表：`crates/hqsf-core/src/commands/registry.rs` 的 `COMMANDS`（与契约同源、有测试）；
//!   - 内核函数：`crates/hqsf-core/src/commands/<module>.rs` 的 `pub fn`（`ctx: &CoreCtx` 第一个参数，
//!     其余参数与 `params` 顺序一致）；
//!   - 生成器脚本：`src-tauri/scripts/gen-tauri-commands.mjs`（读契约 + 扫 core 签名 → 输出本文件）。
//!
//! 生成后的命令形态（示例，决定 next card 的写法）：
//! ```ignore
//! #[tauri::command]
//! pub async fn add_comment(
//!     state: State<'_, AppState>,
//!     payload: CommentPayload,
//! ) -> HqsfResult<CommentSubmitResult> {
//!     hqsf_core::commands::comment::add_comment(&state.core, payload).map_err(HqsfError::from)
//! }
//! ```
//!
//! ## 为什么统一写成 `async fn`（**不要**改成同步）
//! Tauri 对两种命令的派发方式不同：
//!   - 同步命令：在 IPC 回调线程上**就地**执行。桌面端的 IPC 走自定义 URI scheme
//!     （`ipc://localhost/...`），Linux/GTK 与 macOS/WKWebView 的 scheme 回调跑在**主线程**上 ——
//!     于是任何阻塞调用都会冻结 UI（阻塞式 dialog 甚至直接死锁：对话框自己要主线程才能弹出）。
//!   - `async fn`：由 `async_runtime::spawn` 派发到 tokio worker 线程，不占主线程。
//! 内核的 `HttpTransport` / `Dialog` 端口是同步 trait（`runtime/http.rs` 用
//! `spawn + mpsc::recv`、`runtime/platform.rs` 用 `blocking_show*`），所以这 85 条命令
//! **必须**是 async，否则「首屏一次网络请求就卡住整个窗口」。
//! 例外：本文件里的 `__hqsf_toggle_devtools` 只做一次窗口状态切换，保持同步（不阻塞）。
//!   **禁止**出现「通用转发命令」（通道名 + serde_json::Value 直接路由到内核）：
//!   那等于把 85 条白名单塌缩成一条动态入口，违反迁移计划 §6.4 的安全不变式。
//!   每条命令必须独立注册、独立入参类型。

// 生成物（下一张卡）：`commands_generated.rs` 里是 85 个 `#[tauri::command]`。
// 生成器：`node src-tauri/scripts/gen-tauri-commands.mjs --write`。
// 生成后在这里取消注释、并在 `lib.rs` 的 `generate_handler!` 里追加它们：
// mod commands_generated;

use hqsf_core::error::CoreError;
use serde::{Serialize, Serializer};
use tauri::State;

use crate::AppState;

/// 命令出口错误：把内核的 [`CoreError`] 适配成「可被 Tauri 序列化」的错误类型。
///
/// 序列化结果与 1.x IPC 的错误信封一致：`{ "ok": false, "error": "<中文消息>" }`。
/// 命令函数内部仍然只认 `CoreResult<T>`；这里的 newtype 只出现在 `#[tauri::command]` 边界上。
#[derive(Debug)]
pub struct HqsfError(pub CoreError);

impl From<CoreError> for HqsfError {
    fn from(error: CoreError) -> Self {
        Self(error)
    }
}

impl std::fmt::Display for HqsfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HqsfError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

impl Serialize for HqsfError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // CoreError::to_envelope() 已实现 Serialize（ErrorEnvelope{ok:false,error:String}）。
        self.0.to_envelope().serialize(serializer)
    }
}

/// 壳层命令的统一返回类型（`Result<T, CoreError>` + 序列化适配）。
pub type HqsfResult<T> = Result<T, HqsfError>;

/// 未接入通道的兜底错误。
///
/// 不是 `#[tauri::command]`：用作 preload 等价层的默认分支与生成器的占位实现，
/// 避免「通道拼错」被静默吞掉。
pub fn invoke_placeholder(channel: &str) -> HqsfResult<serde_json::Value> {
    Err(HqsfError(CoreError::app(format!(
        "命令尚未接入壳层：{channel}（等待 dispatch 生成卡按 commands.json 生成 85 个命令）"
    ))))
}

/// 内部命令：切换 devtools（由 `lib.rs` 注入的 Ctrl+F12 监听调用）。
///
/// 1.x：`src/main/window/index.ts:55-67` 的 `before-input-event`。
/// 通道名不是 85 条对外白名单之一，故用双下划线前缀区分；渲染层不直接暴露给业务代码。
#[tauri::command]
pub fn __hqsf_toggle_devtools(state: State<'_, AppState>) -> HqsfResult<()> {
    state.core.platform.window.toggle_devtools();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_to_envelope() {
        let error = HqsfError(CoreError::app("测试错误"));
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["error"], serde_json::json!("测试错误"));
        // 结构上必须与内核的 ErrorEnvelope 完全一致（渲染层只认这一种形状）。
        let envelope = CoreError::app("测试错误").to_envelope();
        let expected = serde_json::to_value(&envelope).expect("serialize envelope");
        assert_eq!(json, expected);
    }

    #[test]
    fn placeholder_reports_channel_name() {
        let error = invoke_placeholder("hqsf:unknown").expect_err("必须报错");
        assert!(error.to_string().contains("hqsf:unknown"));
    }
}
