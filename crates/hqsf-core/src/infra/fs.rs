//! 本地存档文件系统（1.x `src/main/infra/fs/index.ts` 的 Rust 版）。
//!
//! 职责：
//! - docs 根：默认值 `<documents>/荒启科幻/草稿`（测试模式加 `-test`）、读写（存 SQLite
//!   `meta` 表的 `docs_root`，key 与 1.x 相同，切换版本不丢设置）、确保存在；
//! - 路径沙箱 [`assert_inside`]：逐字保留 1.x 的两条越界文案，词法层自己判、symlink 层
//!   委托 [`crate::infra::sandbox::assert_inside`]；
//! - 纯助手：文件名清理、重名序号、`.image` 图片目录、标题、摘要/字数；
//! - 文件操作：md 读写、建目录、删除（回收站）、草稿创建、在文件管理器中显示。
//!
//! 与 1.x 的唯一结构性差异：所有文件 IO 走 [`FileStore`] 端口（1.x 直接 `node:fs`），
//! 打开目录/回收站走 [`Launcher`]；这样内核可单测，Android 端换 SAF 实现即可复用。

use std::path::{Component, Path, PathBuf};

use crate::infra::db::Db;
use crate::infra::sandbox;
use crate::ports::{AppPaths, FileStore, Launcher};
use crate::{CoreError, CoreResult};

/// docs 根在 SQLite `meta` 表里的 key（与 1.x `DOCS_ROOT_KEY` 相同）。
pub const DOCS_ROOT_KEY: &str = "docs_root";

/// 图片目录（隐藏目录，存放文章配图；本地文档树里被过滤）。
pub const IMAGE_DIR: &str = ".image";

/// 文件名清理后的兜底名（1.x `sanitizeFileName` 的 `cleaned || '未命名'`）。
pub const UNNAMED_FILE: &str = "未命名";

/// 文件名最大长度（1.x `.slice(0, 60)`，按 UTF-16 码元计）。
pub const FILE_NAME_MAX_UNITS: usize = 60;

/// 摘要最大长度（1.x `text.slice(0, 100)`，按 UTF-16 码元计）。
pub const SUMMARY_MAX_UNITS: usize = 100;

/// 越界文案（1.x `assertInside` 逐字，渲染层/测试按原文断言）。
pub const MSG_PATH_ESCAPE: &str = "路径越界：仅允许访问本地存档目录";
/// 符号链接越界文案（1.x 逐字）。
pub const MSG_SYMLINK_ESCAPE: &str = "路径越界：符号链接指向存档目录之外";
/// 文件不存在（1.x `readLocalFile` / `revealLocalFile` 逐字）。
pub const MSG_FILE_MISSING: &str = "文件不存在";
/// 目标被同名文件占位（1.x `createLocalDir` 逐字）。
pub const MSG_FILE_NAME_TAKEN: &str = "同名文件已存在";
/// 删除目录（1.x `deleteLocalFile` 逐字）。
pub const MSG_CANNOT_DELETE_DIR: &str = "不能删除目录，仅支持删除文章文件";

// ---------- docs 根 ----------

/// 默认存档根：`<documents>/荒启科幻/草稿`，测试模式再加 `-test` 后缀（1.x `defaultDocsRoot`）。
///
/// 文档目录与测试标记都由壳层注入 [`AppPaths`]，内核不问操作系统。
pub fn default_docs_root(paths: &AppPaths) -> PathBuf {
    let base = paths.documents_dir.join("荒启科幻").join("草稿");
    if paths.test_mode {
        // 1.x 是字符串拼 `${base}-test`；用 OsString 拼，避免把路径当 UTF-8 字符串处理
        let mut suffixed = base.into_os_string();
        suffixed.push("-test");
        PathBuf::from(suffixed)
    } else {
        base
    }
}

/// 当前存档根：`meta.docs_root` 优先，否则默认值（1.x `getDocsRoot`）。
pub fn docs_root(paths: &AppPaths, db: &Db) -> CoreResult<PathBuf> {
    Ok(match db.get_meta(DOCS_ROOT_KEY)? {
        // 1.x 用 `||`：空串同样回退默认值
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => default_docs_root(paths),
    })
}

/// 记住用户选择的存档根（1.x `setDocsRoot`：只写 `meta`，不建目录）。
pub fn set_docs_root(db: &Db, dir: &Path) -> CoreResult<()> {
    db.set_meta(DOCS_ROOT_KEY, &path_string(dir))
}

/// 取根并递归创建（1.x `ensureDocsRoot`）。
pub fn ensure_docs_root(files: &dyn FileStore, paths: &AppPaths, db: &Db) -> CoreResult<PathBuf> {
    let root = docs_root(paths, db)?;
    files.create_dir_all(&root)?;
    Ok(root)
}

/// 路径 → 线上字符串（Windows 下是反斜杠，与 1.x 的 `path.join` 输出一致）。
pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---------- 路径沙箱 ----------

/// 词法归一：消 `.`、折叠 `..`（不触碰文件系统）。与 `infra::sandbox` 内部实现同语义。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // 退无可退时保留 `..`，让后续 starts_with 判定失败
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 1.x `assertInside` 的等价物：校验 `candidate`（绝对路径或相对 docs 根）落在 `root` 内。
///
/// 分两步，与 1.x 一致：
/// 1. 词法层（resolve 后）越界 → [`MSG_PATH_ESCAPE`]；
/// 2. symlink 层：委托 [`sandbox::assert_inside`]（已存在路径会做 realpath 比对），
///    任何越界统一映射成 [`MSG_SYMLINK_ESCAPE`]。
///
/// 返回值是**词法归一后的路径**而不是 realpath——1.x 同样返回 `resolve(p)`，
/// 后续读写仍走原路径（这样渲染层拿到的 `filePath` 与索引里存的一致）。
pub fn assert_inside(root: &Path, candidate: &Path) -> CoreResult<PathBuf> {
    let root_lexical = normalize(root);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root_lexical.join(candidate)
    };
    let target = normalize(&joined);

    // 1.x: `if (f !== r && !f.startsWith(r + sep))`。`Path::starts_with` 按组件比较，
    // 天然排除 `/data/docs-evil` 这类同前缀兄弟目录，且 `target == root` 时返回 true。
    if !target.starts_with(&root_lexical) {
        return Err(CoreError::app(MSG_PATH_ESCAPE));
    }

    match sandbox::assert_inside(&root_lexical, &target) {
        Ok(_) => Ok(target),
        // sandbox 的 Forbidden 覆盖「symlink 指向根外」与「无法解析」，1.x 都归为第二条文案
        Err(CoreError::Forbidden(_)) => Err(CoreError::app(MSG_SYMLINK_ESCAPE)),
        Err(err) => Err(err),
    }
}

// ---------- 纯助手 ----------

/// UTF-16 码元长度（JS 字符串 `.length` 的语义，摘要/字数按它截断）。
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// 按 UTF-16 码元截断（不切断代理对——1.x `slice` 可能切出孤立代理项，这里取合法前缀）。
fn truncate_utf16(s: &str, max_units: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max_units));
    let mut units = 0;
    for ch in s.chars() {
        let n = ch.len_utf16();
        if units + n > max_units {
            break;
        }
        units += n;
        out.push(ch);
    }
    out
}

/// JS `\s` 的近似：Unicode 空白 + `U+FEFF`（Rust `is_whitespace` 不含 BOM）。
fn is_js_whitespace(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{FEFF}'
}

/// 文件名非法字符（1.x `/[\\/:*?"<>|\n\r\t]/g`）。
fn is_invalid_file_char(ch: char) -> bool {
    matches!(
        ch,
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t'
    )
}

/// 文件名清理（1.x `sanitizeFileName`）：非法字符与空白折叠成单空格、trim、截 60 码元，
/// 空则 [`UNNAMED_FILE`]。
pub fn sanitize_file_name(name: &str) -> String {
    let mut cleaned = String::with_capacity(name.len());
    let mut pending_space = false;
    for ch in name.chars() {
        if is_invalid_file_char(ch) || is_js_whitespace(ch) {
            // 非法字符等价于空白：连续多个（混排也一样）最后只留一个空格
            pending_space = true;
            continue;
        }
        if pending_space && !cleaned.is_empty() {
            cleaned.push(' ');
        }
        pending_space = false;
        cleaned.push(ch);
    }
    let cleaned = truncate_utf16(cleaned.trim_end(), FILE_NAME_MAX_UNITS);
    if cleaned.is_empty() {
        UNNAMED_FILE.to_string()
    } else {
        cleaned
    }
}

/// 生成不重名的文件路径（1.x `uniqueFilePath`）：`标题.md`，已被占用则追加 ` (1)`、` (2)`…
pub fn unique_file_path(files: &dyn FileStore, dir: &Path, title: &str, ext: &str) -> PathBuf {
    let safe = sanitize_file_name(title);
    let mut candidate = dir.join(format!("{safe}{ext}"));
    let mut index = 1_u32;
    while files.exists(&candidate) {
        candidate = dir.join(format!("{safe} ({index}){ext}"));
        index += 1;
    }
    candidate
}

/// 从文件路径取标题（1.x `titleFromPath`：去 `.md` 后缀，大小写不敏感）。
pub fn title_from_path(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if name.to_lowercase().ends_with(".md") {
        // `.md` 是 ASCII，截掉末尾 3 字节不会切坏多字节字符
        name[..name.len() - 3].to_string()
    } else {
        name
    }
}

/// 图片目录相对路径：`.image/<sanitize(cid 或文件名)>`（1.x `imageDirName`）。
pub fn image_dir_name(cid_or_name: &str) -> PathBuf {
    Path::new(IMAGE_DIR).join(sanitize_file_name(cid_or_name))
}

/// 图片目录绝对路径（1.x `imageDirFor`）。
pub fn image_dir_for(root: &Path, cid_or_name: &str) -> PathBuf {
    root.join(image_dir_name(cid_or_name))
}

/// 摘要与字数（1.x `summarize`）：
/// - 摘要：逐行 trim，去掉空行与 `#` 开头的标题行，空格连接，取前 100 码元，超长加 `…`；
/// - 字数：去掉所有空白后按 UTF-16 码元计数（JS `String.length` 语义，含标题文字）。
pub fn summarize(content: &str) -> (String, usize) {
    let text = content
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.trim();

    let mut summary = truncate_utf16(text, SUMMARY_MAX_UNITS);
    if utf16_len(text) > SUMMARY_MAX_UNITS {
        summary.push('…');
    }
    let words = content
        .chars()
        .filter(|ch| !is_js_whitespace(*ch))
        .map(char::len_utf16)
        .sum();
    (summary, words)
}

// ---------- 文件操作 ----------

/// 读本地 md（1.x `readLocalFile`）：越界抛越界文案，不存在抛「文件不存在」。
/// 解码用替换字符（等价 Node `readFileSync(..., 'utf8')` 对非法字节的处理）。
pub fn read_local_file(files: &dyn FileStore, root: &Path, path: &str) -> CoreResult<String> {
    let abs = assert_inside(root, Path::new(path))?;
    if !files.exists(&abs) {
        return Err(CoreError::app(MSG_FILE_MISSING));
    }
    let bytes = files.read(&abs)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 写本地 md（1.x `writeLocalFile`）：先校验越界，再自动建父目录。
pub fn write_local_file(
    files: &dyn FileStore,
    root: &Path,
    path: &str,
    content: &str,
) -> CoreResult<()> {
    let abs = assert_inside(root, Path::new(path))?;
    if let Some(parent) = abs.parent() {
        files.create_dir_all(parent)?;
    }
    files.write(&abs, content.as_bytes())
}

/// 新建文件夹（1.x `createLocalDir`）：已存在且是目录时幂等返回，被同名文件占位则报错。
pub fn create_local_dir(files: &dyn FileStore, root: &Path, rel: &str) -> CoreResult<String> {
    let abs = assert_inside(root, &root.join(rel))?;
    if files.exists(&abs) {
        let meta = files.metadata(&abs)?;
        if !meta.is_dir {
            return Err(CoreError::app(MSG_FILE_NAME_TAKEN));
        }
        return Ok(path_string(&abs));
    }
    files.create_dir_all(&abs)?;
    Ok(path_string(&abs))
}

/// 删除本地文件（1.x `deleteLocalFile`）：不存在视为成功；目录拒绝；文件移入回收站。
pub fn delete_local_file(
    files: &dyn FileStore,
    launcher: &dyn Launcher,
    root: &Path,
    path: &str,
) -> CoreResult<()> {
    let abs = assert_inside(root, Path::new(path))?;
    if !files.exists(&abs) {
        return Ok(());
    }
    let meta = files.metadata(&abs)?;
    if meta.is_dir {
        return Err(CoreError::app(MSG_CANNOT_DELETE_DIR));
    }
    launcher.trash(&abs)
}

/// 在系统文件管理器中显示（1.x `revealLocalFile`）：不存在抛「文件不存在」。
pub fn reveal_local_file(
    files: &dyn FileStore,
    launcher: &dyn Launcher,
    root: &Path,
    path: &str,
) -> CoreResult<()> {
    let abs = assert_inside(root, Path::new(path))?;
    if !files.exists(&abs) {
        return Err(CoreError::app(MSG_FILE_MISSING));
    }
    launcher.reveal_in_folder(&abs)
}

/// 新建本地草稿（1.x `createLocalDraft`）：`<root>/[dirRel/]标题.md`，重名自动追加序号；
/// 内容**原样写入**（v0.0.6 起不再生成/写 frontmatter 模板，frontmatter 只在读时由 L5 解析）。
///
/// 1.x 对 `dirRel` 只 `join` 不校验；这里补一次 [`assert_inside`]（安全加固，行为见报告）。
pub fn create_local_draft(
    files: &dyn FileStore,
    root: &Path,
    title: &str,
    content: &str,
    dir_rel: &str,
) -> CoreResult<String> {
    let dir = if dir_rel.is_empty() {
        root.to_path_buf()
    } else {
        assert_inside(root, &root.join(dir_rel))?
    };
    let abs = unique_file_path(files, &dir, title, ".md");
    files.write(&abs, content.as_bytes())?;
    Ok(path_string(&abs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{MemFiles, RecordingLauncher};
    use std::sync::Arc;

    fn paths() -> AppPaths {
        AppPaths {
            data_dir: PathBuf::from("/data"),
            resource_dir: PathBuf::from("/resources"),
            documents_dir: PathBuf::from("/home/u/文档"),
            test_mode: false,
        }
    }

    fn mem_files() -> Arc<MemFiles> {
        Arc::new(MemFiles::new())
    }

    // ---------- docs 根 ----------

    #[test]
    fn default_docs_root_joins_documents_dir() {
        assert_eq!(
            default_docs_root(&paths()),
            PathBuf::from("/home/u/文档/荒启科幻/草稿")
        );
    }

    #[test]
    fn default_docs_root_gets_test_suffix_in_test_mode() {
        let mut p = paths();
        p.test_mode = true;
        assert_eq!(
            default_docs_root(&p),
            PathBuf::from("/home/u/文档/荒启科幻/草稿-test")
        );
    }

    #[test]
    fn docs_root_prefers_meta_and_falls_back_to_default() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(
            docs_root(&paths(), &db).unwrap(),
            default_docs_root(&paths())
        );

        set_docs_root(&db, Path::new("/custom/草稿")).unwrap();
        assert_eq!(
            docs_root(&paths(), &db).unwrap(),
            PathBuf::from("/custom/草稿")
        );

        // 1.x 用 `||`：空串同样回退默认值
        db.set_meta(DOCS_ROOT_KEY, "").unwrap();
        assert_eq!(
            docs_root(&paths(), &db).unwrap(),
            default_docs_root(&paths())
        );
    }

    #[test]
    fn ensure_docs_root_creates_directory() {
        let files = mem_files();
        let db = Db::open_in_memory().unwrap();
        set_docs_root(&db, Path::new("/docs")).unwrap();

        let root = ensure_docs_root(files.as_ref(), &paths(), &db).unwrap();
        assert_eq!(root, PathBuf::from("/docs"));
        assert!(files.exists(Path::new("/docs")));
    }

    // ---------- 路径沙箱 ----------

    #[test]
    fn assert_inside_accepts_children_and_returns_lexical_path() {
        let root = Path::new("/data/docs");
        assert_eq!(
            assert_inside(root, Path::new("/data/docs/a/b.md")).unwrap(),
            PathBuf::from("/data/docs/a/b.md")
        );
        // 相对路径按 docs 根解释
        assert_eq!(
            assert_inside(root, Path::new("a/b.md")).unwrap(),
            PathBuf::from("/data/docs/a/b.md")
        );
        // 冗余段被归一（不触碰文件系统）
        assert_eq!(
            assert_inside(root, Path::new("./a/./b/../c.md")).unwrap(),
            PathBuf::from("/data/docs/a/c.md")
        );
        // 根自身允许
        assert_eq!(assert_inside(root, Path::new("/data/docs")).unwrap(), root);
    }

    #[test]
    fn assert_inside_rejects_parent_escape_with_1x_message() {
        let root = Path::new("/data/docs");
        for bad in [
            "../secret",
            "a/../../secret",
            "/etc/passwd",
            "/data/docs/../x",
        ] {
            let err = assert_inside(root, Path::new(bad)).unwrap_err();
            assert_eq!(err.to_string(), MSG_PATH_ESCAPE, "应拒绝 {bad}");
            assert_eq!(err.code(), "app");
        }
    }

    #[test]
    fn assert_inside_rejects_sibling_prefix_lookalike() {
        // /data/docs-evil 不是 /data/docs 的子路径（字符串前缀会误判）
        let err =
            assert_inside(Path::new("/data/docs"), Path::new("/data/docs-evil/a.md")).unwrap_err();
        assert_eq!(err.to_string(), MSG_PATH_ESCAPE);
    }

    #[cfg(unix)]
    #[test]
    fn assert_inside_rejects_symlink_escape_with_1x_message() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("docs");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        symlink(&outside, root.join("link")).unwrap();

        let err = assert_inside(&root, Path::new("link/secret.md")).unwrap_err();
        assert_eq!(err.to_string(), MSG_SYMLINK_ESCAPE);
        assert_eq!(err.code(), "app");

        // 指向根内的 symlink 仍然可用
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/ok.md"), "y").unwrap();
        symlink(root.join("sub"), root.join("inner")).unwrap();
        assert_eq!(
            assert_inside(&root, Path::new("inner/ok.md")).unwrap(),
            root.join("inner/ok.md")
        );
    }

    // ---------- 纯助手 ----------

    #[test]
    fn sanitize_file_name_replaces_invalid_chars_and_collapses_spaces() {
        assert_eq!(
            sanitize_file_name("a/b:c*d?e\"f<g>h|i\nj\rk\tl\\m"),
            "a b c d e f g h i j k l m"
        );
        assert_eq!(sanitize_file_name("  标题   草稿  "), "标题 草稿");
        assert_eq!(sanitize_file_name("  \n\t "), UNNAMED_FILE);
        assert_eq!(sanitize_file_name("《荒启》第 1 章"), "《荒启》第 1 章");
    }

    #[test]
    fn sanitize_file_name_truncates_to_600_utf16_units() {
        // 61 个汉字 → 截到 60
        assert_eq!(sanitize_file_name(&"字".repeat(61)).chars().count(), 60);
        // 40 个 emoji（每个 2 码元）→ 只能放 30 个，且不切代理对
        let emoji = sanitize_file_name(&"😀".repeat(40));
        assert_eq!(emoji, "😀".repeat(30));
        assert_eq!(utf16_len(&emoji), 60);
    }

    #[test]
    fn unique_file_path_appends_numeric_suffix() {
        let files = mem_files();
        files.create_dir_all(Path::new("/docs")).unwrap();
        files.write(Path::new("/docs/标题.md"), b"x").unwrap();
        files.write(Path::new("/docs/标题 (1).md"), b"x").unwrap();

        assert_eq!(
            unique_file_path(files.as_ref(), Path::new("/docs"), "标题", ".md"),
            PathBuf::from("/docs/标题 (2).md")
        );
        assert_eq!(
            unique_file_path(files.as_ref(), Path::new("/docs"), "新稿", ".md"),
            PathBuf::from("/docs/新稿.md")
        );
    }

    #[test]
    fn title_from_path_strips_md_case_insensitively() {
        assert_eq!(
            title_from_path(Path::new("/docs/我的 草稿.md")),
            "我的 草稿"
        );
        assert_eq!(title_from_path(Path::new("/docs/大 纲.MD")), "大 纲");
        assert_eq!(title_from_path(Path::new("/docs/notes.txt")), "notes.txt");
    }

    #[test]
    fn image_dir_helpers_use_hidden_directory() {
        assert_eq!(
            image_dir_name("abc123"),
            PathBuf::from(".image").join("abc123")
        );
        // cid/文件名都会被清理（防路径分隔符注入）
        assert_eq!(
            image_dir_name("a/b:c"),
            PathBuf::from(".image").join("a b c")
        );
        assert_eq!(
            image_dir_for(Path::new("/docs"), "abc123"),
            PathBuf::from("/docs/.image/abc123")
        );
    }

    #[test]
    fn summarize_skips_headings_and_counts_non_whitespace() {
        let (summary, words) = summarize("# 标题\n\n第一段\n第二段\n");
        assert_eq!(summary, "第一段 第二段");
        // 字数含 `#` 与标题文字、只去空白（1.x `content.replace(/\s/g,'').length`）
        assert_eq!(words, 1 + 2 + 3 + 3);
    }

    #[test]
    fn summarize_truncates_at_100_units_with_ellipsis() {
        let long = "字".repeat(150);
        let (summary, _) = summarize(&long);
        assert_eq!(utf16_len(&summary), 100 + 1);
        assert!(summary.ends_with('…'));

        let exact = "字".repeat(100);
        let (summary, _) = summarize(&exact);
        assert_eq!(summary, exact);
    }

    #[test]
    fn summarize_counts_astral_chars_as_two_units() {
        // JS `'😀'.length === 2`；字数统计必须同为 2
        let (_, words) = summarize("😀");
        assert_eq!(words, 2);
    }

    // ---------- 文件操作 ----------

    #[test]
    fn read_local_file_returns_content() {
        let files = mem_files();
        files.write(Path::new("/docs/a.md"), b"# T\n\nabc").unwrap();
        assert_eq!(
            read_local_file(files.as_ref(), Path::new("/docs"), "/docs/a.md").unwrap(),
            "# T\n\nabc"
        );
    }

    #[test]
    fn read_local_file_missing_and_escape_errors() {
        let files = mem_files();
        let err = read_local_file(files.as_ref(), Path::new("/docs"), "/docs/none.md").unwrap_err();
        assert_eq!(err.to_string(), MSG_FILE_MISSING);

        let err = read_local_file(files.as_ref(), Path::new("/docs"), "../etc/passwd").unwrap_err();
        assert_eq!(err.to_string(), MSG_PATH_ESCAPE);
    }

    #[test]
    fn write_local_file_creates_parent_directories() {
        let files = mem_files();
        write_local_file(
            files.as_ref(),
            Path::new("/docs"),
            "/docs/子目录/新.md",
            "正文",
        )
        .unwrap();
        assert!(files.exists(Path::new("/docs/子目录")));
        assert_eq!(
            files.read(Path::new("/docs/子目录/新.md")).unwrap(),
            "正文".as_bytes()
        );
    }

    #[test]
    fn write_local_file_rejects_traversal() {
        let files = mem_files();
        let err =
            write_local_file(files.as_ref(), Path::new("/docs"), "/etc/passwd", "x").unwrap_err();
        assert_eq!(err.to_string(), MSG_PATH_ESCAPE);
        assert!(files.snapshot().is_empty());
    }

    #[test]
    fn create_local_dir_is_idempotent_and_rejects_file_clash() {
        let files = mem_files();
        let created = create_local_dir(files.as_ref(), Path::new("/docs"), "小说").unwrap();
        assert_eq!(created, "/docs/小说");
        assert!(files.exists(Path::new("/docs/小说")));
        // 幂等：已存在的目录再建返回同一路径
        assert_eq!(
            create_local_dir(files.as_ref(), Path::new("/docs"), "小说").unwrap(),
            "/docs/小说"
        );

        files.write(Path::new("/docs/占位.md"), b"x").unwrap();
        let err = create_local_dir(files.as_ref(), Path::new("/docs"), "占位.md").unwrap_err();
        assert_eq!(err.to_string(), MSG_FILE_NAME_TAKEN);

        let err = create_local_dir(files.as_ref(), Path::new("/docs"), "../逃逸").unwrap_err();
        assert_eq!(err.to_string(), MSG_PATH_ESCAPE);
    }

    #[test]
    fn delete_local_file_trashes_and_ignores_missing() {
        let files = mem_files();
        let launcher = RecordingLauncher::new();
        files.write(Path::new("/docs/a.md"), b"x").unwrap();

        delete_local_file(files.as_ref(), &launcher, Path::new("/docs"), "/docs/a.md").unwrap();
        assert_eq!(
            launcher.trashed.lock().unwrap().as_slice(),
            &[PathBuf::from("/docs/a.md")]
        );
        // 1.x：不存在视为成功（早返回），不报错
        delete_local_file(
            files.as_ref(),
            &launcher,
            Path::new("/docs"),
            "/docs/none.md",
        )
        .unwrap();
        assert_eq!(launcher.trashed.lock().unwrap().len(), 1);
    }

    #[test]
    fn delete_local_file_refuses_directories() {
        let files = mem_files();
        let launcher = RecordingLauncher::new();
        files.create_dir_all(Path::new("/docs/子目录")).unwrap();

        let err = delete_local_file(
            files.as_ref(),
            &launcher,
            Path::new("/docs"),
            "/docs/子目录",
        )
        .unwrap_err();
        assert_eq!(err.to_string(), MSG_CANNOT_DELETE_DIR);
        assert!(launcher.trashed.lock().unwrap().is_empty());
    }

    #[test]
    fn reveal_local_file_reveals_existing_and_rejects_missing() {
        let files = mem_files();
        let launcher = RecordingLauncher::new();
        files.write(Path::new("/docs/a.md"), b"x").unwrap();

        reveal_local_file(files.as_ref(), &launcher, Path::new("/docs"), "/docs/a.md").unwrap();
        assert_eq!(
            launcher.revealed.lock().unwrap().as_slice(),
            &[PathBuf::from("/docs/a.md")]
        );

        let err = reveal_local_file(
            files.as_ref(),
            &launcher,
            Path::new("/docs"),
            "/docs/none.md",
        )
        .unwrap_err();
        assert_eq!(err.to_string(), MSG_FILE_MISSING);
    }

    #[test]
    fn create_local_draft_writes_content_verbatim_without_frontmatter() {
        let files = mem_files();
        let abs = create_local_draft(
            files.as_ref(),
            Path::new("/docs"),
            "我的草稿",
            "## 正文\n\n第一段",
            "",
        )
        .unwrap();
        assert_eq!(abs, "/docs/我的草稿.md");
        let body = files.read(Path::new("/docs/我的草稿.md")).unwrap();
        // v0.0.6：不生成 frontmatter 模板，内容原样落盘
        assert_eq!(body, "## 正文\n\n第一段".as_bytes());
        assert!(!String::from_utf8_lossy(&body).contains("---"));
    }

    #[test]
    fn create_local_draft_dedupes_and_supports_subdirectory() {
        let files = mem_files();
        files.write(Path::new("/docs/标题.md"), b"x").unwrap();
        let abs = create_local_draft(files.as_ref(), Path::new("/docs"), "标题", "", "").unwrap();
        assert_eq!(abs, "/docs/标题 (1).md");

        let sub =
            create_local_draft(files.as_ref(), Path::new("/docs"), "标题", "", "卷一").unwrap();
        assert_eq!(sub, "/docs/卷一/标题.md");
    }

    #[test]
    fn create_local_draft_rejects_traversal_dir_rel() {
        let files = mem_files();
        let err = create_local_draft(files.as_ref(), Path::new("/docs"), "标题", "", "../外面")
            .unwrap_err();
        assert_eq!(err.to_string(), MSG_PATH_ESCAPE);
        assert!(files.snapshot().is_empty());
    }
}
