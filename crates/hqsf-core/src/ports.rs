//! 内核访问系统能力的端口（port）。
//!
//! 内核**不允许**直接调用 `std::fs`、`std::env`、`keyring`、`reqwest` 等系统/第三方能力
//! （见迁移计划 §1.6）；一律经这些 trait。壳层（`src-tauri/src/runtime`）提供真实实现，
//! 测试用 [`crate::testkit`] 的假实现，将来 Android 只需替换实现。
//!
//! 为什么这样切：这条边界让「内核 100% Rust 且可单测」成为可能——沙箱里没有 WebKitGTK
//! 也能跑完所有领域逻辑；同时它也是 Android 复用（SAF / Keystore）的接入点。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreResult};

/// 目录项（列目录用）。`path` 用绝对路径；Android 实现里会是 SAF 的不透明标识。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: u64,
    /// 修改时间（Unix 毫秒）。取不到时为 0。
    pub modified_ms: i64,
}

/// 文件元信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: i64,
}

/// 文件系统端口。桌面实现走 `std::fs`；Android 实现走 SAF。
pub trait FileStore: Send + Sync {
    fn read(&self, path: &Path) -> CoreResult<Vec<u8>>;
    fn write(&self, path: &Path, data: &[u8]) -> CoreResult<()>;
    fn remove_file(&self, path: &Path) -> CoreResult<()>;
    fn remove_dir_all(&self, path: &Path) -> CoreResult<()>;
    fn rename(&self, from: &Path, to: &Path) -> CoreResult<()>;
    fn create_dir_all(&self, path: &Path) -> CoreResult<()>;
    fn list(&self, dir: &Path) -> CoreResult<Vec<DirEntry>>;
    fn exists(&self, path: &Path) -> bool;
    fn metadata(&self, path: &Path) -> CoreResult<FileMeta>;
}

/// 凭据端口（原 Electron `safeStorage`）。桌面端 = 系统钥匙串。
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> CoreResult<Option<String>>;
    fn set(&self, key: &str, value: &str) -> CoreResult<()>;
    fn delete(&self, key: &str) -> CoreResult<()>;
}

/// HTTP 请求（内核侧的抽象，避免把 reqwest 类型泄进领域层）。
#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: u64,
}

/// HTTP 响应。
#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// 网络端口。真实实现用 reqwest（rustls）。
pub trait HttpTransport: Send + Sync {
    fn send(&self, req: HttpRequest) -> CoreResult<HttpResponse>;
}

/// 事件端口：后端 → 渲染层单向推送（原 `webContents.send`）。
pub trait EventSink: Send + Sync {
    /// `event` 用现有通道名，例如 `hqsf:window-maximized-changed`。
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// 消息框级别（原 `dialog.showMessageBox` / `showErrorBox`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    Info,
    Error,
}

/// 剪贴板端口（原 Electron `clipboard`）。只做纯文本/HTML，不碰图片。
pub trait Clipboard: Send + Sync {
    fn read_text(&self) -> CoreResult<String>;
    fn read_html(&self) -> CoreResult<String>;
    fn write_text(&self, text: &str) -> CoreResult<()>;
}

/// 消息框图标类型（原 Electron `MessageBoxOptions['type']`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MessageBoxKind {
    #[default]
    None,
    Info,
    Error,
    Question,
    Warning,
}

/// 原生消息框参数（原 Electron `MessageBoxOptions` 的内核子集）。
#[derive(Debug, Clone, Default)]
pub struct MessageBoxOptions {
    pub kind: MessageBoxKind,
    pub title: String,
    pub message: String,
    pub detail: Option<String>,
    pub buttons: Vec<String>,
    pub cancel_id: Option<i32>,
    pub default_id: Option<i32>,
}

/// 原生对话框端口（原 Electron `dialog`）。
pub trait Dialog: Send + Sync {
    /// 选目录；用户取消返回 `None`。
    fn pick_directory(
        &self,
        title: &str,
        default_path: Option<&Path>,
    ) -> CoreResult<Option<PathBuf>>;
    /// 选一张本地图片（头像/背景上传）；用户取消返回 `None`。
    fn pick_image(&self, title: &str) -> CoreResult<Option<PathBuf>>;
    /// 阻塞式消息框（启动失败诊断、致命错误提示）。
    fn show_message(&self, kind: MessageKind, title: &str, message: &str);

    /// 弹原生消息框并返回被点按钮索引（原 `dialog.showMessageBox`）；
    /// 壳层负责关闭后把焦点还给主窗口。
    fn show_message_box(&self, options: &MessageBoxOptions) -> CoreResult<i32>;
}

/// 外部程序端口（原 `shell.openExternal` / `shell.showItemInFolder`）。
pub trait Launcher: Send + Sync {
    fn open_external(&self, url: &str) -> CoreResult<()>;
    fn reveal_in_folder(&self, path: &Path) -> CoreResult<()>;
    /// 用系统默认程序打开路径（1.x `shell.openPath`，用于「打开文档目录」）。
    fn open_path(&self, path: &Path) -> CoreResult<()>;
    /// 移入系统回收站（1.x `shell.trashItem`，可恢复）。
    ///
    /// 与 `FileStore::remove_file`（永久删除）的区别是用户可见的行为差异：
    /// `hqsf:delete-local-file` 必须走这条，不得退化成永久删除。
    fn trash(&self, path: &Path) -> CoreResult<()>;
}

/// 窗口端口（原 `BrowserWindow` 的那几个方法）。
///
/// 内核的命令函数只依赖这些方法，不感知 tauri / Electron：将来 Android 端把
/// `toggle_maximize` 实现成空操作即可。
pub trait WindowOps: Send + Sync {
    fn minimize(&self);
    /// 切换最大化，返回**切换后**的状态。
    ///
    /// 1.x 的 Electron `isMaximized()` 是同步缓存值，`toggle()` 后立刻再读即可；
    /// 而 GTK/Win32 的最大化是异步落到窗口系统的，紧接着读 `is_maximized()`
    /// 可能仍是旧值。因此把「切换后状态」作为端口返回值：壳层按当前状态取反
    /// 返回（即期望态），并在窗口真正变化时另发 `hqsf:window-maximized-changed`。
    fn toggle_maximize(&self) -> CoreResult<bool>;
    fn close(&self);
    fn is_maximized(&self) -> bool;
    fn toggle_devtools(&self);
    /// 缩放因子（1.0 = 100%）。
    fn set_zoom(&self, factor: f64) -> CoreResult<()>;
    /// 注入自定义 CSS，返回可撤销的 key；空 CSS 返回空串。
    fn insert_css(&self, css: &str) -> CoreResult<String>;
    /// 撤销 [`WindowOps::insert_css`] 注入的样式。
    fn remove_css(&self, key: &str);
    /// 执行自定义 JS（设置里的高级选项）。
    fn execute_js(&self, js: &str) -> CoreResult<()>;
}

/// 平台相关端口的打包。壳层按 target 注入不同实现（桌面 / Android）。
#[derive(Clone)]
pub struct Platform {
    pub clipboard: Arc<dyn Clipboard>,
    pub dialog: Arc<dyn Dialog>,
    pub launcher: Arc<dyn Launcher>,
    pub window: Arc<dyn WindowOps>,
}

impl std::fmt::Debug for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Platform").finish_non_exhaustive()
    }
}

/// 时钟端口（测试可注入固定时间）。
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// 应用路径（壳层注入；内核不去问操作系统）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppPaths {
    /// 应用数据目录（`hqsf.db`、`settings.json` 所在）。
    pub data_dir: PathBuf,
    /// 打包资源目录（`api.config.json`、`agreement.md`、`changelog.md`）。
    pub resource_dir: PathBuf,
    /// 用户文档目录（`app.getPath('documents')` 的等价物）。
    ///
    /// 1.x 的默认草稿根 = `<documents>/荒启科幻/草稿`；内核只在 `infra::fs` 里拼，
    /// 由壳层问操作系统要这个路径（Android 端未来换成 SAF 目录，内核代码不变）。
    pub documents_dir: PathBuf,
    /// 测试模式（1.x `HQSF_TEST=1` / `--test`）：数据目录与草稿根都加 `-test` 后缀。
    ///
    /// 环境变量/命令行由壳层解析后注入，内核不读 `std::env`（便于单测）。
    pub test_mode: bool,
}

impl AppPaths {
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("hqsf.db")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }
}

/// 把「文件不存在」统一成内核错误，避免各调用点重复处理。
pub(crate) fn io_not_found(path: &Path) -> CoreError {
    CoreError::NotFound(path.display().to_string())
}
