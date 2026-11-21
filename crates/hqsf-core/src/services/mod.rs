//! 服务层：编排（多步、跨子系统），对应 TS 的 `src/main/services/`（896 行）。
//!
//! - `auth`（L7c）——登录、会话校验、身份提取（`extractIdentity`/`normalizeUserinfo`）
//! - `docs`（L2）——本地文件树与索引同步
//! - `sync`（L7c）——pull/push、四态转换、本地↔远端合并
//! - `settings`（L1）——设置读写与默认值
//! - `updater`（L4）——GitHub releases 检查
pub mod auth;
pub mod docs;
pub mod net;
pub mod settings;
pub mod sync;
pub mod updater;
