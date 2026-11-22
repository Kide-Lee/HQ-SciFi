//! 壳层启动编排：单实例 → 建 `CoreCtx` → 建窗口 → 自定义协议 → 导航/新窗口策略。
//!
//! 迁移来源（只读参照，禁止修改）：
//!   - `src/main/index.ts:9-11`（测试模式 userData）、`:27-32`（`requestSingleInstanceLock` 失败退出）
//!   - `src/main/bootstrap/index.ts:40-85`（loadApiConfig → initDb → registerImageProtocol →
//!     registerIpcHandlers → createWindow → 定时任务；每步失败 `dialog.showErrorBox` + `app.exit(1)`；
//!     `window-all-closed` 非 darwin 退出、mac `activate` 重建窗口）
//!   - `src/main/window/index.ts:14-79`（窗口参数 / ready-to-show / Ctrl+F12 / maximize 事件 /
//!     `setWindowOpenHandler`）
//!   - `src/main/infra/media/imgcache.ts:281-300`（`protocol.handle('hqsf-img')`）
//!
//! 与 Electron 的差异（逐条）：
//!   1. **窗口创建方式**：`tauri.conf.json` 里窗口写成 `create:false`（因为 macOS / win+linux 的
//!      decorations 等参数不同，需要平台配置文件覆盖），窗口在本文件里用
//!      `WebviewWindowBuilder::from_config` 手动创建，这样才能挂 `on_navigation` / `on_new_window` /
//!      `on_page_load` —— Tauri 2 没有 Electron 那种「先建窗再设事件」的等价时序。
//!   2. **ready-to-show**：Tauri 没有该事件；用 `on_page_load(PageLoadEvent::Finished)` 代替，
//!      加载完成后 `show()` + `set_focus()`（1.x `src/main/window/index.ts:36-42`）。
//!   3. **`setWindowOpenHandler`**：Tauri 用 `on_new_window`（返回 `NewWindowResponse::Deny`）+
//!      `on_navigation`（拒绝主框架导航到外部 URL）两处配合；1.x 只有一个 handler。
//!   4. **Ctrl+F12 devtools**：Tauri 没有 `before-input-event`，改为页面加载后注入 JS
//!      keydown 监听，回调内部命令 `__hqsf_toggle_devtools`（见 `dispatch.rs`）。
//!      **不用** 全局快捷键插件：那是系统级注册（应用不聚焦时也生效），与 1.x 语义不符。
//!   5. **`hqsf-img` 自定义协议**：Tauri 的协议 origin 随平台变（Windows/Android 是
//!      `http://hqsf-img.localhost/...`，其它平台是 `hqsf-img://localhost/...`），
//!      所以渲染层的 URL 拼装也必须按平台分支；协议实现见 [`handle_image_protocol`]
//!      （异步注册 + 后台线程抓图，缓存/超时/Content-Type 全在 `hqsf_core::infra::media`）。
//!   6. **api.config.json**：1.x 启动时 `loadApiConfig()` 失败即退出；v2 由内核
//!      `services::net::api_config()` 每次调用现读（见 `crates/hqsf-core/src/services/net.rs`），
//!      壳层不缓存、不预校验 —— 启动不会因为缺配置而无窗口，首个需要网络的命令会返回
//!      `[API 配置]` 错误（比 1.x 的「静默无窗口」更可诊断）。
//!   7. **窗口全关**：Tauri 默认「最后一个窗口关闭即退出」（非 macOS 与 1.x 一致；macOS 与 1.x
//!      的「关窗不退出」不同）。**刻意不加** `RunEvent::ExitRequested` 的 `api.prevent_exit()`：
//!      加了就要自己接管整个 macOS 窗口生命周期，本轮取舍是保留 Tauri 默认、行为可预测；
//!      `RunEvent::Reopen` 仍保留为「窗口被隐藏/最小化后点 Dock」的拉回前台兜底。
//!   8. **启动后台任务**：1.x 在 `createWindow()` 之后 `void scheduleAutoUpdateCheck()` /
//!      `startupTokenCheck()`；这里是 `spawn_startup_tasks()` 起两条 detach 线程（会话校验、
//!      延迟 10s 的更新检查），失败全部静默、不阻塞窗口展示。
//!
//! 启动路径禁止 `unwrap()`/`expect()`：所有失败都转成 `anyhow::Error` 或显式 `eprintln!` + 退出码。

mod commands_generated;
mod dispatch;
mod runtime;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::anyhow;
use hqsf_core::CoreCtx;
use hqsf_core::commands::system::HostInfo;
use hqsf_core::infra::db::Db;
use hqsf_core::infra::media;
#[cfg(desktop)]
use hqsf_core::infra::migrate::{self, MigrateOptions, MigrationStatus};
use hqsf_core::infra::session;
use hqsf_core::infra::updater::{UpdateStateStore, auto_check_enabled};
use hqsf_core::ports::{Platform, SecretStore};
use hqsf_core::services::updater::check_for_github_update;
use hqsf_core::services::{auth, settings};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, UriSchemeContext, Wry};
#[cfg(desktop)]
use tauri::webview::{NewWindowResponse, PageLoadEvent};
#[cfg(desktop)]
use tauri::{WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::runtime::clock::SystemClock;
use crate::runtime::events::TauriEvents;
use crate::runtime::files::OsFileStore;
use crate::runtime::http::ReqwestHttp;
use crate::runtime::paths;
use crate::runtime::platform::{MAIN_WINDOW_LABEL, build_platform};
#[cfg(desktop)]
use crate::runtime::secrets::KeyringSecrets;
#[cfg(mobile)]
use crate::runtime::secrets::FileSecrets;

/// 自定义图片协议名（1.x 同名：`src/main/infra/media/imgcache.ts`）。
pub const IMAGE_PROTOCOL: &str = "hqsf-img";
/// 窗口最大化状态变化事件（契约冻结：`commands/registry.rs` 的 `EVENTS`，载荷 `boolean`）。
pub const EVENT_WINDOW_MAXIMIZED: &str = "hqsf:window-maximized-changed";

/// 应用全局状态（`tauri::Manager::manage` 持有，命令层用 `State<'_, AppState>` 取）。
pub struct AppState {
    /// 内核上下文：所有命令都通过它访问业务（壳层不持有业务状态）。
    pub core: Arc<CoreCtx>,
    /// 窗口当前是否最大化（用于只在**变化时**发事件，和 1.x `maximize`/`unmaximize` 一一对应）。
    pub maximized: Arc<AtomicBool>,
    /// 自定义 CSS 注入的互斥锁由 `WindowOps` 自己持有；这里留一个位置给后续需要的
    /// 启动期一次性状态（当前仅占位，避免下一张卡反复改结构体）。
    pub startup: Mutex<StartupFlags>,
    /// 更新状态机（`hqsf-core` 的 `UpdateStateStore`）：四条 `update-*` 通道共享同一份状态，
    /// 内核不自己造单例，所以由壳层持有并注入（1.x 是模块级变量 `src/main/infra/updater`）。
    pub updater: Arc<UpdateStateStore>,
}

/// 启动期标记（后续卡按需扩展）。
#[derive(Debug, Default)]
pub struct StartupFlags {
    /// 是否已把自定义 CSS/JS 应用过一次（1.x `did-finish-load → applyWindowCustomCode`）。
    pub custom_code_applied: bool,
}

/// 启动期致命错误（`setup` 里失败时不立刻返回 `Err`，否则事件循环根本不会启动、
/// 错误框也就弹不出来 —— 见 [`show_startup_error_and_exit`]）。
#[derive(Debug, Default)]
pub struct PendingStartupError(Mutex<Option<String>>);

impl PendingStartupError {
    fn set(&self, message: String) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(message);
        }
    }

    fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// 构造 `HostInfo`（内核 `commands::system` 的入参，壳层负责填宿主事实）。
///
/// 1.x 对照：`process.platform` / `process.arch` / `app.getVersion()` / `app.isPackaged` /
/// `process.env.APPIMAGE`。`is_test_mode` 与 [`paths::detect_test_mode`] 同源。
pub fn build_host_info(app: &AppHandle) -> HostInfo {
    HostInfo {
        platform: host_platform_name().to_string(),
        // 与 `process.arch` 取值对齐（x64 / arm64），不是 Rust 的 `x86_64`。
        arch: match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        }
        .to_string(),
        app_version: app.package_info().version.to_string(),
        is_test_mode: paths::detect_test_mode(),
        // 1.x `app.isPackaged`：debug 构建视为开发态。
        packaged: !cfg!(debug_assertions),
        // 1.x `!!process.env.APPIMAGE`：只有 Linux 有这个概念，其它平台省略（序列化时跳过）。
        is_app_image: if cfg!(target_os = "linux") {
            Some(has_appimage())
        } else {
            None
        },
    }
}

/// 宿主平台名（`process.platform` 的取值口径）。
///
/// 差异：1.x 在 macOS 上是 `"darwin"`，这里统一写 `"macos"`（`HostInfo.platform` 与
/// `auto_check_enabled` 共用同一套取值，避免两处各写一份）。对 `auto_check_enabled` 无影响 ——
/// 它只区分 `"linux"`（`crates/hqsf-core/src/infra/updater.rs:243`）。
fn host_platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "android" => "android",
        _ => "linux",
    }
}

/// 是否运行在 AppImage 里（1.x `!!process.env.APPIMAGE`）。
///
/// 非 Linux 平台读到的环境变量必然为空，但仍在所有平台编译（`cfg!` 是运行期判断，
/// 不是 `#[cfg]`），所以不会产生 unused 告警。
fn has_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}

/// 1.x 自动更新检查的启动延迟（`src/main/infra/updater/index.ts:91` 的 `10_000` ms）。
const AUTO_UPDATE_DELAY: Duration = Duration::from_secs(10);

/// 启动后的两个一次性后台任务（各一条线程，互不依赖，均不阻塞窗口展示）。
///
/// 1.x 对照：`initApp()` 在 `createWindow()` 之后调 `scheduleAutoUpdateCheck()` /
/// `startupTokenCheck()`（`src/main/bootstrap/index.ts:86-87`）。Electron 那两个都是
/// `void …` 风格的「发出去就不管」，这里同样不等结果、不向渲染层广播任何事件：
/// - 更新检查的结果由内核写进 `UpdateStateStore` 并发 `hqsf:update-state`；
/// - 会话失效只清本地（1.x 这一步也**不**发 `signOut`，渲染层下次 `getSession` 拿到 null）。
fn spawn_startup_tasks(app: AppHandle) {
    // (a) 启动会话校验（1.x `startupTokenCheck()`，`src/main/bootstrap/index.ts:20-31`）。
    let token_app = app.clone();
    std::thread::spawn(move || {
        let (core, _) = match startup_task_state(&token_app) {
            Some(snapshot) => snapshot,
            None => return,
        };
        startup_token_check(&core);
    });

    // (b) 延迟 10s 的自动更新检查（1.x `scheduleAutoUpdateCheck()`，
    //     `src/main/infra/updater/index.ts:80-92`）。
    let updater_app = app;
    std::thread::spawn(move || {
        let (core, updater) = match startup_task_state(&updater_app) {
            Some(snapshot) => snapshot,
            None => return,
        };
        schedule_auto_update_check(&core, &updater);
    });
}

/// 从 `AppHandle` 取启动任务需要的两个 `Arc`（拿不到 state 就放弃任务，不 panic）。
///
/// 为什么单独克隆而不是线程里长期持有 `State<'_, AppState>`：`State` 是对 manage 表的借用，
/// 只在 handle 存活期内有效；后台线程要跑很久（更新检查还要 sleep 10s），克隆 `Arc` 更干净。
fn startup_task_state(app: &AppHandle) -> Option<(Arc<CoreCtx>, Arc<UpdateStateStore>)> {
    let state = app.try_state::<AppState>()?;
    Some((Arc::clone(&state.core), Arc::clone(&state.updater)))
}

/// 校验一次本地会话：**只有**服务端明确判定 token 失效时才清本地会话。
///
/// 1.x（`src/main/bootstrap/index.ts:20-31`）：
/// `if (!getStoredToken()) return; const {valid, reachable} = await verifySessionToken();
///  if (!valid && reachable) clearSession()`——网络异常/校验异常不误清（离线可继续本地写作）。
/// `verify_session_token` 内部已经把这些错误折成 `{valid:false, reachable:false}` 返回，
/// 这里再兜一层 `Err`（只可能是钥匙串/文件读写问题），同样不动会话。
fn startup_token_check(core: &CoreCtx) {
    match auth::stored_token(core) {
        Ok(Some(_)) => {}
        Ok(None) => return,
        Err(error) => {
            eprintln!("[hqsf] 启动会话校验：读取本地会话失败，跳过：{error}");
            return;
        }
    }

    let result = match auth::verify_session_token(core) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("[hqsf] 启动会话校验：校验请求异常，保留本地会话：{error}");
            return;
        }
    };

    if result.valid || !result.reachable {
        // 有效，或「判不了」（网络/配置问题）——都保持登录态。
        return;
    }

    // 服务端已响应且明确拒绝：丢弃本地会话，退回未登录。1.x 这里不调 `logout()`。
    match session::clear(core) {
        Ok(()) => eprintln!("[hqsf] 启动会话校验：服务端判定登录已失效，已清除本地会话"),
        Err(error) => eprintln!("[hqsf] 启动会话校验：清除本地会话失败：{error}"),
    }
}

/// 按设置延迟自动检查一次更新（失败静默）。
///
/// 1.x（`src/main/infra/updater/index.ts:80-92`）：
/// `if (!getAppSettings().autoUpdate) return; if (process.platform === 'linux' &&
///  !process.env.APPIMAGE) return; setTimeout(() => void checkForGitHubUpdate().catch(() => undefined), 10_000)`。
/// 判定条件复用内核 `auto_check_enabled`（Linux deb 包不支持自动更新，AppImage/NSIS/macOS 可以）。
fn schedule_auto_update_check(core: &CoreCtx, store: &UpdateStateStore) {
    let auto_update = settings::get(core).auto_update;
    if !auto_check_enabled(auto_update, host_platform_name(), has_appimage()) {
        return;
    }

    // 1.x 用 `setTimeout(...).unref?.()`：延迟 10s 且不阻止进程退出。这里的后台线程是
    // detach 的，进程退出时自然结束，不需要 unref 等价物。
    std::thread::sleep(AUTO_UPDATE_DELAY);
    // 错误静默（1.x `.catch(() => undefined)`）：`check_for_github_update` 自己会把失败写进
    // store 的 `error` 状态并发事件，壳层不再重复处理。
    let _ = check_for_github_update(core, store);
}

/// 组装内核上下文（失败即启动失败）。
fn build_core(app: &AppHandle) -> anyhow::Result<CoreCtx> {
    let test_mode = paths::detect_test_mode();
    let app_paths =
        paths::resolve_paths(app, test_mode).map_err(|e| anyhow!("解析应用路径失败：{e}"))?;

    // 数据目录必须先存在：`Db::open` 只建自己的父目录，缓存/日志等子目录由各自 lane 建。
    std::fs::create_dir_all(&app_paths.data_dir)
        .map_err(|e| anyhow!("创建数据目录 {} 失败：{e}", app_paths.data_dir.display()))?;

    // 一次性数据迁移：**必须在 `Db::open` 之前**（迁移会创建/原子替换 `data_dir/hqsf.db`）。
    // 来源是旧 Electron 的 userData（`~/.config/hqsf-client`），只读、永不删除，可随时回滚。
    // 语义：NoSource（新用户）/AlreadyMigrated（幂等）/DryRun 静默跳过；Migrated 记一行日志；
    // 失败按启动失败处理（`setup` 会写 `PendingStartupError` 并弹框，不 panic、不静默继续建空库）。
    #[cfg(desktop)]
    {
        let legacy_dir = paths::legacy_data_dir(app, test_mode)
            .map_err(|e| anyhow!("解析旧版数据目录失败：{e}"))?;
        match migrate::migrate_legacy_data(
            &legacy_dir,
            &app_paths.data_dir,
            &MigrateOptions::default(),
        ) {
            Ok(report) => match report.status {
                MigrationStatus::Migrated => eprintln!(
                    "[hqsf] 已从旧版本数据目录迁移：{} → {}",
                    legacy_dir.display(),
                    app_paths.data_dir.display()
                ),
                MigrationStatus::AlreadyMigrated
                | MigrationStatus::NoSource
                | MigrationStatus::DryRun => {}
            },
            Err(error) => {
                return Err(anyhow!(
                    "迁移旧版本数据（{}）失败：{error}",
                    legacy_dir.display()
                ));
            }
        }
    }

    let db = Db::open(&app_paths.db_path())
        .map_err(|e| anyhow!("打开本地索引库 {} 失败：{e}", app_paths.db_path().display()))?;

    let platform: Platform = build_platform(app);

    #[cfg(desktop)]
    let secrets: Arc<dyn SecretStore> = Arc::new(KeyringSecrets::new());
    #[cfg(mobile)]
    let secrets: Arc<dyn SecretStore> =
        Arc::new(FileSecrets::new(app_paths.data_dir.join("secrets.json")));

    Ok(CoreCtx::new(
        Arc::new(OsFileStore::new()),
        secrets,
        Arc::new(ReqwestHttp::new().map_err(|e| anyhow!("初始化 HTTP 客户端失败：{e}"))?),
        Arc::new(TauriEvents::new(app.clone())),
        Arc::new(SystemClock::new()),
        app_paths,
        Arc::new(db),
        platform,
    ))
}

/// 是否为「应用自身」URL（允许主框架导航）。
///
/// Tauri 2 的自定义协议 origin：Linux/macOS 是 `tauri://localhost`，Windows/Android 是
/// `http://tauri.localhost`。两者都放行；`about:blank` 放行（某些库会先探测）。
fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost")),
        _ => false,
    }
}

/// 外部链接一律交给系统浏览器（1.x `setWindowOpenHandler` 的 `shell.openExternal` 分支）。
fn open_external_quietly(url: &str) {
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        eprintln!("[hqsf] 打开外部链接失败（{url}）：{e}");
    }
}

/// 页面加载完成后注入 Ctrl+F12 监听（替代 Electron `before-input-event`）。
///
/// 1.x：`src/main/window/index.ts:55-67` 在 `before-input-event` 里判断
/// `input.control && !input.alt && !input.shift && !input.meta && input.key === 'F12'`。
/// 这里用捕获阶段的 `keydown` 监听 + 内部命令调用；`__TAURI_INTERNALS__.invoke` 是
/// `@tauri-apps/api` 的底层通道（非公开文档 API）→ TODO(verify)：若 tauri 3 移除，改用
/// 自定义协议或 `window.__TAURI__.core.invoke`（需要 `withGlobalTauri`）。
const DEVTOOLS_HOTKEY_JS: &str = r#"
(function () {
  if (window.__hqsfDevtoolsHotkeyInstalled) return;
  window.__hqsfDevtoolsHotkeyInstalled = true;
  window.addEventListener('keydown', function (event) {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    if (event.key !== 'F12') return;
    event.preventDefault();
    try {
      window.__TAURI_INTERNALS__.invoke('__hqsf_toggle_devtools');
    } catch (err) {
      // release 包未启用 devtools feature 时命令内部只记日志，这里不应抛错。
      console.warn('[hqsf] 切换开发者工具失败', err);
    }
  }, true);
})();
"#;

/// 页面加载完成后注入 console/异常转发（发布包没有 devtools 时的排障通道）。
///
/// 目的：release 包不编译 `devtools` feature，用户机器上看不到控制台；这里把
/// `console.*`、`window.onerror`、`unhandledrejection` 转发到壳层内部命令
/// `__hqsf_log`，落盘到 `<data_dir>/logs/renderer.log`（1MB 滚动一份 `.1` 备份）。
/// 只转发、不改行为：原 `console.*` 照旧输出，转发失败静默（不能让日志影响页面）。
const CONSOLE_FORWARD_JS: &str = r#"
(function () {
  if (window.__hqsfConsoleForwarded) return;
  window.__hqsfConsoleForwarded = true;
  function send(level, parts) {
    try {
      var text = parts.map(function (part) {
        if (typeof part === 'string') return part;
        try { return JSON.stringify(part); } catch (err) { return String(part); }
      }).join(' ');
      window.__TAURI_INTERNALS__.invoke('__hqsf_log', { level: level, message: text });
    } catch (err) {
      /* 壳层未注册该命令时静默 */
    }
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (key) {
    var original = typeof console[key] === 'function' ? console[key].bind(console) : function () {};
    console[key] = function () {
      var args = Array.prototype.slice.call(arguments);
      send(key, args);
      original.apply(null, args);
    };
  });
  window.addEventListener('error', function (event) {
    send('error', ['uncaught: ' + (event.message || '') + ' @ ' + (event.filename || '') + ':' + (event.lineno || 0)]);
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    send('error', ['unhandledrejection: ' + ((reason && (reason.stack || reason.message)) || String(reason))]);
  });
})();
"#;

/// `hqsf-img` 协议处理器。
///
/// 1.x：`src/main/infra/media/imgcache.ts:281-300` —— 读 `?url=`、校验 http(s)、
/// 命中本地缓存则直接返回，否则抓取并写缓存（sha1 文件名 + `.meta` 存 Content-Type，
/// 单图 10MB、缓存目录 16MB 上限）。
///
/// 迁移差异：
///   - 抓取/缓存逻辑**全在内核**（`crates/hqsf-core/src/infra/media.rs` 的
///     `media::shared().get_with_content_type(&ctx, url)`：sha1 文件名、`.meta` 存
///     Content-Type、单图 10MB / 目录 16MB、内存 LRU + in-flight 去重）。壳层只做
///     「取 `?url=` → 校验协议 → 调内核 → 造 HTTP 响应」，与 1.x 的分层一致。
///   - 协议注册用**异步**版（`register_asynchronous_uri_scheme_protocol`）：同步 handler 在
///     Linux/GTK 上跑主线程，网络慢时会冻住界面；这里把抓图丢给后台线程，用
///     `UriSchemeResponder` 回填结果。
///   - 响应头：`Content-Type` 取内核返回值；`Cache-Control: no-store`（内核已自缓存，
///     webview 再缓存会让「清除缓存」命令失效）；`Access-Control-Allow-Origin: *`
///     （自定义协议是独立 origin，`<img>`/canvas 需要 CORS）。
///   - 失败映射：`NotFound` → 404、`Forbidden` → 403、其余（网络/上游/缓存）→ 502，
///     body 是内核的中文文案（1.x 这里渲染层只看到图片加载失败，看不到原因）。
fn handle_image_protocol(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    // 参数解析很便宜，留在当前线程；抓图可能几十毫秒到数秒，必须丢到后台线程，
    // 否则 Linux/GTK 上自定义协议回调在**主线程**执行会把界面冻住（1.x 用 `net.fetch` 天然异步）。
    let Some(target) = extract_image_url(&request) else {
        responder.respond(text_response(
            StatusCode::BAD_REQUEST,
            "[hqsf] 缺少 url 查询参数（形如 ?url=<encodeURIComponent(url)>）",
        ));
        return;
    };
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        // 1.x 同样只放行 http(s)：本地文件不走这个协议（`asset:` 协议没有开启）。
        responder.respond(text_response(
            StatusCode::FORBIDDEN,
            &format!("[hqsf] 仅支持 http(s) 图片地址：{target}"),
        ));
        return;
    }

    // 取 `AppState` 里的同一个 `CoreCtx`：图片缓存要有内存 LRU 与 in-flight 去重，
    // 必须命中 `media::shared()` 这一份实例（`clear-cache` 清的就是它）。
    let app = context.app_handle().clone();
    std::thread::spawn(move || {
        let Some(state) = app.try_state::<AppState>() else {
            responder.respond(text_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "[hqsf] 应用尚未初始化完成",
            ));
            return;
        };
        let response = match media::shared().get_with_content_type(&state.core, &target) {
            Ok((bytes, content_type)) => Response::builder()
                .status(StatusCode::OK)
                .header("content-type", content_type)
                // 内核自己做了磁盘/内存缓存；WebView 层默认也缓存图片字节，
                // 避免每次重挂载都重新走一遍自定义协议（Android 上单图约 600ms）。
                // 「清除缓存」会递增渲染层的 URL 版本号，旧 URL 自然失效。
                .header("cache-control", "public, max-age=31536000, immutable")
                // 自定义协议在 webview 里是独立 origin，`<img>`/canvas 需要 CORS 头。
                .header("access-control-allow-origin", "*")
                .body(bytes.to_vec())
                .unwrap_or_else(|_| Response::new(Vec::new())),
            Err(error) => {
                // 错误分类：目标不存在 → 404；越权 → 403；上游/网络/缓存失败 → 502。
                // body 用内核的中文文案（1.x 在这里是渲染层看不到的日志，这里返回正文更可诊断）。
                let status = match error {
                    hqsf_core::CoreError::NotFound(_) => StatusCode::NOT_FOUND,
                    hqsf_core::CoreError::Forbidden(_) => StatusCode::FORBIDDEN,
                    _ => StatusCode::BAD_GATEWAY,
                };
                eprintln!("[hqsf] hqsf-img 取图失败（{target}）：{error}");
                text_response(status, &error.to_string())
            }
        };
        responder.respond(response);
    });
}

/// 纯文本响应（协议失败分支）：不缓存、允许跨 origin 读取。
fn text_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "no-store")
        .body(message.as_bytes().to_vec())
        // 非法 header 仅可能来自常量，兜底返回空响应而不是 panic。
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 从协议请求里取出原始图片 URL。
///
/// 两种平台形态都接受：
///   - Linux/macOS：`hqsf-img://localhost/fetch?url=...`（1.x 渲染层写的是 `hqsf-img://fetch?url=`，
///     此时 host 是 `fetch`，同样能用 `query_pairs` 取到）；
///   - Windows/Android：`http://hqsf-img.localhost/fetch?url=...`。
fn extract_image_url(request: &Request<Vec<u8>>) -> Option<String> {
    let raw = request.uri().to_string();
    let parsed = tauri::Url::parse(&raw).ok()?;
    parsed
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty())
}

/// 创建主窗口（`tauri.conf.json` 里 `create:false`，参数来自配置 + 平台覆盖文件）。
#[cfg(desktop)]
fn create_main_window(app: &AppHandle) -> anyhow::Result<WebviewWindow> {
    // 已经有同名窗口（macOS Reopen 重建路径）时直接复用，Tauri 不允许同 label 建两个。
    if let Some(existing) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        existing.show().ok();
        existing.set_focus().ok();
        return Ok(existing);
    }

    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("tauri.conf.json 缺少 app.windows[0] 窗口配置"))?;

    let window = WebviewWindowBuilder::from_config(app, &window_config)
        .map_err(|e| anyhow!("按配置创建窗口失败：{e}"))?
        // 1.x `setWindowOpenHandler`：拒绝新窗口，http(s) 交系统浏览器。
        .on_new_window(|url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                open_external_quietly(url.as_str());
            }
            NewWindowResponse::Deny
        })
        // 1.x 的安全不变式：只允许留在应用自身 origin，外链一律外部打开。
        //
        // 注意：wry 的 `decide-policy` 回调（`PolicyDecisionType::NavigationAction`）**不区分
        // 主框架与子框架**，阅读正文里的 `<iframe>`（网易云 / QQ 音乐 / B 站嵌入播放器）
        // 首次导航也会走这里；若一律 `false`，播放器位置就是「一块透明空白」。
        // 所以对三个播放器端点开一个极窄白名单（判定在内核 `domain::embed`）：
        // 只放行播放器页面本身，播放器内部点出来的普通页面仍然交系统浏览器。
        .on_navigation(|url| {
            if is_app_url(url) {
                return true;
            }
            if hqsf_core::domain::embed::is_embedded_media_url(url.as_str()) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                open_external_quietly(url.as_str());
            }
            false
        })
        .on_page_load(|window, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            // 1.x `ready-to-show`：窗口一直 show:false，首屏加载完成才显示，避免白屏闪烁。
            let _ = window.show();
            let _ = window.set_focus();
            // Ctrl+F12（替代 `before-input-event`）；页面 reload 后需要重放，故放在 page load 里。
            if let Err(e) = window.eval(DEVTOOLS_HOTKEY_JS) {
                eprintln!("[hqsf] 注入 devtools 快捷键监听失败：{e}");
            }
            // console/异常转发到 <data_dir>/logs/renderer.log（发布包没有 devtools 时的排障通道）。
            if let Err(e) = window.eval(CONSOLE_FORWARD_JS) {
                eprintln!("[hqsf] 注入 console 转发失败：{e}");
            }
            // 1.x `did-finish-load → applyWindowCustomCode()`：重放 zoomFactor / customCss / customJs。
            // 业务规则在 settings lane（`hqsf_core::commands::settings::apply_settings_to_window`），
            // 壳层只负责「什么时候重放」——内核自己读 settings.json 并调 `WindowOps` 端口。
            if let Some(state) = window.app_handle().try_state::<AppState>() {
                if let Err(e) = hqsf_core::commands::settings::apply_settings_to_window(&state.core)
                {
                    eprintln!("[hqsf] 重放窗口自定义设置失败：{e}");
                }
            }
        })
        .build()
        .map_err(|e| anyhow!("创建主窗口失败：{e}"))?;

    // 1.x `maximize`/`unmaximize` → 发 `hqsf:window-maximized-changed`。
    // Tauri 没有这两个事件，退化成「Resized 后比较 is_maximized()」，只在值变化时发事件。
    let handle = app.clone();
    let maximized = app
        .try_state::<AppState>()
        .map(|state| state.maximized.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }
        let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        let now = window.is_maximized().unwrap_or(false);
        let previous = maximized.swap(now, Ordering::SeqCst);
        if previous != now {
            if let Err(e) = handle.emit(EVENT_WINDOW_MAXIMIZED, now) {
                eprintln!("[hqsf] 发送窗口最大化事件失败：{e}");
            }
        }
    });

    Ok(window)
}

/// 构建插件链：桌面多一个单实例插件，移动端没有单实例语义。
#[cfg(desktop)]
fn base_builder() -> tauri::Builder<Wry> {
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }))
}

#[cfg(mobile)]
fn base_builder() -> tauri::Builder<Wry> {
    tauri::Builder::default()
}

/// 启动公共部分：建 `CoreCtx`、`AppState`；桌面再建窗口、起后台任务。
///
/// 移动端由 Tauri 的 Android 壳自动创建唯一的 WebView，不调用 `create_main_window`。
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // 主线程 id 必须在任何命令/对话框之前记录：dialog / clipboard 的 blocking API 靠它
    // 判断「现在能不能阻塞等待主线程」（见 `runtime::is_main_thread`）。
    runtime::mark_main_thread();
    // 启动失败用的错误槽：必须最先 manage，后面任何一步失败都能往里写。
    app.manage(PendingStartupError::default());

    // 1.x bootstrap（`src/main/bootstrap/index.ts:40-85`）：建 ctx / 建窗口，失败
    // `dialog.showErrorBox` + `app.exit(1)`。
    //
    // 差异（重要）：这里**不**在 setup 里返回 Err。tauri 一旦在 setup 返回 Err 就不会进入
    // 事件循环，而对话框需要主线程跑起来才能显示 → 1.x 那个「错误框」在这里永远弹不出来，
    // 进程只会静默退出。改为：记下错误、返回 Ok 进入事件循环，在 `RunEvent::Ready` 里
    // 弹框（非阻塞），用户关掉后再 `exit(1)`。
    let core = match build_core(app.handle()) {
        Ok(core) => Arc::new(core),
        Err(err) => {
            eprintln!("[hqsf] 启动失败：{err:#}");
            if let Some(pending) = app.try_state::<PendingStartupError>() {
                pending.set(format!("{err:#}"));
            }
            return Ok(());
        }
    };

    // Android 没有终端可看 Rust panic；把 panic 落到应用私有目录，便于真机排障。
    #[cfg(mobile)]
    {
        let data_dir = app.path().app_data_dir().ok();
        std::panic::set_hook(Box::new(move |info| {
            let msg = format!("{info}\n");
            eprintln!("[hqsf] panic: {msg}");
            if let Some(dir) = &data_dir {
                let _ = std::fs::write(dir.join("panic.log"), &msg);
            }
        }));
    }

    // 更新状态机：1.x 是模块级单例；内核不持全局状态，所以壳层建一份并注入。
    // 版本号取运行中的包版本（`update-state` 的 `currentVersion` 字段来源）。
    let updater = Arc::new(UpdateStateStore::new(
        app.package_info().version.to_string(),
    ));

    app.manage(AppState {
        core,
        maximized: Arc::new(AtomicBool::new(false)),
        startup: Mutex::new(StartupFlags::default()),
        updater,
    });

    #[cfg(desktop)]
    {
        if let Err(err) = create_main_window(app.handle()) {
            eprintln!("[hqsf] 创建窗口失败：{err:#}");
            if let Some(pending) = app.try_state::<PendingStartupError>() {
                pending.set(format!("{err:#}"));
            }
            return Ok(());
        }

        // 1.x bootstrap 收尾（`src/main/bootstrap/index.ts:12-40`、`:86-87`）：
        // `startupTokenCheck()` 与 `scheduleAutoUpdateCheck()`。两者都**不阻塞**启动 ——
        // 各起一条独立后台线程，窗口该显示就显示，失败一律静默（离线可继续本地写作）。
        spawn_startup_tasks(app.handle().clone());
    }

    Ok(())
}

fn run_impl() -> anyhow::Result<()> {
    let builder = base_builder()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 图片协议：注册名与 1.x 一致；平台 origin 差异见 handle_image_protocol 的注释。
        // 用**异步**注册（responder 回调）：同步注册会在主线程阻塞抓图，Linux/GTK 上直接卡界面。
        .register_asynchronous_uri_scheme_protocol(IMAGE_PROTOCOL, handle_image_protocol);

    // 85 条命令 + 内部命令由生成器产出（`src/commands_generated.rs`，gitignored）：
    // 先生成再编译 —— `node src-tauri/scripts/gen-tauri-commands.mjs --write`。
    let builder = commands_generated::register(builder);

    let app = builder
        .setup(setup)
        .build(tauri::generate_context!())
        .map_err(|e| anyhow!("构建 Tauri 应用失败：{e}"))?;

    // 启动期致命错误：等事件循环真正跑起来（Ready）再弹框，关掉后 exit(1)。
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            if let Some(pending) = app_handle.try_state::<PendingStartupError>() {
                if let Some(message) = pending.take() {
                    show_startup_error_and_exit(app_handle, &message);
                    return;
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let tauri::RunEvent::Reopen { .. } = event {
                // 1.x `activate`：`if (BrowserWindow.getAllWindows().length === 0) createWindow()`
                // 否则把已有窗口拉到前台。
                //
                // 差异：**这里不重建窗口、也不加 `ExitRequested` 的 `api.prevent_exit()`**。
                // 1.x 在 macOS 上「关窗不退出、点 Dock 再开」，而 Tauri 默认「关最后一个窗口即退出」
                // （与 1.x 非 macOS 行为一致）。要复刻 macOS 的「关窗不退出」就必须自己接管
                // `ExitRequested` 与整个窗口生命周期；本轮取舍是保留 Tauri 默认 —— 关窗即退出，
                // 行为可预测，`Reopen` 只覆盖「窗口被隐藏/最小化后点 Dock」这一半语义。
                if let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            // 非 macOS：保持 tauri 默认（最后一个窗口关闭即退出，与 1.x `window-all-closed` 一致）。
            let _ = (app_handle, event);
        }
    });

    Ok(())
}

/// 应用入口（桌面 `main.rs` 与 Android 的 `mobile_entry_point` 都调这一个函数）。
///
/// 返回 `()` 而不是 `Result`：`#[tauri::mobile_entry_point]` 生成的 JNI 入口要求无返回值；
/// 桌面端也统一在这里落盘错误与退出码，避免两个平台各写一份。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = run_impl() {
        eprintln!("[hqsf] 应用启动失败：{error:#}");
        std::process::exit(1);
    }
}

/// 启动失败诊断：1.x 用同步的 `dialog.showErrorBox`，这里用**非阻塞**消息框 + 退出兜底。
///
/// 为什么不是 `blocking_show`：插件内部把真正的 UI 投递到 main thread，然后在**调用线程**上
/// `recv()` 等待；而本函数就是在 main thread（`RunEvent::Ready` 回调）上执行的 —— 直接用
/// blocking 版会永久死锁。`show` 是非阻塞的（回调里拿到点击结果）。
fn show_startup_error_and_exit(app: &AppHandle, message: &str) {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    app.dialog()
        .message(message.to_string())
        .title("黄芪饮片启动失败")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .show(move |_| {
            handle.exit(1);
        });

    // 兜底：万一对话框没能显示（无显示服务 / 插件异常 / 回调丢失），60s 后强制退出，
    // 避免留下一个不可见也不退出的僵尸进程（1.x 的同步错误框没有这个风险）。
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(60));
        std::process::exit(1);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_url_allows_tauri_origins() {
        for good in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "about:blank",
        ] {
            let url = tauri::Url::parse(good).expect("url");
            assert!(is_app_url(&url), "{good} 应被放行");
        }
        for bad in ["https://example.com/", "file:///etc/passwd"] {
            let url = tauri::Url::parse(bad).expect("url");
            assert!(!is_app_url(&url), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn host_platform_name_uses_process_platform_values() {
        // `HostInfo.platform` 与 `auto_check_enabled` 共用这套取值；只允许三平台名，
        // 否则 `auto_check_enabled` 的 `platform == "linux"` 判断会静默失配。
        let platform = host_platform_name();
        assert!(matches!(platform, "windows" | "macos" | "linux"));
        assert_eq!(cfg!(target_os = "macos"), platform == "macos");
        assert_eq!(cfg!(target_os = "windows"), platform == "windows");
    }

    #[test]
    fn extract_image_url_reads_query_parameter() {
        let request = Request::builder()
            .uri("hqsf-img://localhost/fetch?url=https%3A%2F%2Fcdn.example.com%2Fa.png")
            .body(Vec::new())
            .expect("request");
        assert_eq!(
            extract_image_url(&request).as_deref(),
            Some("https://cdn.example.com/a.png")
        );
    }
}
