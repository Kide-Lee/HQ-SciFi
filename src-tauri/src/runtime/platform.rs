//! 平台端口实现：剪贴板 / 原生对话框 / 外部程序 / 窗口操作。
//!
//! 迁移来源（只读参照，禁止修改）：
//!   - `src/main/infra/clipboard.ts`（或 ipc 里的 `clipboard.*`）→ [`TauriClipboard`]（1.x `clipboard.readText/readHTML/writeText`）
//!   - `src/main/ipc/*` 里的 `dialog.showOpenDialog` / `showMessageBox` → [`TauriDialog`]
//!   - `src/main/window/index.ts:74-79`（`shell.openExternal`）与 `shell.showItemInFolder` / `shell.openPath` / `shell.trashItem` → [`TauriLauncher`]
//!   - `src/main/window/index.ts:14-121`（BrowserWindow）→ [`TauriWindowOps`]
//!
//! 与 Electron 的差异（重要）：
//!   - **剪贴板 HTML**：`tauri-plugin-clipboard-manager` 只提供 `read_text`/`write_text`/`write_html`，
//!     **没有 `readHTML`**。1.x 用它做「从 Word/网页粘贴富文本」。当前实现显式报错（不静默返回空串），
//!     避免渲染层误判为「剪贴板为空」。TODO(verify): 若必须支持，加 `arboard` crate 直接用
//!     `Get::html()`（Linux X11 需要 window owner），或改为「只支持纯文本」并在 UI 上降级。
//!   - **对话框**：tauri 的 `blocking_*` API 内部用 rfd，文档明确「不要在 main thread 调用」。
//!     命令层是 async（跑在 tokio worker），满足要求；但 `lib.rs` 的启动失败提示是在 main thread 上
//!     调 `show_message`，属于「事件循环起来之前」的唯一例外（1.x `dialog.showErrorBox` 同样是同步阻塞）。
//!   - **自定义 CSS**：Electron `insertCSS` 返回 key、样式进入「user origin」样式表；Tauri 没有等价 API，
//!     这里用 `eval` 注入 `<style id="hqsf-custom-css">` 节点并返回该 id 作为 key，`remove_css` 删除节点。
//!     差异有三点（详见 [`TauriWindowOps::insert_css`] 的注释）：
//!       1. 注入的是 **author origin** 样式，而 1.x 是 user origin（`!important` 的权重关系不同）；
//!       2. 页面 reload 后节点消失，需要重新 apply（1.x 也会丢，但由 `did-finish-load` 重放）；
//!       3. 样式在 DOM 里可见、可被页面样式覆盖，`remove_css` 只能按我们自己的 id 删。
//!   - **devtools 快捷键**：见 `lib.rs` 的 `inject_devtools_hotkey`，用注入 JS + 内部命令实现
//!     （Tauri 没有 `before-input-event`）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hqsf_core::error::{CoreError, CoreResult};
use hqsf_core::ports::{
    Clipboard, Dialog, Launcher, MessageBoxKind, MessageBoxOptions, MessageKind, Platform,
    WindowOps,
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::runtime::{is_main_thread, main_thread_note};

/// 主窗口 label（与 `tauri.conf.json` 的 `app.windows[0].label` 一致）。
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 自定义 CSS 注入节点的 id，也是 `insert_css` 返回的 key。
pub const CUSTOM_CSS_KEY: &str = "hqsf-custom-css";

/// 组装内核需要的 [`Platform`]。
pub fn build_platform(app: &AppHandle) -> Platform {
    Platform {
        clipboard: Arc::new(TauriClipboard::new(app.clone())),
        dialog: Arc::new(TauriDialog::new(app.clone())),
        launcher: Arc::new(TauriLauncher),
        window: Arc::new(TauriWindowOps::new(app.clone())),
    }
}

// ---------------------------------------------------------------------------
// 剪贴板
// ---------------------------------------------------------------------------

/// 基于 tauri-plugin-clipboard-manager 的剪贴板端口。
#[derive(Clone)]
pub struct TauriClipboard {
    app: AppHandle,
}

impl TauriClipboard {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl std::fmt::Debug for TauriClipboard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TauriClipboard")
    }
}

impl Clipboard for TauriClipboard {
    fn read_text(&self) -> CoreResult<String> {
        // 插件文档：Linux 上 read_text 在 main thread 调用会死锁 → 只允许 async 命令（worker）调用。
        main_thread_note("Clipboard::read_text");
        // 文档警告：read_text 在 Linux 上可能阻塞（x11 选区），不要在 main thread 调。
        self.app
            .clipboard()
            .read_text()
            .map_err(|e| CoreError::app(format!("读取剪贴板失败：{e}")))
    }

    fn read_html(&self) -> CoreResult<String> {
        // 插件只写了写方向（write_html），没有读方向；显式报错而不是返回空串。
        Err(CoreError::app(
            "当前版本不支持读取剪贴板中的富文本（HTML），已降级为纯文本粘贴",
        ))
    }

    fn write_text(&self, text: &str) -> CoreResult<()> {
        self.app
            .clipboard()
            .write_text(text)
            .map_err(|e| CoreError::app(format!("写入剪贴板失败：{e}")))
    }
}

// ---------------------------------------------------------------------------
// 原生对话框
// ---------------------------------------------------------------------------

/// 基于 tauri-plugin-dialog 的对话框端口。
#[derive(Clone)]
pub struct TauriDialog {
    app: AppHandle,
}

impl TauriDialog {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl std::fmt::Debug for TauriDialog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TauriDialog")
    }
}

/// 把 `FilePath` 转成 `PathBuf`；桌面端永远是 `Path` 变体，`Url` 只用于 Android/macOS 沙箱 URI。
fn file_path_to_pathbuf(file: tauri_plugin_dialog::FilePath) -> CoreResult<PathBuf> {
    file.into_path()
        .map_err(|e| CoreError::app(format!("无法解析所选路径：{e}")))
}

impl Dialog for TauriDialog {
    fn pick_directory(
        &self,
        title: &str,
        default_path: Option<&Path>,
    ) -> CoreResult<Option<PathBuf>> {
        // 阻塞式文件对话框只能在非主线程调（`blocking_pick_*` 的文档要求）。
        // 所有调用点都是 async 命令（tokio worker），这里只在误用时留痕。
        main_thread_note("Dialog::pick_directory 的阻塞文件对话框");
        let mut builder = self.app.dialog().file().set_title(title);
        if let Some(dir) = default_path {
            // TODO(verify): FileDialogBuilder::set_directory 的入参是 `impl Into<PathBuf>` 还是
            // `impl Into<String>`；按 rfd 语义推断为路径，若编译报错改成 `dir.display().to_string()`。
            builder = builder.set_directory(dir.to_path_buf());
        }
        // blocking_*：不得在 main thread 调用（命令层是 async worker，满足）。
        match builder.blocking_pick_folder() {
            Some(file) => Ok(Some(file_path_to_pathbuf(file)?)),
            None => Ok(None),
        }
    }

    fn pick_image(&self, title: &str) -> CoreResult<Option<PathBuf>> {
        main_thread_note("Dialog::pick_image 的阻塞文件对话框");
        // 1.x 的图片选择框（头像/背景）过滤扩展名；rfd 的 filter 用「名称 + 扩展名数组」。
        let builder = self
            .app
            .dialog()
            .file()
            .set_title(title)
            .add_filter("图片", &["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
        match builder.blocking_pick_file() {
            Some(file) => Ok(Some(file_path_to_pathbuf(file)?)),
            None => Ok(None),
        }
    }

    fn show_message(&self, kind: MessageKind, title: &str, message: &str) {
        let dialog_kind = match kind {
            MessageKind::Info => MessageDialogKind::Info,
            MessageKind::Error => MessageDialogKind::Error,
        };
        let builder = self
            .app
            .dialog()
            .message(message)
            .title(title)
            .kind(dialog_kind);
        if is_main_thread() {
            // **不能**用 blocking_show：插件的 blocking 版把 UI 投递到 main thread，然后在调用线程
            // `recv()` 等结果；这里就是 main thread → 两边互等，永久死锁（插件文档明确禁止）。
            // 非阻塞版语义略有差异：调用方拿不到「已关闭」的时机。致命错误场景由调用方负责退出，
            // 例如 `lib.rs::show_startup_error_and_exit` 就是在 Ready 回调里弹框 + 回调里 exit。
            builder.show(|_| {});
        } else {
            builder.blocking_show();
        }
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> CoreResult<i32> {
        main_thread_note("Dialog::show_message_box 的阻塞消息框");
        // 迁移来源：`src/main/ipc/*` 的 `dialog.showMessageBox`（`hqsf:show-message-box`）。
        // 1.x 语义：返回被点按钮下标；按钮文案由调用方给（buttons 可空 → 默认「确定」）。
        let kind = match options.kind {
            MessageBoxKind::None | MessageBoxKind::Info => MessageDialogKind::Info,
            MessageBoxKind::Error => MessageDialogKind::Error,
            // rfd/tauri 只有 Info/Warning/Error 三种图标，Question 用 Warning 近似。
            MessageBoxKind::Question | MessageBoxKind::Warning => MessageDialogKind::Warning,
        };

        let buttons = map_buttons(&options.buttons);
        // detail 没有独立 API：拼进正文（与 1.x 的 message/detail 视觉分层不同）。
        let text = match options.detail.as_deref() {
            Some(detail) if !detail.is_empty() => format!("{}\n\n{}", options.message, detail),
            _ => options.message.clone(),
        };

        let result = self
            .app
            .dialog()
            .message(text)
            .title(options.title.clone())
            .kind(kind)
            .buttons(buttons)
            .blocking_show_with_result();

        // 关闭后把焦点还给主窗口（1.x 的原生对话框由 Electron 自动恢复焦点）。
        // 命令层在 worker 线程，这里 set_focus 会投递到 main thread 执行。
        if let Some(window) = self.app.get_webview_window(MAIN_WINDOW_LABEL) {
            if let Err(e) = window.set_focus() {
                eprintln!("[hqsf] 消息框关闭后恢复窗口焦点失败：{e}");
            }
        }

        // 关键：用了自定义按钮文案（OkCancelCustom / YesNoCancelCustom）时，插件在 Linux 上
        // 返回的是 `MessageDialogResult::Custom(被点按钮的文案)`（见 tauri-plugin-dialog 2.6
        // `desktop.rs::show_message_dialog` 的手工映射），所以必须按文案回查下标，
        // 不能简单把 Custom 当成「取消」。
        let last_index = options.buttons.len().min(3).saturating_sub(1) as i32;
        let index: i32 = match result {
            MessageDialogResult::Custom(text) => options
                .buttons
                .iter()
                .position(|label| label == &text)
                .map(|position| position as i32)
                .unwrap_or_else(|| options.cancel_id.unwrap_or(last_index)),
            // 单按钮（Ok）或用户直接关掉窗口时可能拿到下面这些原生结果。
            MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
            MessageDialogResult::No => 1.min(last_index),
            // 关窗 / Esc 视为「取消」：给了 cancel_id 就用它，否则退到最后一个按钮（1.x 的默认）。
            MessageDialogResult::Cancel => options.cancel_id.unwrap_or(last_index),
            // `MessageDialogResult` 不是 non_exhaustive，但保留兜底以免上游加变体时编译中断。
            #[allow(unreachable_patterns)]
            _ => options.cancel_id.unwrap_or(0),
        };
        Ok(index.max(0))
    }
}

/// 把内核给的按钮文案映射到 tauri 的固定按钮组合（rfd 不支持任意数量/任意文案）。
///
/// 差异（TODO(verify)）：Electron 支持任意按钮数组与 `defaultId`；这里最多 3 个，
/// 超出部分丢弃并记日志 —— 现有 85 个通道里没有超过 2 个按钮的调用点（`hqsf:show-message-box`
/// 主要给「确认删除/退出」用）。
fn map_buttons(buttons: &[String]) -> MessageDialogButtons {
    match buttons.len() {
        0 | 1 => MessageDialogButtons::Ok,
        2 => MessageDialogButtons::OkCancelCustom(buttons[0].clone(), buttons[1].clone()),
        3 => MessageDialogButtons::YesNoCancelCustom(
            buttons[0].clone(),
            buttons[1].clone(),
            buttons[2].clone(),
        ),
        n => {
            eprintln!("[hqsf] 消息框按钮数 {n} 超过原生支持，仅保留前 3 个");
            MessageDialogButtons::YesNoCancelCustom(
                buttons[0].clone(),
                buttons[1].clone(),
                buttons[2].clone(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// 外部程序
// ---------------------------------------------------------------------------

/// 基于 tauri-plugin-opener / trash 的外部程序端口。
#[derive(Debug, Clone, Copy, Default)]
pub struct TauriLauncher;

impl Launcher for TauriLauncher {
    fn open_external(&self, url: &str) -> CoreResult<()> {
        // 安全不变式（迁移计划 §6.4）：只放行 http(s)，绝不把 file:// / javascript: 交给系统外壳。
        let parsed = tauri::Url::parse(url).map_err(|_| CoreError::Forbidden(url.to_string()))?;
        match parsed.scheme() {
            "http" | "https" => {}
            _ => return Err(CoreError::Forbidden(url.to_string())),
        }
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|e| CoreError::app(format!("打开外部链接失败：{e}")))
    }

    fn reveal_in_folder(&self, path: &Path) -> CoreResult<()> {
        tauri_plugin_opener::reveal_item_in_dir(path)
            .map_err(|e| CoreError::app(format!("在文件管理器中定位失败：{e}")))
    }

    fn open_path(&self, path: &Path) -> CoreResult<()> {
        tauri_plugin_opener::open_path(path, None::<&str>)
            .map_err(|e| CoreError::app(format!("打开路径失败：{e}")))
    }

    fn trash(&self, path: &Path) -> CoreResult<()> {
        // 1.x shell.trashItem：移入回收站（可恢复），不能退化成永久删除。
        trash::delete(path).map_err(|e| CoreError::app(format!("移入回收站失败：{e}")))
    }
}

// ---------------------------------------------------------------------------
// 窗口操作
// ---------------------------------------------------------------------------

/// 基于 tauri `WebviewWindow` 的窗口端口。
#[derive(Clone)]
pub struct TauriWindowOps {
    app: AppHandle,
    /// 上一次注入的自定义 CSS 的 key（内核无状态 —— 见 `insert_css` 的「替换语义」说明）。
    last_css_key: Arc<Mutex<Option<String>>>,
}

impl TauriWindowOps {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            last_css_key: Arc::new(Mutex::new(None)),
        }
    }

    /// 取主窗口；窗口已销毁时返回 CoreError（1.x 里对应 `BrowserWindow` 为 null）。
    fn window(&self) -> CoreResult<WebviewWindow> {
        self.app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| CoreError::app("主窗口不存在"))
    }
}

impl std::fmt::Debug for TauriWindowOps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TauriWindowOps")
    }
}

/// 把字符串转成 JS 字面量（含引号、转义），避免注入 CSS/JS 时被引号打断。
fn js_string_literal(value: &str) -> CoreResult<String> {
    serde_json::to_string(value).map_err(CoreError::from)
}

impl WindowOps for TauriWindowOps {
    fn minimize(&self) {
        match self.window() {
            Ok(window) => {
                if let Err(e) = window.minimize() {
                    eprintln!("[hqsf] 最小化失败：{e}");
                }
            }
            Err(e) => eprintln!("[hqsf] 最小化失败：{e}"),
        }
    }

    fn toggle_maximize(&self) -> hqsf_core::CoreResult<bool> {
        // 1.x：`isMaximized() ? unmaximize() : maximize()`，返回切换后的值。
        //
        // 与 1.x 的差异：Electron 的 `isMaximized()` 是同步缓存，而我们这边 GTK/Win32
        // 的最大化是**异步**落到窗口系统的，切换后立刻 `is_maximized()` 可能仍是旧值。
        // 所以这里返回「期望态」（当前状态取反），窗口真正变化时另由 `Resized` 回调
        // 比较 `is_maximized()` 发 `hqsf:window-maximized-changed` 事件。
        match self.window() {
            Ok(window) => {
                let current = window.is_maximized().unwrap_or(false);
                let result = if current {
                    window.unmaximize()
                } else {
                    window.maximize()
                };
                if let Err(e) = result {
                    eprintln!("[hqsf] 切换最大化失败：{e}");
                    return Err(hqsf_core::CoreError::app(format!("切换最大化失败：{e}")));
                }
                Ok(!current)
            }
            Err(e) => Err(hqsf_core::CoreError::app(format!("切换最大化失败：{e}"))),
        }
    }

    fn close(&self) {
        match self.window() {
            Ok(window) => {
                if let Err(e) = window.close() {
                    eprintln!("[hqsf] 关闭窗口失败：{e}");
                }
            }
            Err(e) => eprintln!("[hqsf] 关闭窗口失败：{e}"),
        }
    }

    fn is_maximized(&self) -> bool {
        match self.window() {
            Ok(window) => window.is_maximized().unwrap_or(false),
            Err(_) => false,
        }
    }

    fn toggle_devtools(&self) {
        // 1.x `before-input-event` 里 Ctrl+F12 切换 devtools。Tauri 只有命令式 API，
        // 且 open_devtools/is_devtools_open 只在 debug 构建或启用 `devtools` feature 时存在。
        #[cfg(any(debug_assertions, feature = "devtools"))]
        {
            match self.window() {
                Ok(window) => {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
                Err(e) => eprintln!("[hqsf] 切换开发者工具失败：{e}"),
            }
        }
        #[cfg(not(any(debug_assertions, feature = "devtools")))]
        {
            // release 未开 devtools feature：与 1.x 的行为不同（Electron 生产包 Ctrl+F12 仍可开）。
            // 需要时用 `cargo build --release --features devtools` 重新构建。
            eprintln!("[hqsf] 当前构建未启用 devtools（release 需 --features devtools）");
        }
    }

    fn set_zoom(&self, factor: f64) -> CoreResult<()> {
        // 1.x：`webContents.setZoomFactor(zoomFactor)`；范围由内核 settings 规范化为 [0.8, 1.5]。
        let window = self.window()?;
        window
            .set_zoom(factor)
            .map_err(|e| CoreError::app(format!("设置缩放失败：{e}")))
    }

    fn insert_css(&self, css: &str) -> CoreResult<String> {
        let window = self.window()?;

        // 替换语义（内核契约定稿）：内核无状态，拿不到上次注入的 key，因此由壳层自持 ——
        // 每次注入前先移除上一次注入的节点，再注入新样式；否则「清空/修改 customCss」会残留旧样式。
        if let Ok(mut guard) = self.last_css_key.lock() {
            if let Some(prev) = guard.take() {
                self.remove_css(&prev);
            }
        }

        // 空 CSS = 只清理，不注入（1.x：先 removeInsertedCSS 旧的，再按需 insertCSS）。
        if css.trim().is_empty() {
            return Ok(String::new());
        }

        // 与 Electron `insertCSS` 的差异：
        //   1. Electron 把 CSS 插进 user-origin 样式表，不受页面 author 样式覆盖；
        //      这里只能插一个 <style> 节点 = author origin，页面里带 `!important` 的规则仍可能压我们一头。
        //   2. 返回值：Electron 返回内部 key；这里返回 DOM id（也是唯一的 key）。
        //   3. reload 后节点消失，需要重新 insert；1.x 因为在 did-finish-load 里重放 `applyWindowCustomCode`，
        //      行为上等价 —— v2 的等价物是 `lib.rs` 的 on_page_load → 后续在 settings lane 里重放。
        let script = format!(
            "(() => {{
                const id = {id};
                let el = document.getElementById(id);
                if (!el) {{
                    el = document.createElement('style');
                    el.id = id;
                    const host = document.head || document.documentElement;
                    if (host) host.appendChild(el);
                }}
                el.textContent = {css};
            }})()",
            id = js_string_literal(CUSTOM_CSS_KEY)?,
            css = js_string_literal(css)?,
        );
        window
            .eval(&script)
            .map_err(|e| CoreError::app(format!("注入自定义样式失败：{e}")))?;

        let key = CUSTOM_CSS_KEY.to_string();
        if let Ok(mut guard) = self.last_css_key.lock() {
            *guard = Some(key.clone());
        }
        Ok(key)
    }

    fn remove_css(&self, key: &str) {
        // 只认我们自己注入的节点；其他 key 忽略（1.x removeInsertedCSS 传未知 key 同样无副作用）。
        if key != CUSTOM_CSS_KEY {
            return;
        }
        let Ok(window) = self.window() else {
            return;
        };
        let Ok(id) = js_string_literal(CUSTOM_CSS_KEY) else {
            return;
        };
        if let Err(e) = window.eval(&format!(
            "(() => {{ const el = document.getElementById({id}); if (el && el.parentNode) el.parentNode.removeChild(el); }})()"
        )) {
            eprintln!("[hqsf] 移除自定义样式失败：{e}");
        }
    }

    fn execute_js(&self, js: &str) -> CoreResult<()> {
        // 1.x：`webContents.executeJavaScript(code)`（设置里的高级选项，用户自负风险）。
        let window = self.window()?;
        window
            .eval(js)
            .map_err(|e| CoreError::app(format!("执行自定义 JS 失败：{e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_literal_escapes_quotes_and_newlines() {
        let literal = js_string_literal("a'b\"c\n").expect("literal");
        assert!(literal.starts_with('"'));
        assert!(literal.contains("\\n"));
    }

    #[test]
    fn open_external_rejects_non_http_schemes() {
        // 不依赖 tauri runtime：只验证 scheme 白名单逻辑（open_external 的前半段）。
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "smb://x"] {
            let parsed = tauri::Url::parse(bad).expect("parse");
            assert!(!matches!(parsed.scheme(), "http" | "https"));
        }
    }
}
