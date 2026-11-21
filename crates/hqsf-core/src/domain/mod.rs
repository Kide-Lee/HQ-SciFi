//! 领域层：纯函数业务规则，无 IO。
//!
//! 迁移来源（TS）：
//! - `src/main/domain/`（87 行）——四态、可见性等
//! - `src/main/services/sync-service.ts` 里的合并规则（L7c）
//! - `src/main/adapters/` 里的排序/匿名化/打分配置（L7a/L7b）
//!
//! 规则一律写成「输入结构 → 输出结构」的纯函数，便于表驱动测试与金标准对拍。

pub mod article;
pub mod comment;
pub mod embed;
pub mod review;
pub mod sync;
pub mod user;
