//! # hqsf-core
//!
//! 荒启桌面客户端的内核。**纯 Rust，零 tauri / 零桌面 API 依赖**——这样：
//!
//! 1. 全部领域逻辑可以用 `cargo test` 在无 WebKitGTK 的环境里验证（本机沙箱、轻量 CI）；
//! 2. 同一份内核将来可以直接交叉编译到 Android（见迁移计划 §9）；
//! 3. `src-tauri` 只剩接线，几百行，评审成本低。
//!
//! 内核通过 [`ports`] 里的 trait 访问系统能力（文件、钥匙串、HTTP、事件、时钟），
//! 由 `src-tauri/src/runtime` 注入真实实现；测试里用 [`testkit`] 的假实现。
//!
//! 分层（对应迁移计划 §1.2）：
//! - [`domain`]   纯业务规则（四态、评审、排序…），无 IO
//! - [`adapters`] API 响应规整（原 `src/main/adapters/`，1,910 行 TS）
//! - [`services`] 编排（auth/docs/sync/settings/updater）
//! - [`infra`]    能力层（db/fs/net/session/settings/media/markdown/updater）
//! - [`commands`] 每个 IPC 通道一个入口函数，签名与 TS 侧一一对应，供壳包装

pub mod adapters;
pub mod commands;
pub mod ctx;
pub mod domain;
pub mod error;
pub mod infra;
pub mod ports;
pub mod services;
pub mod testkit;

pub use ctx::CoreCtx;
pub use error::{CoreError, CoreResult};
