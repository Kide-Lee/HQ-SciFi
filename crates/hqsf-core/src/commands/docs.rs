//! 本地文档/文件 IPC 通道（1.x `src/main/ipc/docs.handlers.ts`，13 条）。
//!
//! 这一层只做三件事：把壳层传来的具名参数转成内核调用、把结果转成 wire 类型、
//! 把 1.x handler 的兜底文案原样抛出。业务规则都在 [`crate::services::docs`] 与
//! [`crate::infra::fs`]。
//!
//! 签名约定（`src-tauri/src/dispatch.rs` 的生成器要求）：`ctx: &CoreCtx` 之后是
//! **平铺的渲染层参数**，名字与顺序同契约 `params`——渲染层门面
//! （`src/bridge/index.ts` 的 `ARG_NAMES`）把 1.x 的位置参数展开成同名具名参数，
//! 写成 `args: XxxArgs` 结构体壳层就收不到单个 `path`。
//!
//! 与 1.x 的差异（均已在迁移报告登记）：
//! - 1.x `file-exists` / `rename-local-node` / `reveal-in-folder` 先做 `trusted(event)`
//!   （Electron sender 校验）；Tauri 下命令只由本应用窗口的 IPC 触发，等价保护由壳层负责；
//! - 1.x 的 `shell.openPath` 错误串（`open-docs-dir`）由 [`crate::ports::Launcher::open_path`]
//!   映射为 `CoreError`，文案保持「打开失败」语义。

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::domain::article::ArticleRow;
use crate::infra::fs;
use crate::services::docs::{self, LocalNode};
use crate::{CoreCtx, CoreResult};

/// `rename-local-node` 返回值（1.x `{ from, to }`，词法归一后的绝对路径）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameLocalNodeOut {
    /// 重命名前的绝对路径。
    pub from: String,
    /// 重命名后的绝对路径。
    pub to: String,
}

/// `hqsf:get-docs-root`：当前存档根（1.x `getDocsRoot`，不建目录）。
pub fn get_docs_root(ctx: &CoreCtx) -> CoreResult<String> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    Ok(fs::path_string(&root))
}

/// `hqsf:open-docs-dir`：确保目录存在后交给系统文件管理器打开。
pub fn open_docs_dir(ctx: &CoreCtx) -> CoreResult<()> {
    docs::open_docs_dir(ctx)
}

/// `hqsf:list-local-docs`：本地文档树（目录在前，跳过 `.image` 与隐藏项）。
pub fn list_local_docs(ctx: &CoreCtx) -> CoreResult<Vec<LocalNode>> {
    docs::list_local_docs(ctx)
}

/// `hqsf:read-local-file`：读 md 原文（逐字返回，含旧文档的 frontmatter 块）。
pub fn read_local_file(ctx: &CoreCtx, path: String) -> CoreResult<String> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    fs::read_local_file(ctx.files.as_ref(), &root, &path)
}

/// `hqsf:file-exists`：路径是否存在（越界直接报错，不返回 false）。
pub fn file_exists(ctx: &CoreCtx, path: String) -> CoreResult<bool> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    let abs = fs::assert_inside(&root, Path::new(&path))?;
    Ok(ctx.files.exists(&abs))
}

/// `hqsf:write-local-file`：整文件写回（自动建父目录）。
pub fn write_local_file(ctx: &CoreCtx, path: String, content: String) -> CoreResult<()> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    fs::write_local_file(ctx.files.as_ref(), &root, &path, &content)
}

/// `hqsf:create-local-draft`：新建草稿，返回新文件绝对路径。
///
/// `dir_rel` 缺省表示根目录；内容逐字写入（v0.0.6 起 1.x 不再生成 frontmatter 模板）。
pub fn create_local_draft(
    ctx: &CoreCtx,
    title: String,
    content: String,
    dir_rel: Option<String>,
) -> CoreResult<String> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    fs::create_local_draft(
        ctx.files.as_ref(),
        &root,
        &title,
        &content,
        dir_rel.as_deref().unwrap_or(""),
    )
}

/// `hqsf:create-local-dir`：新建文件夹，返回绝对路径。
pub fn create_local_dir(ctx: &CoreCtx, rel: String) -> CoreResult<String> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    fs::create_local_dir(ctx.files.as_ref(), &root, &rel)
}

/// `hqsf:delete-local-file`：把文件移入回收站（不存在视为成功，目录拒绝）。
pub fn delete_local_file(ctx: &CoreCtx, path: String) -> CoreResult<()> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    fs::delete_local_file(
        ctx.files.as_ref(),
        ctx.platform.launcher.as_ref(),
        &root,
        &path,
    )
}

/// `hqsf:rename-local-node`：重命名/移动文件或目录，同步索引与配图目录。
pub fn rename_local_node(
    ctx: &CoreCtx,
    old_rel: String,
    new_rel: String,
) -> CoreResult<RenameLocalNodeOut> {
    let (from, to) = docs::rename_local_node(ctx, &old_rel, &new_rel)?;
    Ok(RenameLocalNodeOut { from, to })
}

/// `hqsf:reveal-in-folder`：在系统文件管理器中定位文件。
pub fn reveal_in_folder(ctx: &CoreCtx, path: String) -> CoreResult<()> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    fs::reveal_local_file(
        ctx.files.as_ref(),
        ctx.platform.launcher.as_ref(),
        &root,
        &path,
    )
}

/// `hqsf:choose-docs-dir`：弹目录选择框；取消返回 `None`。
pub fn choose_docs_dir(ctx: &CoreCtx) -> CoreResult<Option<String>> {
    docs::choose_docs_dir(ctx)
}

/// `hqsf:list-articles`：文章索引（本地文件已消失的行把 `filePath` 置空）。
pub fn list_articles(ctx: &CoreCtx) -> CoreResult<Vec<ArticleRow>> {
    docs::list_articles(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FileStore;
    use crate::testkit::Harness;
    use std::path::PathBuf;

    fn draft_root(h: &Harness) -> PathBuf {
        h.ctx.paths.documents_dir.join("荒启科幻").join("草稿")
    }

    // ---------- get-docs-root ----------

    #[test]
    fn get_docs_root_returns_default_and_then_override() {
        let h = Harness::new();
        assert_eq!(get_docs_root(h.ctx()).unwrap(), "/documents/荒启科幻/草稿");

        h.ctx
            .db
            .set_meta(fs::DOCS_ROOT_KEY, "/documents/自定义")
            .unwrap();
        assert_eq!(get_docs_root(h.ctx()).unwrap(), "/documents/自定义");
    }

    // ---------- open-docs-dir ----------

    #[test]
    fn open_docs_dir_creates_directory_and_opens_it() {
        let h = Harness::new();
        open_docs_dir(h.ctx()).unwrap();
        let root = draft_root(&h);
        assert!(h.files.exists(&root));
        assert_eq!(h.launcher.opened_paths.lock().unwrap().as_slice(), &[root]);
    }

    // ---------- list-local-docs ----------

    #[test]
    fn list_local_docs_serializes_camel_case() {
        let h = Harness::new();
        h.files
            .write(&draft_root(&h).join("a.md"), "# 标题\n\n正文".as_bytes())
            .unwrap();

        let nodes = list_local_docs(h.ctx()).unwrap();
        assert_eq!(nodes.len(), 1);
        let json = serde_json::to_value(&nodes[0]).unwrap();
        assert_eq!(json["name"], "a.md");
        assert_eq!(json["rel"], "a.md");
        assert_eq!(json["isDir"], false);
        assert_eq!(json["words"], 1 + 2 + 2);
        assert_eq!(json["summary"], "正文");
        // children 只在目录上出现
        assert!(json.get("children").is_none());
    }

    // ---------- read-local-file ----------

    #[test]
    fn read_local_file_returns_content() {
        let h = Harness::new();
        let abs = draft_root(&h).join("a.md");
        h.files.write(&abs, "# T\n\nabc".as_bytes()).unwrap();
        let out = read_local_file(h.ctx(), fs::path_string(&abs)).unwrap();
        assert_eq!(out, "# T\n\nabc");
    }

    #[test]
    fn read_local_file_missing_and_traversal_errors_are_1x_verbatim() {
        let h = Harness::new();
        let err = read_local_file(h.ctx(), "/documents/荒启科幻/草稿/无.md".into()).unwrap_err();
        assert_eq!(err.to_string(), "文件不存在");

        let err = read_local_file(h.ctx(), "../外面.md".into()).unwrap_err();
        assert_eq!(err.to_string(), "路径越界：仅允许访问本地存档目录");
    }

    // ---------- file-exists ----------

    #[test]
    fn file_exists_distinguishes_present_and_absent() {
        let h = Harness::new();
        let abs = draft_root(&h).join("a.md");
        h.files.write(&abs, b"x").unwrap();

        assert!(file_exists(h.ctx(), fs::path_string(&abs)).unwrap());
        assert!(!file_exists(h.ctx(), fs::path_string(&draft_root(&h).join("无.md"))).unwrap());
    }

    #[test]
    fn file_exists_rejects_traversal_instead_of_returning_false() {
        let h = Harness::new();
        let err = file_exists(h.ctx(), "/etc/passwd".into()).unwrap_err();
        assert_eq!(err.to_string(), "路径越界：仅允许访问本地存档目录");
        assert_eq!(err.code(), "app");
    }

    // ---------- write-local-file ----------

    #[test]
    fn write_local_file_writes_content_and_creates_parents() {
        let h = Harness::new();
        let abs = draft_root(&h).join("子目录").join("a.md");
        write_local_file(h.ctx(), fs::path_string(&abs), "正文".into()).unwrap();
        assert_eq!(h.files.read(&abs).unwrap(), "正文".as_bytes());
    }

    #[test]
    fn write_local_file_rejects_traversal() {
        let h = Harness::new();
        let err = write_local_file(h.ctx(), "../逃逸.md".into(), "x".into()).unwrap_err();
        assert_eq!(err.to_string(), "路径越界：仅允许访问本地存档目录");
    }

    // ---------- create-local-draft ----------

    #[test]
    fn create_local_draft_names_file_and_writes_content_verbatim() {
        let h = Harness::new();
        let out = create_local_draft(h.ctx(), "我的草稿".into(), "## 正文".into(), None).unwrap();
        assert_eq!(out, "/documents/荒启科幻/草稿/我的草稿.md");
        let body = h.files.read(Path::new(&out)).unwrap();
        assert_eq!(body, "## 正文".as_bytes());

        // 子目录参数生效（1.x 只 join，不建目录；这里用内存盘写入成功）
        let second = create_local_draft(
            h.ctx(),
            "我的草稿".into(),
            String::new(),
            Some("卷一".into()),
        )
        .unwrap();
        assert_eq!(second, "/documents/荒启科幻/草稿/卷一/我的草稿.md");
    }

    #[test]
    fn create_local_draft_rejects_traversal_dir() {
        let h = Harness::new();
        let err = create_local_draft(
            h.ctx(),
            "标题".into(),
            String::new(),
            Some("../外面".into()),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "路径越界：仅允许访问本地存档目录");
    }

    // ---------- create-local-dir ----------

    #[test]
    fn create_local_dir_creates_and_is_idempotent() {
        let h = Harness::new();
        let abs = create_local_dir(h.ctx(), "小说".into()).unwrap();
        assert_eq!(abs, "/documents/荒启科幻/草稿/小说");
        assert!(h.files.exists(Path::new(&abs)));
        assert_eq!(create_local_dir(h.ctx(), "小说".into()).unwrap(), abs);
    }

    #[test]
    fn create_local_dir_reports_file_name_conflict() {
        let h = Harness::new();
        h.files
            .write(&draft_root(&h).join("占位.md"), b"x")
            .unwrap();
        let err = create_local_dir(h.ctx(), "占位.md".into()).unwrap_err();
        assert_eq!(err.to_string(), "同名文件已存在");
    }

    // ---------- delete-local-file ----------

    #[test]
    fn delete_local_file_trashes_file_and_ignores_missing() {
        let h = Harness::new();
        let abs = draft_root(&h).join("a.md");
        h.files.write(&abs, b"x").unwrap();

        delete_local_file(h.ctx(), fs::path_string(&abs)).unwrap();
        assert_eq!(
            h.launcher.trashed.lock().unwrap().as_slice(),
            std::slice::from_ref(&abs)
        );

        // 1.x：不存在直接成功返回
        delete_local_file(h.ctx(), fs::path_string(&draft_root(&h).join("无.md"))).unwrap();
        assert_eq!(h.launcher.trashed.lock().unwrap().len(), 1);
    }

    #[test]
    fn delete_local_file_refuses_directory() {
        let h = Harness::new();
        h.files
            .create_dir_all(&draft_root(&h).join("子目录"))
            .unwrap();
        let err = delete_local_file(h.ctx(), "/documents/荒启科幻/草稿/子目录".into()).unwrap_err();
        assert_eq!(err.to_string(), "不能删除目录，仅支持删除文章文件");
    }

    // ---------- rename-local-node ----------

    #[test]
    fn rename_local_node_returns_from_and_to() {
        let h = Harness::new();
        h.files.write(&draft_root(&h).join("旧.md"), b"x").unwrap();

        let out = rename_local_node(h.ctx(), "旧.md".into(), "新.md".into()).unwrap();
        assert_eq!(out.from, "/documents/荒启科幻/草稿/旧.md");
        assert_eq!(out.to, "/documents/荒启科幻/草稿/新.md");
        assert!(h.files.exists(&draft_root(&h).join("新.md")));

        let json = serde_json::to_value(&out).unwrap();
        assert_eq!(json, serde_json::json!({ "from": out.from, "to": out.to }));
    }

    #[test]
    fn rename_local_node_reports_source_missing() {
        let h = Harness::new();
        let err = rename_local_node(h.ctx(), "无.md".into(), "新.md".into()).unwrap_err();
        assert_eq!(err.to_string(), "源路径不存在");
    }

    // ---------- reveal-in-folder ----------

    #[test]
    fn reveal_in_folder_reveals_existing_file() {
        let h = Harness::new();
        let abs = draft_root(&h).join("a.md");
        h.files.write(&abs, b"x").unwrap();

        reveal_in_folder(h.ctx(), fs::path_string(&abs)).unwrap();
        assert_eq!(
            h.launcher.revealed.lock().unwrap().as_slice(),
            std::slice::from_ref(&abs)
        );
    }

    #[test]
    fn reveal_in_folder_reports_missing_file() {
        let h = Harness::new();
        let err = reveal_in_folder(h.ctx(), "/documents/荒启科幻/草稿/无.md".into()).unwrap_err();
        assert_eq!(err.to_string(), "文件不存在");
    }

    // ---------- choose-docs-dir ----------

    #[test]
    fn choose_docs_dir_returns_none_on_cancel_and_path_on_pick() {
        let h = Harness::new();
        *h.dialog.picked_dir.lock().unwrap() = None;
        assert_eq!(choose_docs_dir(h.ctx()).unwrap(), None);

        *h.dialog.picked_dir.lock().unwrap() = Some(PathBuf::from("/documents/另一个"));
        assert_eq!(
            choose_docs_dir(h.ctx()).unwrap().as_deref(),
            Some("/documents/另一个")
        );
        assert_eq!(get_docs_root(h.ctx()).unwrap(), "/documents/另一个");
    }

    // ---------- list-articles ----------

    #[test]
    fn list_articles_clears_missing_file_path_and_serializes_camel_case() {
        let h = Harness::new();
        let existing = draft_root(&h).join("在.md");
        h.files.write(&existing, b"x").unwrap();

        let mut linked = crate::domain::article::ArticleRow::new(
            "c1",
            crate::domain::article::ArticleType::Local,
            1_700_000_000_000,
        );
        linked.file_path = fs::path_string(&existing);
        h.ctx.db.upsert_article(&linked).unwrap();

        let mut dangling = crate::domain::article::ArticleRow::new(
            "c2",
            crate::domain::article::ArticleType::Local,
            1_700_000_000_001,
        );
        dangling.file_path = fs::path_string(&draft_root(&h).join("没了.md"));
        h.ctx.db.upsert_article(&dangling).unwrap();

        let rows = list_articles(h.ctx()).unwrap();
        assert_eq!(rows.len(), 2);
        let json = serde_json::to_value(&rows).unwrap();
        assert_eq!(json[0]["filePath"], "");
        assert_eq!(json[1]["filePath"], fs::path_string(&existing));
        // ArticleRow 的 `type` 字段沿用 1.x 的列名
        assert_eq!(json[0]["type"], "local");
    }
}
