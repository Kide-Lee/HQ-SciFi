//! 本地文档服务（1.x `src/main/services/docs-service.ts` + `infra/fs` 的树扫描部分）。
//!
//! 这一层负责「目录树怎么长」「索引怎么跟着改名走」「选择目录后怎么落设置」，
//! 单个文件的读写细节在 [`crate::infra::fs`]。
//!
//! 关键行为对齐 1.x `readTree`：
//! - 只收目录与 `.md`（扩展名大小写不敏感），名字以 `.` 开头的一律跳过（`.image` 因此隐身）；
//! - 子目录递归，读失败吞掉当空目录（1.x 的 `try/catch → []`）；
//! - 展示用 `rel` 统一用 `/` 分隔；
//! - 目录在前，同类按名字排序（1.x 用 ICU 中文排序，内核去掉了这条依赖，见报告偏差）。

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::domain::article::ArticleRow;
use crate::infra::fs;
use crate::ports::FileStore;
use crate::{CoreCtx, CoreError, CoreResult};

/// 本地文档树节点（对应 1.x `src/shared/domain/index.ts` 的 `LocalNode`）。
///
/// 目录节点带 `children`（可能为空数组），文件节点带 `mtime`/`words`/`summary`；
/// 不需要的字段直接不序列化（TS 侧是可选属性）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalNode {
    /// 文件/目录名（不含路径）。
    pub name: String,
    /// 绝对路径（与索引 `filePath` 同一口径，用于读写）。
    pub path: String,
    /// 相对 docs 根的路径，`/` 分隔。
    pub rel: String,
    /// 是否目录。
    pub is_dir: bool,
    /// 子节点（仅目录，读失败时为空数组）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LocalNode>>,
    /// 修改时间（毫秒，仅文件）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
    /// 字数（仅文件，去空白后的 UTF-16 码元数）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<usize>,
    /// 摘要（仅文件，1.x `summarize` 的截断规则）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 本地文档树（1.x `listLocalDocs`）：确保根存在后全深度扫描。
pub fn list_local_docs(ctx: &CoreCtx) -> CoreResult<Vec<LocalNode>> {
    let root = fs::ensure_docs_root(ctx.files.as_ref(), &ctx.paths, &ctx.db)?;
    read_tree(ctx.files.as_ref(), &root, usize::MAX, &root)
}

/// 递归扫描目录（1.x `readTree(dir, depth, root)`）。
///
/// `depth` 是本层还能往下走几层（`usize::MAX` = 无限深）。顶层 `list` 失败会向上抛，
/// 子目录失败按 1.x 吞成空数组。
pub fn read_tree(
    files: &dyn FileStore,
    dir: &Path,
    depth: usize,
    root: &Path,
) -> CoreResult<Vec<LocalNode>> {
    let entries = files.list(dir)?;
    let mut nodes = Vec::new();
    for entry in entries {
        if entry.name.starts_with('.') {
            continue;
        }
        let is_md = entry.name.to_lowercase().ends_with(".md");
        if !entry.is_dir && !is_md {
            continue;
        }
        let mut node = LocalNode {
            name: entry.name.clone(),
            path: fs::path_string(&entry.path),
            rel: relative_slash(root, &entry.path),
            is_dir: entry.is_dir,
            children: None,
            mtime: None,
            words: None,
            summary: None,
        };
        if entry.is_dir {
            if depth > 0 {
                // 1.x: 子目录读失败当作空目录，不让一个坏目录拖垮整棵树
                node.children =
                    Some(read_tree(files, &entry.path, depth - 1, root).unwrap_or_default());
            }
        } else {
            // 文件：mtime 取目录项里已带的（1.x 的 statSync）；内容读得到才算摘要/字数
            node.mtime = Some(entry.modified_ms);
            if let Ok(bytes) = files.read(&entry.path) {
                let text = String::from_utf8_lossy(&bytes);
                let (summary, words) = fs::summarize(&text);
                node.words = Some(words);
                node.summary = Some(summary);
            }
        }
        nodes.push(node);
    }
    sort_nodes(&mut nodes);
    Ok(nodes)
}

/// 1.x 排序：目录在前；同类按名字，中文用 `localeCompare(…, 'zh')`。
///
/// 内核不引 ICU：改为「大小写不敏感字典序 + 原名兜底」，对 ASCII 名字与 1.x 完全一致，
/// 对中文是稳定但非拼音序（已在报告登记为偏差）。
fn sort_nodes(nodes: &mut [LocalNode]) {
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// 相对路径转 `/` 分隔（1.x `relative(root, abs).split(sep).join('/')`）。
fn relative_slash(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// 文章索引（1.x `listArticles` + handler 里的「文件已不存在就把 filePath 置空」）。
///
/// 置空而不是删行：文章还在库里，只是本地编辑入口暂时不可用。
pub fn list_articles(ctx: &CoreCtx) -> CoreResult<Vec<ArticleRow>> {
    let mut rows = ctx.db.list_articles(None)?;
    for row in &mut rows {
        if !row.file_path.is_empty() && !ctx.files.exists(Path::new(&row.file_path)) {
            row.file_path.clear();
        }
    }
    Ok(rows)
}

/// 打开存档目录（1.x `open-docs-dir` handler：先确保目录存在，再交给系统）。
pub fn open_docs_dir(ctx: &CoreCtx) -> CoreResult<()> {
    let root = fs::ensure_docs_root(ctx.files.as_ref(), &ctx.paths, &ctx.db)?;
    ctx.platform.launcher.open_path(&root)
}

/// 让用户选存档目录（1.x `chooseDocsDir`）：取消返回 `None`；选中则落设置并建目录。
pub fn choose_docs_dir(ctx: &CoreCtx) -> CoreResult<Option<String>> {
    let current = fs::docs_root(&ctx.paths, &ctx.db)?;
    let picked = ctx
        .platform
        .dialog
        .pick_directory("选择本地存档目录", Some(&current))?;
    let Some(dir) = picked else {
        return Ok(None);
    };
    fs::set_docs_root(&ctx.db, &dir)?;
    // 1.x 选完立刻 ensureDocsRoot：用户挑到不存在的目录也能用
    fs::ensure_docs_root(ctx.files.as_ref(), &ctx.paths, &ctx.db)?;
    Ok(Some(fs::path_string(&dir)))
}

/// 重命名/移动本地节点（1.x `renameLocalNode`），并把索引与 `.image` 图片目录一起搬。
///
/// 返回 `(from, to)` 两个绝对路径（词法归一，不解析 symlink）。
pub fn rename_local_node(
    ctx: &CoreCtx,
    old_rel: &str,
    new_rel: &str,
) -> CoreResult<(String, String)> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    let from = fs::assert_inside(&root, &root.join(old_rel))?;
    let to = fs::assert_inside(&root, &root.join(new_rel))?;
    let from_str = fs::path_string(&from);
    let to_str = fs::path_string(&to);

    // 1.x：同名（含同一路径的不同写法）直接返回，不校验存在性
    if from == to {
        return Ok((from_str, to_str));
    }
    if !ctx.files.exists(&from) {
        return Err(CoreError::app("源路径不存在"));
    }
    if ctx.files.exists(&to) {
        return Err(CoreError::app("目标路径已存在"));
    }

    let is_dir = ctx.files.metadata(&from)?.is_dir;
    ctx.files.rename(&from, &to)?;

    // 索引里的 filePath 跟着搬：目录搬则整棵子树一起改，文件搬只改它自己
    let now_ms = ctx.clock.now_ms();
    let sep = std::path::MAIN_SEPARATOR;
    for row in ctx.db.list_articles(None)? {
        if row.file_path.is_empty() {
            continue;
        }
        let new_file_path = if is_dir {
            if row.file_path == from_str {
                Some(to_str.clone())
            } else {
                // 1.x 字符串前缀 + slice：保留原先的子路径与分隔符风格
                row.file_path
                    .strip_prefix(&format!("{from_str}{sep}"))
                    .map(|tail| format!("{to_str}{sep}{tail}"))
            }
        } else if row.file_path == from_str {
            Some(to_str.clone())
        } else {
            None
        };
        if let Some(new_path) = new_file_path {
            ctx.db
                .update_article_by_file_path(&row.file_path, now_ms, |a| a.file_path = new_path)?;
        }
    }

    // 文件改名顺带搬配图目录：`.image/<旧主名>` → `.image/<新主名>`（cid 命名的目录不动）
    if !is_dir {
        let old_stem = file_stem(&from);
        let new_stem = file_stem(&to);
        if old_stem != new_stem {
            let old_img = fs::image_dir_for(&root, &old_stem);
            let new_img = fs::image_dir_for(&root, &new_stem);
            if ctx.files.exists(&old_img) && !ctx.files.exists(&new_img) {
                ctx.files.rename(&old_img, &new_img)?;
            }
        }
    }

    Ok((from_str, to_str))
}

/// 1.x `basename(p, extname(p))`：`a.b.md` → `a.b`。
fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::article::ArticleType;
    use crate::ports::{AppPaths, DirEntry, FileMeta};
    use crate::testkit::{
        FixedClock, Harness, MemSecrets, RecordingEvents, ScriptedHttp, db, platform,
    };
    use std::path::PathBuf;
    use std::sync::Arc;

    /// 真磁盘版 `FileStore`：`MemFiles.list()` 看不到子目录，递归扫描只能用真临时目录测。
    /// 仅测试使用（生产代码一律走 `ctx.files` 端口）。
    struct DiskFiles;

    impl FileStore for DiskFiles {
        fn read(&self, path: &Path) -> CoreResult<Vec<u8>> {
            Ok(std::fs::read(path)?)
        }
        fn write(&self, path: &Path, data: &[u8]) -> CoreResult<()> {
            Ok(std::fs::write(path, data)?)
        }
        fn remove_file(&self, path: &Path) -> CoreResult<()> {
            Ok(std::fs::remove_file(path)?)
        }
        fn remove_dir_all(&self, path: &Path) -> CoreResult<()> {
            Ok(std::fs::remove_dir_all(path)?)
        }
        fn rename(&self, from: &Path, to: &Path) -> CoreResult<()> {
            Ok(std::fs::rename(from, to)?)
        }
        fn create_dir_all(&self, path: &Path) -> CoreResult<()> {
            Ok(std::fs::create_dir_all(path)?)
        }
        fn list(&self, dir: &Path) -> CoreResult<Vec<DirEntry>> {
            let mut out = Vec::new();
            for entry in std::fs::read_dir(dir)? {
                let entry = entry?;
                let meta = entry.metadata()?;
                out.push(DirEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path(),
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                    modified_ms: 0,
                });
            }
            Ok(out)
        }
        fn exists(&self, path: &Path) -> bool {
            path.exists()
        }
        fn metadata(&self, path: &Path) -> CoreResult<FileMeta> {
            let meta = std::fs::symlink_metadata(path)?;
            Ok(FileMeta {
                is_dir: meta.is_dir(),
                size: meta.len(),
                modified_ms: 0,
            })
        }
    }

    /// 用真临时目录搭一个 `CoreCtx`（docs 根指向该目录）。
    fn disk_ctx(root: &Path) -> Arc<CoreCtx> {
        let db = db();
        db.set_meta(fs::DOCS_ROOT_KEY, &fs::path_string(root))
            .unwrap();
        Arc::new(CoreCtx::new(
            Arc::new(DiskFiles),
            Arc::new(MemSecrets::new()),
            Arc::new(ScriptedHttp::new()),
            Arc::new(RecordingEvents::new()),
            Arc::new(FixedClock(1_700_000_000_000)),
            AppPaths {
                data_dir: PathBuf::from("/data"),
                resource_dir: PathBuf::from("/resources"),
                documents_dir: PathBuf::from("/documents"),
                test_mode: false,
            },
            db,
            platform(),
        ))
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn register_local_article(ctx: &CoreCtx, file_path: &str) {
        let mut row = ArticleRow::new("c1", ArticleType::Local, 1_700_000_000_000);
        row.file_path = file_path.to_string();
        ctx.db.upsert_article(&row).unwrap();
    }

    // ---------- 树扫描 ----------

    #[test]
    fn list_local_docs_puts_directories_first_and_sorts_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("a-dir")).unwrap();
        std::fs::create_dir_all(root.join("z-dir")).unwrap();
        write_file(root, "A.md", "# A\n正文");
        write_file(root, "b.md", "b");
        // 非 md 与隐藏文件都不进树
        write_file(root, "note.txt", "x");
        write_file(root, ".hidden.md", "x");
        write_file(root, ".image/pic.png", "png");

        let nodes = read_tree(&DiskFiles, root, usize::MAX, root).unwrap();
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["a-dir", "z-dir", "A.md", "b.md"]);
        assert!(nodes[0].is_dir);
        assert!(nodes[2].children.is_none());
    }

    #[test]
    fn read_tree_recurses_and_normalizes_rel_with_slashes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(root, "卷一/第一章.md", "第一章正文");

        let nodes = read_tree(&DiskFiles, root, usize::MAX, root).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].rel, "卷一");
        let children = nodes[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "第一章.md");
        assert_eq!(children[0].rel, "卷一/第一章.md");
        assert_eq!(children[0].summary.as_deref(), Some("第一章正文"));
        assert_eq!(children[0].mtime, Some(0));
    }

    #[test]
    fn read_tree_marks_file_words_and_summary() {
        let tmp = tempfile::tempdir().unwrap();
        write_file(tmp.path(), "a.md", "# 标题\n\n第一段");
        let nodes = read_tree(&DiskFiles, tmp.path(), usize::MAX, tmp.path()).unwrap();
        // 字数含 `#` 与标题文字，只去空白："#"+"标题"+"第一段" = 1+2+3
        assert_eq!(nodes[0].words, Some(6));
        assert_eq!(nodes[0].summary.as_deref(), Some("第一段"));
    }

    #[test]
    fn read_tree_depth_limit_stops_recursion() {
        let tmp = tempfile::tempdir().unwrap();
        write_file(tmp.path(), "a/b/c.md", "深");
        let nodes = read_tree(&DiskFiles, tmp.path(), 0, tmp.path()).unwrap();
        assert_eq!(nodes[0].name, "a");
        // depth=0：不展开子目录，children 保持缺省（1.x 只有 depth>0 才赋值）
        assert!(nodes[0].children.is_none());
    }

    // ---------- list-local-docs ----------

    #[test]
    fn list_local_docs_creates_root_when_missing() {
        let h = Harness::new();
        let nodes = list_local_docs(h.ctx()).unwrap();
        assert!(nodes.is_empty());
        assert!(
            h.files
                .exists(&h.ctx.paths.documents_dir.join("荒启科幻").join("草稿"))
        );
    }

    #[test]
    fn list_local_docs_lists_flat_files_from_memory_store() {
        let h = Harness::new();
        h.files
            .write(Path::new("/documents/荒启科幻/草稿/b.md"), b"b")
            .unwrap();
        h.files
            .write(Path::new("/documents/荒启科幻/草稿/a.md"), b"a")
            .unwrap();

        let nodes = list_local_docs(h.ctx()).unwrap();
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["a.md", "b.md"]);
        assert_eq!(nodes[0].path, "/documents/荒启科幻/草稿/a.md");
        assert_eq!(nodes[0].rel, "a.md");
    }

    // ---------- list-articles ----------

    #[test]
    fn list_articles_clears_file_path_when_file_is_gone() {
        let h = Harness::new();
        let existing = "/documents/荒启科幻/草稿/在.md";
        h.files.write(Path::new(existing), b"x").unwrap();
        register_local_article(h.ctx(), existing);
        let mut missing = ArticleRow::new("c2", ArticleType::Local, 1_700_000_000_001);
        missing.file_path = "/documents/荒启科幻/草稿/没了.md".into();
        h.ctx.db.upsert_article(&missing).unwrap();
        let mut unlinked = ArticleRow::new("c3", ArticleType::Local, 1_700_000_000_002);
        unlinked.file_path = String::new();
        h.ctx.db.upsert_article(&unlinked).unwrap();

        let rows = list_articles(h.ctx()).unwrap();
        let by_cid = |cid: &str| rows.iter().find(|r| r.cid == cid).unwrap();
        // 文件还在：路径原样
        assert_eq!(by_cid("c1").file_path, existing);
        // 文件没了：置空（不是删行）
        assert!(by_cid("c2").file_path.is_empty());
        // 本来就没绑定文件的：保持空
        assert!(by_cid("c3").file_path.is_empty());
        assert_eq!(rows.len(), 3);
    }

    // ---------- 打开/选择目录 ----------

    #[test]
    fn open_docs_dir_creates_root_and_hands_it_to_launcher() {
        let h = Harness::new();
        open_docs_dir(h.ctx()).unwrap();
        let root = h.ctx.paths.documents_dir.join("荒启科幻").join("草稿");
        assert!(h.files.exists(&root));
        assert_eq!(h.launcher.opened_paths.lock().unwrap().as_slice(), &[root]);
    }

    #[test]
    fn choose_docs_dir_cancel_returns_none_and_keeps_settings() {
        let h = Harness::new();
        *h.dialog.picked_dir.lock().unwrap() = None;
        assert_eq!(choose_docs_dir(h.ctx()).unwrap(), None);
        // 取消不改设置：仍是默认根
        assert_eq!(
            fs::docs_root(&h.ctx.paths, &h.ctx.db).unwrap(),
            fs::default_docs_root(&h.ctx.paths)
        );
    }

    #[test]
    fn choose_docs_dir_persists_pick_and_creates_directory() {
        let h = Harness::new();
        let picked = PathBuf::from("/documents/自定义存档");
        *h.dialog.picked_dir.lock().unwrap() = Some(picked.clone());

        let out = choose_docs_dir(h.ctx()).unwrap();
        assert_eq!(out.as_deref(), Some("/documents/自定义存档"));
        assert_eq!(fs::docs_root(&h.ctx.paths, &h.ctx.db).unwrap(), picked);
        assert!(h.files.exists(&picked));
    }

    // ---------- rename-local-node ----------

    #[test]
    fn rename_missing_source_reports_1x_message() {
        let h = Harness::new();
        let err = rename_local_node(h.ctx(), "没有.md", "新.md").unwrap_err();
        assert_eq!(err.to_string(), "源路径不存在");
    }

    #[test]
    fn rename_onto_existing_target_reports_1x_message() {
        let h = Harness::new();
        let root = h.ctx.paths.documents_dir.join("荒启科幻").join("草稿");
        h.files.write(&root.join("旧.md"), b"x").unwrap();
        h.files.write(&root.join("新.md"), b"x").unwrap();

        let err = rename_local_node(h.ctx(), "旧.md", "新.md").unwrap_err();
        assert_eq!(err.to_string(), "目标路径已存在");
    }

    #[test]
    fn rename_same_path_is_a_noop_even_when_missing() {
        let h = Harness::new();
        // 1.x：from === to 在存在性校验之前直接返回
        let (from, to) = rename_local_node(h.ctx(), "无.md", "无.md").unwrap();
        assert!(from.ends_with("无.md"));
        assert_eq!(from, to);
    }

    #[test]
    fn rename_rejects_traversal_paths() {
        let h = Harness::new();
        let err = rename_local_node(h.ctx(), "../外面.md", "新.md").unwrap_err();
        assert_eq!(err.to_string(), fs::MSG_PATH_ESCAPE);
    }

    #[test]
    fn rename_file_moves_it_and_updates_index() {
        let h = Harness::new();
        let root = h.ctx.paths.documents_dir.join("荒启科幻").join("草稿");
        h.files
            .write(&root.join("旧.md"), "正文".as_bytes())
            .unwrap();
        let old_path = fs::path_string(&root.join("旧.md"));
        register_local_article(h.ctx(), &old_path);

        let (from, to) = rename_local_node(h.ctx(), "旧.md", "新.md").unwrap();
        assert_eq!(from, old_path);
        assert_eq!(to, fs::path_string(&root.join("新.md")));
        assert!(!h.files.exists(&root.join("旧.md")));
        assert!(h.files.exists(&root.join("新.md")));

        let row = h.ctx.db.get_article_by_cid("c1").unwrap().unwrap();
        assert_eq!(row.file_path, to);
    }

    #[test]
    fn rename_file_moves_matching_image_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(root, "旧.md", "正文");
        write_file(root, ".image/旧/1.png", "png");
        let ctx = disk_ctx(root);
        register_local_article(&ctx, &fs::path_string(&root.join("旧.md")));

        rename_local_node(&ctx, "旧.md", "新.md").unwrap();
        assert!(!root.join(".image/旧").exists());
        assert_eq!(
            std::fs::read_to_string(root.join(".image/新/1.png")).unwrap(),
            "png"
        );
    }

    #[test]
    fn rename_directory_moves_subtree_and_updates_index_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(root, "卷一/第一章.md", "# 第一章");
        let ctx = disk_ctx(root);
        let old_file = fs::path_string(&root.join("卷一").join("第一章.md"));
        register_local_article(&ctx, &old_file);

        let (from, to) = rename_local_node(&ctx, "卷一", "卷二").unwrap();
        assert_eq!(from, fs::path_string(&root.join("卷一")));
        assert_eq!(to, fs::path_string(&root.join("卷二")));
        assert!(root.join("卷二/第一章.md").exists());
        assert!(!root.join("卷一").exists());

        let row = ctx.db.get_article_by_cid("c1").unwrap().unwrap();
        assert_eq!(
            row.file_path,
            fs::path_string(&root.join("卷二").join("第一章.md"))
        );
    }
}
