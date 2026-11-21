//! `FileStore` 的 std::fs 实现（1.x `src/main/infra/fs/index.ts` 的底层读写原语）。
//!
//! 迁移来源：`src/main/infra/fs/index.ts:1-260`（readLocalDoc / writeLocalDoc / listLocalDocs /
//! removeLocalDoc / mkdir / rename / stat），原先直接 `fs.promises.*`；这里换成同步 `std::fs`，
//! 由命令层决定在哪个线程执行（tauri 的 `#[tauri::command] async fn` 跑在 tokio 线程池上）。
//!
//! 与 Electron 的差异：
//!   1. **路径安全在别处**：1.x 每个文件 IPC 都先过 `assertInside(root, p)`（resolve + realpath 防
//!      `..`/symlink 穿越，见 `src/main/infra/fs/index.ts:20-40`）。Tauri 版把这条不变式放在内核
//!      （`hqsf-core` 的 docs 服务）里，本文件是「纯 fs」端口，**不做白名单判断**——调用方必须已经
//!      校验过路径（`CoreCtx` 只接受内核服务传进来的绝对路径）。
//!   2. **`list` 的排序**：1.x `listLocalDocs` 用 `name.localeCompare(b, 'zh')`（拼音序）。
//!      Rust 标准库没有 locale-aware collation，这里退化为「目录优先 + 小写化后按 Unicode 码位比较」，
//!      纯 ASCII 文件名与 1.x 一致，中文名排序会不同。TODO(verify): 若渲染层依赖拼音序，
//!      需要在壳层加 `pinyin` crate 或改成「内核返回未排序 + 渲染层排序」。
//!   3. **权限位**：1.x `settings.json` 用 `mode: 0o600` 写入。`FileStore` trait 没有 mode 参数，
//!      本实现不做特殊处理（见 TODO）。
//!   4. `modified_ms` 直接取 `metadata().modified()` 的 Unix 毫秒（等价 1.x `mtimeMs`）；
//!      平台不支持 mtime 时返回 0（1.x 为 `NaN`，渲染层同样当 0 处理）。

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use hqsf_core::error::{CoreError, CoreResult};
use hqsf_core::ports::{DirEntry, FileMeta, FileStore};

/// 基于 `std::fs` 的文件端口。
#[derive(Debug, Default, Clone, Copy)]
pub struct OsFileStore;

impl OsFileStore {
    pub fn new() -> Self {
        Self
    }
}

/// 取 Unix 毫秒；早于 1970 或平台不支持时返回 0。
fn modified_ms_of(meta: &fs::Metadata) -> i64 {
    match meta.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
            Err(_) => 0,
        },
        Err(_) => 0,
    }
}

/// 目录优先，再按名称（小写化）比较；与 1.x `listLocalDocs` 的「isDir 优先 + 名称序」对齐，
/// 但中文排序不是拼音序（见文件头差异 2）。
fn entry_sort_key(e: &DirEntry) -> (bool, String, String) {
    (!e.is_dir, e.name.to_lowercase(), e.name.clone())
}

impl FileStore for OsFileStore {
    fn read(&self, path: &Path) -> CoreResult<Vec<u8>> {
        fs::read(path).map_err(CoreError::from)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> CoreResult<()> {
        // 1.x writeLocalDoc 会先 `mkdirSync(dirname, {recursive:true})` 再写；保持同样语义。
        // TODO(verify): 内核 docs 服务是否自己保证父目录存在？若会，这里可去掉 create_dir_all。
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }
        // TODO(verify): 原子写（先写 .tmp 再 rename）能防半截文件；1.x 直接 writeFile，
        // v2 暂保持同样语义，避免与内核的比较逻辑产生差异。
        fs::write(path, bytes).map_err(CoreError::from)
    }

    fn remove_file(&self, path: &Path) -> CoreResult<()> {
        fs::remove_file(path).map_err(CoreError::from)
    }

    fn remove_dir_all(&self, path: &Path) -> CoreResult<()> {
        fs::remove_dir_all(path).map_err(CoreError::from)
    }

    fn rename(&self, from: &Path, to: &Path) -> CoreResult<()> {
        if let Some(parent) = to.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::rename(from, to).map_err(CoreError::from)
    }

    fn create_dir_all(&self, path: &Path) -> CoreResult<()> {
        fs::create_dir_all(path).map_err(CoreError::from)
    }

    fn list(&self, path: &Path) -> CoreResult<Vec<DirEntry>> {
        let read = fs::read_dir(path).map_err(CoreError::from)?;
        let mut out: Vec<DirEntry> = Vec::new();
        for item in read {
            let item = item.map_err(CoreError::from)?;
            // 用 symlink_metadata 之外的 metadata：1.x stat 跟随符号链接，保持一致。
            let meta = match item.metadata() {
                Ok(m) => m,
                // 单个条目 stat 失败（权限/竞态删除）不应该让整棵树失败：跳过。
                Err(_) => continue,
            };
            let name = item.file_name().to_string_lossy().to_string();
            let is_dir = meta.is_dir();
            out.push(DirEntry {
                name,
                path: item.path(),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified_ms: if is_dir { 0 } else { modified_ms_of(&meta) },
            });
        }
        out.sort_by(|a, b| entry_sort_key(a).cmp(&entry_sort_key(b)));
        Ok(out)
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn metadata(&self, path: &Path) -> CoreResult<FileMeta> {
        let meta = fs::metadata(path).map_err(CoreError::from)?;
        Ok(FileMeta {
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified_ms: modified_ms_of(&meta),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_sorts_dirs_first() {
        let base = std::env::temp_dir().join(format!("hqsf-files-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("b-dir")).expect("mkdir");
        fs::write(base.join("a.md"), b"x").expect("write");
        let entries = OsFileStore.list(&base).expect("list");
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "b-dir");
        assert_eq!(entries[1].name, "a.md");
        assert!(entries[1].modified_ms > 0);
        let _ = fs::remove_dir_all(&base);
    }
}
