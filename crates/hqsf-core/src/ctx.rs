//! 内核上下文：把所有端口与路径打包，命令函数只依赖它。
//!
//! 壳层只构造一次 `CoreCtx`，之后每个 `#[tauri::command]` 都是
//! `state.core.handler_xxx(args)` 一行。

use std::sync::Arc;

use crate::infra::db::Db;
use crate::ports::{AppPaths, Clock, EventSink, FileStore, HttpTransport, Platform, SecretStore};

/// 内核运行时上下文（不可变，线程安全）。
#[derive(Clone)]
pub struct CoreCtx {
    pub files: Arc<dyn FileStore>,
    pub secrets: Arc<dyn SecretStore>,
    pub http: Arc<dyn HttpTransport>,
    pub events: Arc<dyn EventSink>,
    pub clock: Arc<dyn Clock>,
    pub paths: AppPaths,
    /// 本地索引库（`hqsf.db`，L2 文档索引 / 阅读缓存 / meta 都在这）。
    pub db: Arc<Db>,
    /// 平台能力（剪贴板/对话框/外部程序/窗口）。内核只调 trait，不感知 tauri。
    pub platform: Platform,
}

impl std::fmt::Debug for CoreCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreCtx")
            .field("data_dir", &self.paths.data_dir)
            .field("resource_dir", &self.paths.resource_dir)
            .finish_non_exhaustive()
    }
}

impl CoreCtx {
    // 8 个端口是内核的固定装配面；拆成 builder 只会让每个测试与壳层更啰嗦。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        files: Arc<dyn FileStore>,
        secrets: Arc<dyn SecretStore>,
        http: Arc<dyn HttpTransport>,
        events: Arc<dyn EventSink>,
        clock: Arc<dyn Clock>,
        paths: AppPaths,
        db: Arc<Db>,
        platform: Platform,
    ) -> Self {
        Self {
            files,
            secrets,
            http,
            events,
            clock,
            paths,
            db,
            platform,
        }
    }
}
