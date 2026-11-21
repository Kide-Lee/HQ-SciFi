//! 适配层：把远端 API 的原始 JSON 规整成渲染层使用的结构。
//!
//! 迁移来源：`src/main/adapters/`（11 个文件、1,910 行 TS）。原样平移语义，不"顺手改进"。
//! 每个适配器模块：
//! 1. 定义 `#[derive(Deserialize)]` 的原始响应形状（容忍多别名，`#[serde(alias = ...)]`）；
//! 2. 定义 `#[derive(Serialize, specta::Type)]` 的输出形状（给渲染层）；
//! 3. 提供 `pub fn adapt(raw: &Raw) -> Out` 纯函数，并配 `testdata/parity/*.jsonl` 对拍。
pub mod agreement;
pub mod browse;
pub mod chat;
pub mod comment;
pub mod docs;
pub mod interact;
pub mod media;
pub mod notify;
pub mod read;
pub mod review;
pub mod search;
pub mod sync;
pub mod user;
