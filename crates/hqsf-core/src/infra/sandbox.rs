//! 路径沙箱：`assertInside` 的 Rust 等价物。
//!
//! 原实现见 `src/main/infra/fs/index.ts`：所有本地文件 IPC 都以 `getDocsRoot()` 为根，
//! 先 resolve 再 realpath，防 `..` 与符号链接穿越。这里逐条复刻：
//!
//! 1. **词法层**先归一（消掉 `.`、折叠 `..`），越出根目录立即拒绝；
//! 2. 路径**存在时**再做 realpath 比对，防 symlink 指向根外；
//! 3. 不存在的新文件（如待创建的草稿）只做词法校验——这正是原实现的语义。

use std::path::{Component, Path, PathBuf};

use crate::{CoreError, CoreResult};

/// 词法归一：消 `.`、折叠 `..`（不触碰文件系统）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 不能在根之上再退：保留 `..`，让后续 starts_with 判定失败
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 校验 `candidate` 落在 `root` 内，返回可安全使用的绝对路径。
///
/// `candidate` 可以是相对路径（相对 `root` 解释）。
pub fn assert_inside(root: &Path, candidate: &Path) -> CoreResult<PathBuf> {
    let root_norm = normalize(root);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root_norm.join(candidate)
    };
    let normalized = normalize(&joined);

    if !normalized.starts_with(&root_norm) {
        return Err(CoreError::Forbidden(format!(
            "路径越界：{}",
            candidate.display()
        )));
    }

    // 已存在的路径：再做一次 realpath 校验，挡住 symlink 指向外部
    if normalized.exists() {
        let real_root = std::fs::canonicalize(&root_norm).unwrap_or_else(|_| root_norm.clone());
        let real = std::fs::canonicalize(&normalized)
            .map_err(|_| CoreError::Forbidden(format!("路径无法解析：{}", candidate.display())))?;
        if !real.starts_with(&real_root) {
            return Err(CoreError::Forbidden(format!(
                "路径越界（符号链接）：{}",
                candidate.display()
            )));
        }
        return Ok(real);
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_children_and_relative_paths() {
        let root = Path::new("/data/docs");
        assert_eq!(
            assert_inside(root, Path::new("/data/docs/a/b.md")).unwrap(),
            PathBuf::from("/data/docs/a/b.md")
        );
        assert_eq!(
            assert_inside(root, Path::new("a/b.md")).unwrap(),
            PathBuf::from("/data/docs/a/b.md")
        );
        // 待创建的多级文件（不存在）也应通过
        assert_eq!(
            assert_inside(root, Path::new("x/y/z.md")).unwrap(),
            PathBuf::from("/data/docs/x/y/z.md")
        );
    }

    #[test]
    fn rejects_parent_escape() {
        let root = Path::new("/data/docs");
        for bad in [
            "../secret",
            "a/../../secret",
            "/etc/passwd",
            "/data/docs/../x",
        ] {
            assert!(assert_inside(root, Path::new(bad)).is_err(), "应拒绝 {bad}");
        }
    }

    #[test]
    fn rejects_sibling_prefix_lookalike() {
        // /data/docs-evil 不是 /data/docs 的子路径
        assert!(assert_inside(Path::new("/data/docs"), Path::new("/data/docs-evil/a.md")).is_err());
    }

    #[test]
    fn normalizes_redundant_segments() {
        let root = Path::new("/data/docs");
        assert_eq!(
            assert_inside(root, Path::new("./a/./b/../c.md")).unwrap(),
            PathBuf::from("/data/docs/a/c.md")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("docs");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), b"x").unwrap();
        symlink(&outside, root.join("link")).unwrap();

        // 词法上在 root 内，但 realpath 指向 root 外 → 必须拒绝
        let err = assert_inside(&root, Path::new("link/secret.md")).unwrap_err();
        assert_eq!(err.code(), "forbidden");

        // 正常的真实子路径仍可通过
        std::fs::write(root.join("ok.md"), b"y").unwrap();
        assert!(assert_inside(&root, Path::new("ok.md")).is_ok());
    }
}
