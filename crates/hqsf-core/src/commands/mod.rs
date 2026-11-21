//! 命令层：一个 IPC 通道一个 `pub fn`，签名与 `src/shared/contracts/hqsf-api.ts` 一一对应。
//!
//! 壳层（`src-tauri/src/commands/`）的 `#[tauri::command]` 只做三件事：
//! 反序列化入参 → 调这里的函数 → 包 `Result<T, CoreError>`。
//! 因此**逻辑全部可在此单测**，壳里不允许出现 if/else 业务分支。
//!
//! 通道清单见 `doc/design/Tauri命令契约.md`（84 条 invoke + 2 个事件）。

pub mod agreement;
pub mod auth;
pub mod browse;
pub mod chat;
pub mod comment;
pub mod docs;
pub mod interact;
pub mod media;
pub mod notify;
pub mod read;
pub mod registry;
pub mod review;
pub mod search;
pub mod settings;
pub mod sync;
pub mod system;
pub mod updater;
pub mod user;
pub mod window;
