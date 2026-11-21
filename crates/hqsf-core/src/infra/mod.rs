//! 能力层：每个子系统一个模块。
//!
//! 迁移计划 §4.2 的 lane 归属：
//! - `db`（L2）—— SQLite（rusqlite，表结构与列名保持与 1.x 一致，避免数据迁移风险）
//! - `fs` + `sandbox`（L2）—— docs 根、目录树、写盘
//! - `net`（L3）—— `api.config.json`、endpoint 白名单、token 注入、错误映射
//! - `session` / `updater`（L4）
//! - `markdown` / `media`（L5）
//! - `settings`（L1）

pub mod db;
pub mod fs;
pub mod markdown;
pub mod media;
pub mod migrate;
pub mod net;
pub mod sandbox;
pub mod session;
pub mod settings;
pub mod updater;
