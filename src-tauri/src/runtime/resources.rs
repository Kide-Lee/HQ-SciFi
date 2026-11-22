//! Android 资源落盘：把 APK 内嵌的资源释放到应用私有目录。
//!
//! Tauri 在 Android 上把 `bundle.resources` 放进 APK 的 `assets/`，
//! `app.path().resource_dir()` 返回的是 `asset://localhost` 这类虚拟 URL，`std::fs` 读不到。
//! 这里在编译期把三份资源嵌入二进制（与桌面安装包内容同源），首次启动写到
//! `<data_dir>/resources/`，让 `AppPaths.resource_dir` 回到普通文件系统路径。
//!
//! 资源文件由 `src-tauri/scripts/prepare-resources.mjs` 在构建前落盘（不入库），
//! 因此 `include_bytes!` 与 `bundle.resources` 使用同一份源文件。

use std::path::{Path, PathBuf};

use hqsf_core::error::{CoreError, CoreResult};

const AGREEMENT: &[u8] = include_bytes!("../../resources/agreement.md");
const API_CONFIG: &[u8] = include_bytes!("../../resources/api.config.json");
const CHANGELOG: &[u8] = include_bytes!("../../resources/changelog.md");

const FILES: [(&str, &[u8]); 3] = [
    ("agreement.md", AGREEMENT),
    ("api.config.json", API_CONFIG),
    ("changelog.md", CHANGELOG),
];

/// 把内嵌资源写到 `dir`，内容不同才覆盖（避免每次启动都写盘），返回该目录。
pub fn materialize(dir: &Path) -> CoreResult<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|e| CoreError::app(format!("创建资源目录 {} 失败：{e}", dir.display())))?;
    for (name, bytes) in FILES {
        let path = dir.join(name);
        let unchanged = std::fs::read(&path)
            .map(|existing| existing == bytes)
            .unwrap_or(false);
        if unchanged {
            continue;
        }
        std::fs::write(&path, bytes)
            .map_err(|e| CoreError::app(format!("写入资源 {} 失败：{e}", path.display())))?;
    }
    Ok(dir.to_path_buf())
}
