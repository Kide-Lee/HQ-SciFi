//! `Clock` 的系统时钟实现。
//!
//! 迁移来源：1.x 各处 `Date.now()`（例如 `src/main/infra/session/index.ts` 的 `savedAt`、
//! `src/main/window/index.ts` 的窗口状态、同步冲突判断的 updatedAt 比较）。
//!
//! 与 Electron 的差异：无（都是 Unix 毫秒）。唯一差别是 `SystemTime` 早于 1970 时报错，
//! 这里退化为 0，避免启动路径 panic。

use std::time::{SystemTime, UNIX_EPOCH};

use hqsf_core::ports::Clock;

/// 系统时钟。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl SystemClock {
    pub fn new() -> Self {
        Self
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
            // 系统时间被改到 1970 之前：返回 0（1.x Date.now() 会给负数，但没有任何业务依赖它）。
            Err(_) => 0,
        }
    }
}
