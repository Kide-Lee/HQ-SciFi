//! `AppPaths` 的 Tauri 实现：数据目录 / 资源目录 / 文档目录 / 测试模式。
//!
//! 迁移来源：
//!   - `src/main/index.ts:9-11`：`isTestMode()` 时 `app.setPath('userData', join(app.getPath('appData'),'hqsf-test'))`
//!   - `src/main/infra/apiconfig.ts`：api.config.json 的候选顺序
//!     `$HQSF_API_CONFIG` → （测试模式）`cwd/api.config.test.json` → `cwd/api.config.json`
//!     → `app.getAppPath()/api.config.json` → `process.resourcesPath/api.config.json`
//!   - `src/main/infra/fs/index.ts:defaultDocsRoot()`：`join(app.getPath('documents'), '荒启科幻', '草稿')`
//!     （测试模式草稿根加 `-test` 后缀；后缀由内核按 `AppPaths.test_mode` 拼）
//!
//! 与 Electron 的差异：
//!   1. **路径根换了**：Electron userData = `~/.config/hqsf-client`（Linux）/`%APPDATA%/hqsf-client`；
//!      Tauri `app_data_dir()` = `<XDG_DATA_HOME>/com.huangqisf.client` / `%APPDATA%\com.huangqisf.client`
//!      （见迁移计划 §1.5）。旧目录与新目录不是同一个，所以启动时先跑一次
//!      `hqsf_core::infra::migrate::migrate_legacy_data`（见 [`legacy_data_dir`] 与 `lib.rs::build_core`）。
//!   2. **测试模式目录**：1.x = `<appData>/hqsf-test`；这里同样取 `app_data_dir()` 的**父目录**再拼
//!      `hqsf-test`，即 `<XDG_DATA_HOME>/hqsf-test`。TODO(verify): 迁移计划 §1.5 写的是
//!      `com.huangqisf.client-test`；按 lead 的要求以 1.x 的 `hqsf-test` 为准（两个目录名都只影响
//!      测试数据隔离），如需与文档一致改这一段即可。
//!   3. **api.config.json 的查找由内核做**：`services::net::api_config(&ctx)` 只在
//!      `resource_dir/api.config.json` 与 `data_dir/api.config.json` 里找；所以壳层把 1.x 的
//!      「环境变量 / cwd / 资源目录」三种语义**折算进 `resource_dir`**（见 [`resolve_resource_dir`]）。
//!   4. `documents_dir` 由壳层给，草稿根（`荒启科幻/草稿`）由内核拼（内核 `infra::fs` 负责）。

use std::path::{Path, PathBuf};

use hqsf_core::error::{CoreError, CoreResult};
use hqsf_core::ports::AppPaths;
use tauri::{AppHandle, Manager};

use crate::runtime::resources;

/// 测试模式的命令行参数（与 1.x `src/main/testmode.ts` 一致：`--test` 或 `HQSF_TEST=1`）。
pub const TEST_FLAG: &str = "--test";
/// 测试模式的环境变量（1.x 同名）。
pub const TEST_ENV: &str = "HQSF_TEST";
/// 1.x 用 `HQSF_API_CONFIG` 指定 api.config.json 绝对路径（迁移计划 §1.5 保留该开关）。
pub const API_CONFIG_ENV: &str = "HQSF_API_CONFIG";

/// 测试模式判定：`--test` 命令行参数 或 `HQSF_TEST=1`。
///
/// 1.x：`process.argv.includes('--test') || process.env.HQSF_TEST === '1'`。
pub fn detect_test_mode() -> bool {
    let by_arg = std::env::args().any(|arg| arg == TEST_FLAG);
    let by_env = std::env::var(TEST_ENV).map(|v| v == "1").unwrap_or(false);
    by_arg || by_env
}

/// 资源目录：
///   1. `HQSF_API_CONFIG` 设置了 → 取其父目录（1.x 直接读该文件，内核只认目录）；
///   2. debug 构建（开发）→ 仓库根（`CARGO_MANIFEST_DIR` 的父目录），这样 `api.config.json` 能读到；
///   3. 发布包 → `app.path().resource_dir()`（= 安装目录下的 resources）。
///
/// TODO(verify): 开发模式下把 resource_dir 指向仓库根，意味着 `agreement.md`/`changelog.md`
/// 也要从仓库根可读（1.x 从 resourcesPath 读，dev 时是仓库根）。若后续更新检查需要这两个文件，
/// 需要确认 dev 的取法。
fn resolve_resource_dir(app: &AppHandle) -> CoreResult<PathBuf> {
    if let Ok(raw) = std::env::var(API_CONFIG_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            // 1.x 语义是「文件路径」；这里取父目录，让内核的 `resource_dir/api.config.json` 命中。
            if let Some(parent) = path.parent() {
                return Ok(parent.to_path_buf());
            }
        }
    }

    #[cfg(all(debug_assertions, desktop))]
    {
        // src-tauri/ 的父目录 = 仓库根（1.x dev 时 app.getAppPath() 就是仓库根）。
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| {
                CoreError::app("无法确定开发模式的资源目录（CARGO_MANIFEST_DIR 无父目录）")
            })?;
        if repo_root.join("api.config.json").exists() {
            return Ok(repo_root);
        }
        // 仓库根没有 api.config.json 时退回打包资源目录，避免 dev 直接报「配置缺失」时误判路径。
        eprintln!(
            "[hqsf] 开发模式未在 {} 找到 api.config.json，回退到 resource_dir",
            repo_root.display()
        );
    }

    #[cfg(mobile)]
    {
        // Android：bundle.resources 在 APK assets 里，`resource_dir()` 是 asset:// 虚拟 URL，
        // 内核用 std::fs 读不到；把编译期嵌入的资源释放到私有目录，再交给内核。
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| CoreError::app(format!("无法获取数据目录：{e}")))?;
        return resources::materialize(&data_dir.join("resources"));
    }

    #[cfg(desktop)]
    {
        app.path()
            .resource_dir()
            .map_err(|e| CoreError::app(format!("无法获取资源目录：{e}")))
    }
}

/// 数据目录：`app_data_dir()`；测试模式换成 `<appData>/hqsf-test`（见文件头差异 2）。
fn resolve_data_dir(app: &AppHandle, test_mode: bool) -> CoreResult<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| CoreError::app(format!("无法获取数据目录：{e}")))?;
    if !test_mode {
        return Ok(app_data);
    }
    let parent = app_data
        .parent()
        .map(Path::to_path_buf)
        // app_data_dir 没有父目录（极少见）：退化为在其下面建 test 子目录，绝不 panic。
        .unwrap_or_else(|| app_data.join("test"));
    Ok(parent.join("hqsf-test"))
}

/// 文档目录：`document_dir()`；Linux 未装 xdg-user-dirs 时可能不存在/取不到，回退 `home/Documents`。
#[cfg(mobile)]
fn resolve_documents_dir(app: &AppHandle) -> CoreResult<PathBuf> {
    // Android 没有桌面意义的「文档目录」，也没有 SAF 授权；v2.1.16 先用应用私有目录，
    // 后续接 SAF 时只改这里（内核只看到 AppPaths.documents_dir）。
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| CoreError::app(format!("无法获取数据目录：{e}")))?;
    Ok(data.join("documents"))
}

#[cfg(desktop)]
fn resolve_documents_dir(app: &AppHandle) -> CoreResult<PathBuf> {
    if let Ok(dir) = app.path().document_dir() {
        return Ok(dir);
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| CoreError::app(format!("无法获取文档目录（home 也不可用）：{e}")))?;
    // TODO(verify): 1.x 用 `app.getPath('documents')`，Electron 在 Linux 上同样依赖 xdg-user-dirs，
    // 取不到时返回 $HOME/Documents；此处与之对齐。
    Ok(home.join("Documents"))
}

/// 旧版 Electron 的数据目录（数据迁移的**来源**，只读）。
///
/// 1.x：`app.getPath('userData')`。Electron 的 `appData` 在三平台分别是
/// `~/.config`（Linux）、`%APPDATA%`（Windows）、`~/Library/Application Support`（macOS），
/// 正好等于 tauri 的 `app.path().config_dir()`（dirs 库同源），再拼应用名：
///   - 正常模式：`<appData>/hqsf-client`（`package.json` 的 `name`，不是 productName）；
///   - 测试模式：`<appData>/hqsf-test`（1.x `src/main/index.ts:9-11` 用 `app.setPath` 改写的 userData）。
///
/// 与 Electron 的差异：Tauri 的新数据目录是 `app_data_dir()`（`<XDG_DATA_HOME>/com.huangqisf.client`），
/// 与旧的 `~/.config/hqsf-client` **不是同一个目录**，所以启动时要跑
/// `hqsf_core::infra::migrate::migrate_legacy_data`（见 `lib.rs::build_core`）。
/// 旧目录只读不写、永不删除，用户可随时回滚到 Electron 版。
#[cfg(desktop)]
pub fn legacy_data_dir(app: &AppHandle, test_mode: bool) -> CoreResult<PathBuf> {
    let app_data = app
        .path()
        .config_dir()
        .map_err(|e| CoreError::app(format!("无法获取旧版数据目录（config_dir）：{e}")))?;
    Ok(if test_mode {
        app_data.join("hqsf-test")
    } else {
        app_data.join("hqsf-client")
    })
}

/// 组装内核需要的 [`AppPaths`]。
pub fn resolve_paths(app: &AppHandle, test_mode: bool) -> CoreResult<AppPaths> {
    let data_dir = resolve_data_dir(app, test_mode)?;
    let resource_dir = resolve_resource_dir(app)?;
    let documents_dir = resolve_documents_dir(app)?;
    Ok(AppPaths {
        data_dir,
        resource_dir,
        documents_dir,
        test_mode,
    })
}
