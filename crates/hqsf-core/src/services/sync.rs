//! 同步引擎（1.x `src/main/services/sync-service.ts` 的 Rust 平移）。
//!
//! 设计文档对应 `doc/design.md` 的「数据同步」章节，1.x 顶层注释的三条规则照抄：
//!
//! - **拉取**：`contentsList`（`type=post_draft` 或 `type=post` + `status=waiting|publish|reject`，
//!   都带 `authorId`）→ 元数据入 SQLite；四态都经 `contentsInfo` 拉全文 → 转 md 写本地文件
//!   （同一个存档根目录，靠 `[待审核]/[已发布]/[已拒绝]` 文件名前缀区分）。
//! - **推送**：本地 md → 配图上传 → [`md_to_html`] → `contentsAdd`/`contentsUpdate`（`isDraft` 0/1）。
//! - **冲突策略**：本地已修改（内容哈希 != 上次同步哈希）时保留本地文件，只更新索引里的
//!   远端态与 `remoteModified`，并计入 `conflicts`。
//!
//! 两条 L5 接缝（[`md_to_html`]、[`html_to_md`]）在文件末尾，所有调用点都收敛到它们：
//! L5 的 `infra::markdown` 落地后只改这两个函数，本文件其余部分不动。
//!
//! 与 1.x 的差异（均在报告里列过）：`html_to_md` 暂时直通（Rust 无 turndown 等价实现），
//! 远端图片文件名兜底哈希用 sha256 前 8 位（无 md5 依赖），写盘统一走
//! `infra::fs::write_local_file`（补 `assert_inside` 加固）。

use std::path::Path;

use serde_json::Value;

use crate::CoreCtx;
use crate::adapters::read::{js_to_string, str_of};
use crate::adapters::sync::{self as sync_api, RemoteFullText};
use crate::domain::article::{ArticleRow, ArticleType};
use crate::domain::sync::{
    ArticleMeta, ConvertDraftResult, EditRemoteResult, PullResult, PushMetaParams, PushResult,
    SYNC_KINDS, collect_image_refs, content_hash, heading_title, image_file_name, is_http_image,
    is_local_image_ref, local_file_name, push_params_json, state_differs,
};
use crate::error::{CoreError, CoreResult};
use crate::infra::fs;
use crate::infra::session;
use crate::services::net;

/// 1.x 文案：本地文件有未同步修改时拒绝「编辑远端文章」（`sync-service.ts:634`）。
pub const MSG_LOCAL_DIRTY: &str = "本地文件有未同步的修改，请先「同步到草稿」或发布后再编辑";
/// 1.x 文案：服务端既没返回 cid、按标题也查不到（`sync-service.ts:527`）。
pub const MSG_CID_MISSING: &str = "上传成功但未返回文章 ID，请到荒启草稿箱确认后再操作";
/// 1.x 文案：正文为空无法转存草稿（`sync-service.ts:565`）。
pub const MSG_EMPTY_BODY: &str = "文章正文为空，无法转存为草稿";

// ---------- 会话 ----------

/// `hqsf:sync-pull` 用的 uid：1.x `sync.handlers.ts:11` 只读 `userinfo.uid`，**不兜底 `id`**。
///
/// 读不到会话/uid 时返回空串（调用方与 token 一起判「未登录」）。
pub fn pull_uid(ctx: &CoreCtx) -> CoreResult<String> {
    let Some(session) = session::load(ctx)? else {
        return Ok(String::new());
    };
    Ok(str_of(session.userinfo.get("uid")))
}

// ---------- 拉取 ----------

/// 拉取远端四态并合并到本地（1.x `pullRemote`）。
pub fn pull_remote(ctx: &CoreCtx, token: &str, author_id: &str) -> CoreResult<PullResult> {
    let root = fs::ensure_docs_root(ctx.files.as_ref(), &ctx.paths, &ctx.db)?;
    let mut result = PullResult::default();

    for kind in SYNC_KINDS {
        let items = match sync_api::list_remote(
            ctx,
            token,
            author_id,
            kind.remote_type,
            kind.remote_status,
        ) {
            Ok(items) => items,
            Err(err) => {
                // 1.x：`if (remote !== 'reject') errors.push(`${remote}: ${msg}`)`。
                // 注意 `remote` 只有 `post_draft` / `post` 两种取值（四态里后三态都是
                // `type=post` + `status=...`），所以这个条件恒为真——错误总是收集。
                result.errors.push(format!("{}: {}", kind.remote_type, err));
                continue;
            }
        };
        result.total += items.len() as u32;
        for item in &items {
            merge_item(ctx, author_id, &root, kind.article_type, item, &mut result);
        }
    }

    cleanup_orphan_image_dirs(ctx, &root)?;
    Ok(result)
}

/// 合并一条 `contentsList` 条目（1.x `pullRemote` 的循环体）。
fn merge_item(
    ctx: &CoreCtx,
    author_id: &str,
    root: &Path,
    article_type: ArticleType,
    item: &sync_api::RemoteListItem,
    result: &mut PullResult,
) {
    if item.cid.is_empty() {
        return;
    }
    let cid = item.cid.as_str();
    let title = item.title.as_str();
    let status = item.status.as_str();
    let remote_modified = item.modified;
    let now = ctx.clock.now_ms();

    let existing = match ctx.db.get_article_by_cid(cid) {
        Ok(row) => row,
        Err(err) => {
            push_pull_error(result, title, &err.to_string());
            return;
        }
    };
    let file_exists = existing.as_ref().is_some_and(|row| {
        !row.file_path.is_empty() && ctx.files.exists(Path::new(&row.file_path))
    });

    if let (Some(row), true) = (existing.as_ref(), file_exists) {
        // 先修索引态（远端已流转到别的状态时，即使远端没再改正文也要更新本地态）。
        if state_differs(row, article_type, status) {
            let mut next = row.clone();
            next.title = title.to_string();
            next.article_type = article_type;
            next.status = status.to_string();
            next.updated_at = now;
            if let Err(err) = ctx.db.upsert_article(&next) {
                push_pull_error(result, title, &err.to_string());
                return;
            }
        }
        // 远端不比本地索引新 → 什么都不做。
        if remote_modified <= row.remote_modified {
            return;
        }
        // 本地有未同步修改 → 保留本地，只推进远端态，计入冲突。
        if is_local_dirty(ctx, row) {
            result.conflicts += 1;
            let mut next = row.clone();
            next.title = title.to_string();
            next.article_type = article_type;
            next.status = status.to_string();
            next.remote_modified = remote_modified;
            next.updated_at = now;
            if let Err(err) = ctx.db.upsert_article(&next) {
                push_pull_error(result, title, &err.to_string());
            }
            return;
        }
        // 无冲突：拉全文覆盖本地文件（**沿用旧 filePath，不重命名**）。
        let fetched = pull_full_markdown(ctx, cid, root);
        let outcome = fetched.and_then(|md| {
            fs::write_local_file(ctx.files.as_ref(), root, &row.file_path, &md)?;
            let mut next = row.clone();
            next.title = title.to_string();
            next.article_type = article_type;
            next.status = status.to_string();
            next.remote_modified = remote_modified;
            next.content_hash = content_hash(&md);
            next.local_modified = now;
            next.synced_at = now;
            next.updated_at = now;
            ctx.db.upsert_article(&next)
        });
        match outcome {
            Ok(()) => result.pulled += 1,
            Err(err) => push_pull_error(result, title, &err.to_string()),
        }
        return;
    }

    // 索引里没有，或本地文件已失联：拉全文 + 新建本地文件。
    let outcome = pull_full_markdown(ctx, cid, root).and_then(|md| {
        let file_path = fs::create_local_draft(
            ctx.files.as_ref(),
            root,
            &local_file_name(article_type, title),
            &md,
            "",
        )?;
        let mut next = existing.unwrap_or_else(|| ArticleRow {
            cid: cid.to_string(),
            title: title.to_string(),
            article_type,
            status: status.to_string(),
            author_id: author_id.to_string(),
            remote_modified: 0,
            local_modified: now,
            content_hash: String::new(),
            file_path: String::new(),
            synced_at: 0,
            created_at: now,
            updated_at: now,
        });
        next.title = title.to_string();
        next.article_type = article_type;
        next.status = status.to_string();
        next.remote_modified = remote_modified;
        next.local_modified = now;
        next.content_hash = content_hash(&md);
        next.file_path = file_path;
        next.synced_at = now;
        next.updated_at = now;
        ctx.db.upsert_article(&next)
    });
    match outcome {
        Ok(()) => result.pulled += 1,
        Err(err) => push_pull_error(result, title, &err.to_string()),
    }
}

/// 1.x 单条失败入 `errors`：`` `${title}: ${msg}` ``（条件 `remote !== 'reject'` 恒真，见上）。
fn push_pull_error(result: &mut PullResult, title: &str, message: &str) {
    result.errors.push(format!("{title}: {message}"));
}

/// 拉全文并转成本地 md（1.x `fetchFullText` + `markdown?html:htmlToMd` + `pullArticleImages`）。
fn pull_full_markdown(ctx: &CoreCtx, cid: &str, root: &Path) -> CoreResult<String> {
    let full = sync_api::fetch_full_text(ctx, cid).map_err(|err| err.into_core_error())?;
    let markdown = html_to_markdown(&full);
    pull_article_images(ctx, &markdown, root, cid)
}

/// 远端全文 → 本地 md 正文（1.x `draftSubmitHtml` 的前半段 / `pullRemote` 里的选择）。
fn html_to_markdown(full: &RemoteFullText) -> String {
    if full.markdown {
        full.html.clone()
    } else {
        // TODO(L5): 换成 infra::markdown::html_to_md（当前 markdown 模块还没有反向实现）
        html_to_md(&full.html)
    }
}

/// 清掉 `.image/` 下已经没有对应文章 cid 的目录（1.x `cleanupOrphanImageDirs`）。
///
/// `readdir`/单目录删除失败都静默跳过（1.x 同样如此）；`listArticles` 失败在 1.x 会
/// 让整次拉取 reject，这里保持一致（`?`）。
fn cleanup_orphan_image_dirs(ctx: &CoreCtx, root: &Path) -> CoreResult<()> {
    let image_root = root.join(fs::IMAGE_DIR);
    if !ctx.files.exists(&image_root) {
        return Ok(());
    }
    let Ok(entries) = ctx.files.list(&image_root) else {
        return Ok(());
    };
    let known: std::collections::BTreeSet<String> = ctx
        .db
        .list_articles(None)?
        .into_iter()
        .map(|row| row.cid)
        .filter(|cid| !cid.is_empty())
        .collect();
    for entry in entries {
        if known.contains(&entry.name) || !entry.is_dir {
            continue;
        }
        let _ = ctx.files.remove_dir_all(&entry.path);
    }
    Ok(())
}

// ---------- 推送 ----------

/// 1.x `pushToDraft` / `publish` 的分发（`isDraft` 决定目标态）。
pub fn push(
    ctx: &CoreCtx,
    token: &str,
    file_path: &str,
    is_draft: bool,
    meta: Option<&ArticleMeta>,
) -> CoreResult<PushResult> {
    if is_draft {
        upload(ctx, token, file_path, true, None)
    } else {
        upload(ctx, token, file_path, false, meta)
    }
}

/// 1.x `pushToDraft(token,filePath)`：存草稿（不带元数据）。
pub fn push_to_draft(ctx: &CoreCtx, token: &str, file_path: &str) -> CoreResult<PushResult> {
    upload(ctx, token, file_path, true, None)
}

/// 1.x `publish(token,filePath,meta?)`：发布（元数据来自发布表单）。
pub fn publish(
    ctx: &CoreCtx,
    token: &str,
    file_path: &str,
    meta: Option<&ArticleMeta>,
) -> CoreResult<PushResult> {
    upload(ctx, token, file_path, false, meta)
}

/// 1.x `upload`：本地 md → 配图上传 → [`md_to_html`] → `contentsAdd`/`contentsUpdate`。
///
/// 注意 1.x 的 try/catch 边界：`getDocsRoot` / `assertInside` / `readFileSync` /
/// `resolveTitle` / `getArticleByFilePath` 都在 try **之前**（失败走 handler 的 `fail(err)`），
/// 只有「元数据解析 → 提交 → 入库」在 try 里（失败返回 `{ok:false,error}`）。
fn upload(
    ctx: &CoreCtx,
    token: &str,
    file_path: &str,
    is_draft: bool,
    meta_override: Option<&ArticleMeta>,
) -> CoreResult<PushResult> {
    let root = fs::docs_root(&ctx.paths, &ctx.db)?;
    let abs = fs::assert_inside(&root, Path::new(file_path))?;
    let content = String::from_utf8_lossy(&ctx.files.read(&abs)?).into_owned();
    let title = resolve_title(&abs, &content);
    let existing = ctx.db.get_article_by_file_path(&fs::path_string(&abs))?;
    let article_type = if is_draft {
        ArticleType::PostDraft
    } else {
        ArticleType::Waiting
    };

    let outcome = (|| -> CoreResult<PushResult> {
        // v0.0.6：草稿不带元数据（frontmatter 不再记录元数据）；发布用发布表单的 meta。
        let meta = if is_draft {
            ArticleMeta::default()
        } else {
            meta_override.cloned().unwrap_or_default()
        };
        let meta_params = resolve_meta_params(ctx, token, &meta);
        let content_remote = upload_local_images(ctx, token, &content, &root)?;
        // TODO(L5): 本行是 1.x `sync-service.ts:488` 的 `mdToHtml(contentRemote)`，
        // 已收敛到 [`md_to_html`]（L5 的 `infra::markdown::md_to_html` 落地后只改那个函数）。
        let html = md_to_html(&content_remote);
        let mut cid = existing
            .as_ref()
            .map(|row| row.cid.clone())
            .filter(|cid| !cid.is_empty());
        let params_json = push_params_json(&title, cid.as_deref(), &meta_params);
        let data =
            sync_api::submit_content(ctx, token, &params_json, &html, is_draft, cid.as_deref())?;
        if cid.is_none() {
            // contentsAdd 成功时 data 可能是裸数字，必须用 `extractCid` 过滤。
            cid = sync_api::extract_cid(&data);
            if cid.is_none() {
                cid = sync_api::find_cid_by_title(ctx, token, &title, is_draft);
            }
            let Some(found) = cid.clone() else {
                return Ok(PushResult {
                    ok: false,
                    cid: None,
                    article_type: None,
                    error: Some(MSG_CID_MISSING.to_string()),
                });
            };
            cid = Some(found);
        }

        let now = ctx.clock.now_ms();
        let status = if is_draft {
            String::new()
        } else {
            "waiting".to_string()
        };
        let mut row = existing.clone().unwrap_or_else(|| ArticleRow {
            cid: cid.clone().unwrap_or_default(),
            title: title.clone(),
            article_type,
            status: status.clone(),
            author_id: String::new(),
            remote_modified: 0,
            local_modified: now,
            content_hash: String::new(),
            file_path: fs::path_string(&abs),
            synced_at: 0,
            created_at: now,
            updated_at: now,
        });
        if let Some(new_cid) = &cid {
            row.cid = new_cid.clone();
        }
        row.title = title;
        row.article_type = article_type;
        row.status = status;
        // 哈希用**原始本地 md**（不是转换后的 HTML），冲突判定才等价于 1.x。
        row.content_hash = content_hash(&content);
        row.synced_at = now;
        row.updated_at = now;
        ctx.db.upsert_article(&row)?;

        Ok(PushResult {
            ok: true,
            cid,
            article_type: Some(article_type),
            error: None,
        })
    })();

    // 1.x `catch (err) { return { ok: false, error: (err as Error).message } }`
    Ok(outcome.unwrap_or_else(|err| PushResult {
        ok: false,
        cid: None,
        article_type: None,
        error: Some(err.to_string()),
    }))
}

/// 1.x `resolveTitle`：第一行 `# ` 标题；没有就用文件名（去 `.md` 后清洗）。
fn resolve_title(abs: &Path, content: &str) -> String {
    match heading_title(content) {
        Some(title) => title,
        None => fs::sanitize_file_name(&fs::title_from_path(abs)),
    }
}

/// 1.x `resolveMetaParams`：名称 → mid，组装提交参数。单个 metasList 失败静默跳过。
fn resolve_meta_params(ctx: &CoreCtx, token: &str, meta: &ArticleMeta) -> PushMetaParams {
    let mut params = PushMetaParams::default();
    if let Some(mid) = meta
        .category
        .as_deref()
        .filter(|name| !name.is_empty())
        .and_then(|category| sync_api::meta_name_to_id(ctx, Some(token), "category", category))
    {
        params.category = Some(mid);
    }
    if let Some(tags) = meta.tags.as_deref().filter(|tags| !tags.is_empty()) {
        let ids: Vec<String> = tags
            .iter()
            .filter_map(|tag| sync_api::meta_name_to_id(ctx, Some(token), "tag", tag))
            .collect();
        if !ids.is_empty() {
            params.tag = Some(ids.join(","));
        }
    }
    if let Some(mid) = meta
        .active
        .as_deref()
        .filter(|name| !name.is_empty())
        .and_then(|active| sync_api::meta_name_to_id(ctx, Some(token), "active", active))
    {
        params.active = Some(mid);
    }
    if let Some(isopen) = meta.isopen {
        params.isopen = Some(isopen);
    }
    params
}

// ---------- 转存草稿 / 编辑远端 ----------

/// 1.x `convertToDraft`：远端非草稿 → 服务端转存草稿 → 索引改草稿态。
pub fn convert_to_draft(
    ctx: &CoreCtx,
    token: &str,
    author_id: &str,
    cid: &str,
) -> CoreResult<ConvertDraftResult> {
    let existing = ctx.db.get_article_by_cid(cid)?;
    if existing
        .as_ref()
        .is_some_and(|row| row.article_type == ArticleType::PostDraft)
    {
        return Ok(ConvertDraftResult { converted: false });
    }

    let full = sync_api::fetch_full_text(ctx, cid).map_err(|err| err.into_core_error())?;
    if remote_is_draft(&full, existing.as_ref()) {
        // 远端本来就是草稿：顺手修正过期索引（本地记成待审/已发布时）。
        if let Some(row) = existing
            .as_ref()
            .filter(|row| row.article_type != ArticleType::PostDraft)
        {
            let mut next = row.clone();
            next.title = full.title.clone();
            next.article_type = ArticleType::PostDraft;
            next.status = String::new();
            next.updated_at = ctx.clock.now_ms();
            ctx.db.upsert_article(&next)?;
        }
        return Ok(ConvertDraftResult { converted: false });
    }

    let html = draft_submit_html(&full)?;
    sync_api::update_to_draft(ctx, token, cid, &full.title, &html)?;

    let now = ctx.clock.now_ms();
    let mut row = existing.unwrap_or_else(|| ArticleRow {
        cid: cid.to_string(),
        title: full.title.clone(),
        article_type: ArticleType::PostDraft,
        status: String::new(),
        author_id: author_id.to_string(),
        remote_modified: 0,
        local_modified: 0,
        content_hash: String::new(),
        file_path: String::new(),
        synced_at: 0,
        created_at: now,
        updated_at: now,
    });
    row.title = full.title.clone();
    row.article_type = ArticleType::PostDraft;
    row.status = String::new();
    row.updated_at = now;
    ctx.db.upsert_article(&row)?;
    Ok(ConvertDraftResult { converted: true })
}

/// 1.x `editRemoteArticle`：远端非草稿先转存，再把全文拉到本地存档供编辑器打开。
pub fn edit_remote_article(
    ctx: &CoreCtx,
    token: &str,
    author_id: &str,
    cid: &str,
) -> CoreResult<EditRemoteResult> {
    let root = fs::ensure_docs_root(ctx.files.as_ref(), &ctx.paths, &ctx.db)?;
    let existing = ctx.db.get_article_by_cid(cid)?;
    let existing_file_path = existing
        .as_ref()
        .map(|row| row.file_path.clone())
        .filter(|path| !path.is_empty() && ctx.files.exists(Path::new(path)));

    // 本地脏文件不允许「编辑远端」覆盖（1.x 抛错，文案原文）。
    if existing
        .as_ref()
        .is_some_and(|row| existing_file_path.is_some() && is_local_dirty(ctx, row))
    {
        return Err(CoreError::app(MSG_LOCAL_DIRTY));
    }

    let full = sync_api::fetch_full_text(ctx, cid).map_err(|err| err.into_core_error())?;
    let mut converted = false;
    if !remote_is_draft(&full, existing.as_ref()) {
        let html = draft_submit_html(&full)?;
        sync_api::update_to_draft(ctx, token, cid, &full.title, &html)?;
        converted = true;
    }

    let markdown = html_to_markdown(&full);
    let markdown = pull_article_images(ctx, &markdown, &root, cid)?;
    let now = ctx.clock.now_ms();
    let file_path = match &existing_file_path {
        Some(path) => path.clone(),
        None => fs::create_local_draft(
            ctx.files.as_ref(),
            &root,
            &local_file_name(ArticleType::PostDraft, &full.title),
            &markdown,
            "",
        )?,
    };
    fs::write_local_file(ctx.files.as_ref(), &root, &file_path, &markdown)?;

    let mut row = existing.unwrap_or_else(|| ArticleRow {
        cid: cid.to_string(),
        title: full.title.clone(),
        article_type: ArticleType::PostDraft,
        status: String::new(),
        author_id: author_id.to_string(),
        remote_modified: 0,
        local_modified: 0,
        content_hash: String::new(),
        file_path: String::new(),
        synced_at: 0,
        created_at: now,
        updated_at: now,
    });
    row.title = full.title.clone();
    row.article_type = ArticleType::PostDraft;
    row.status = String::new();
    row.local_modified = now;
    row.content_hash = content_hash(&markdown);
    row.file_path = file_path.clone();
    row.synced_at = now;
    row.updated_at = now;
    ctx.db.upsert_article(&row)?;
    Ok(EditRemoteResult {
        file_path,
        converted,
    })
}

/// 1.x `(full.type ?? existing?.type) === 'post_draft'` 的判定。
fn remote_is_draft(full: &RemoteFullText, existing: Option<&ArticleRow>) -> bool {
    match full.article_type.as_deref() {
        Some(kind) => kind == "post_draft",
        None => existing.is_some_and(|row| row.article_type == ArticleType::PostDraft),
    }
}

/// 1.x `draftSubmitHtml(full)`：转存草稿的正文 HTML（md 原文先转 HTML），空正文报错。
fn draft_submit_html(full: &RemoteFullText) -> CoreResult<String> {
    let html = if full.markdown {
        // TODO(L5): 1.x `sync-service.ts:563` 的 `mdToHtml(full.html)`，接缝见 [`md_to_html`]。
        md_to_html(&full.html)
    } else {
        full.html.clone()
    };
    if html.trim().is_empty() {
        return Err(CoreError::app(MSG_EMPTY_BODY));
    }
    Ok(html)
}

// ---------- 本地脏判断 ----------

/// 1.x `isLocalDirty(row)`：读不到文件时视为「不脏」（`catch { return false }`）。
fn is_local_dirty(ctx: &CoreCtx, row: &ArticleRow) -> bool {
    if row.file_path.is_empty() {
        return false;
    }
    match ctx.files.read(Path::new(&row.file_path)) {
        Ok(bytes) => {
            let current = String::from_utf8_lossy(&bytes);
            content_hash(&current) != row.content_hash
        }
        Err(_) => false,
    }
}

// ---------- 配图 ----------

/// 拉远端配图到 `.image/<cid>/`，并把正文里的 http 引用换成本地相对路径（1.x `pullArticleImages`）。
///
/// 单张图片失败静默保留原 URL（1.x 的 per-url try/catch）；建目录失败向上传播（1.x 会
/// 让整篇拉取失败）。
fn pull_article_images(
    ctx: &CoreCtx,
    markdown: &str,
    root: &Path,
    cid: &str,
) -> CoreResult<String> {
    let refs: Vec<String> = collect_image_refs(markdown)
        .into_iter()
        .filter(|reference| is_http_image(reference))
        .collect();
    if refs.is_empty() {
        return Ok(markdown.to_string());
    }
    let image_dir = fs::image_dir_for(root, cid);
    ctx.files.create_dir_all(&image_dir)?;
    let mut out = markdown.to_string();
    for url in refs {
        let attempt = (|| -> CoreResult<String> {
            let dest = image_dir.join(image_file_name(&url));
            if !ctx.files.exists(&dest) {
                let bytes = net::download_image(ctx, &url)?;
                ctx.files.write(&dest, &bytes)?;
            }
            Ok(relative_md_ref(root, &dest))
        })();
        if let Ok(relative) = attempt {
            out = out.replace(url.as_str(), &relative);
        }
    }
    Ok(out)
}

/// 本地相对引用：`'./' + relative(root,dest)`，反斜杠换 `/`（1.x 同）。
fn relative_md_ref(root: &Path, dest: &Path) -> String {
    let relative = dest.strip_prefix(root).unwrap_or(dest);
    format!("./{}", relative.to_string_lossy().replace('\\', "/"))
}

/// 把正文里的本地配图上传成远端 URL（1.x `uploadLocalImages`）：任一上传失败整体失败。
fn upload_local_images(
    ctx: &CoreCtx,
    token: &str,
    markdown: &str,
    root: &Path,
) -> CoreResult<String> {
    let refs: Vec<String> = collect_image_refs(markdown)
        .into_iter()
        .filter(|reference| is_local_image_ref(reference))
        .collect();
    if refs.is_empty() {
        return Ok(markdown.to_string());
    }
    let mut out = markdown.to_string();
    for reference in refs {
        let abs = root.join(reference.trim_start_matches("./"));
        if !ctx.files.exists(&abs) {
            continue;
        }
        let bytes = ctx.files.read(&abs)?;
        let filename = abs
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let url = net::upload(ctx, token, &filename, &bytes)?;
        out = out.replace(reference.as_str(), &url);
    }
    Ok(out)
}

// ---------- 杂项 ----------

/// 正文里的 `js_to_string` 便捷包装（仅本模块测试路径需要，保留给调试）。
#[allow(dead_code)]
fn js(value: &Value) -> String {
    js_to_string(value)
}

// ---------- L5 接缝 ----------

/// md → HTML（1.x `mdToHtml`，`src/main/infra/media/md2html.ts`）。
///
/// 1.x 调用点：`sync-service.ts:488`（推送正文）、`:563`（转存草稿正文）。
/// 实际转换在 L5 的 `infra::markdown::md_to_html`（与 1.x 逐字节对等，143 篇语料）。
fn md_to_html(markdown: &str) -> String {
    crate::infra::markdown::md_to_html(markdown)
}

/// HTML → md（1.x `htmlToMd`，turndown 配置 `headingStyle:'atx'`、`codeBlockStyle:'fenced'`、
/// `bulletListMarker:'-'`）。
///
/// 用于 `contentsInfo` 返回 `markdown:0` 的文章（远端纯 HTML 正文）落盘；L5 在 QuickJS 里
/// 跑与 1.x 同一份 turndown 资产（22 条语料逐字节对等），见 `infra::markdown::html_to_md`。
fn html_to_md(html: &str) -> String {
    crate::infra::markdown::html_to_md(html)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::adapters::read::norm_ts;
    use crate::infra::net::api::encode_form;
    use crate::testkit::Harness;

    fn list_page(items: Value) -> String {
        let total = items.as_array().map(|list| list.len()).unwrap_or(0);
        serde_json::json!({ "code": 1, "msg": "", "data": items, "total": total }).to_string()
    }

    /// `contentsInfo` 的 mock：`fetchRemoteObject` 直接消费裸对象（不是 `{code,msg,data}` 信封）。
    fn full_text(title: &str, text: &str, markdown: bool, kind: &str) -> String {
        serde_json::json!({
            "title": title,
            "text": text,
            "markdown": if markdown { 1 } else { 0 },
            "type": kind
        })
        .to_string()
    }

    fn docs_root(h: &Harness) -> PathBuf {
        fs::ensure_docs_root(h.ctx().files.as_ref(), &h.ctx().paths, &h.ctx().db).unwrap()
    }

    fn write_draft(h: &Harness, title: &str, content: &str) -> String {
        let root = docs_root(h);
        fs::create_local_draft(h.ctx().files.as_ref(), &root, title, content, "").unwrap()
    }

    fn session_with_userinfo(h: &Harness, userinfo: serde_json::Map<String, Value>) {
        let data = crate::infra::session::SessionData {
            token: "tok".to_string(),
            userinfo,
            insecure: false,
        };
        crate::infra::session::save(h.ctx(), &data).unwrap();
    }

    // ---------- 会话 uid ----------

    #[test]
    fn pull_uid_reads_only_uid_not_id() {
        let h = Harness::new();
        let mut userinfo = serde_json::Map::new();
        userinfo.insert("uid".into(), serde_json::json!(7));
        userinfo.insert("id".into(), serde_json::json!(9));
        session_with_userinfo(&h, userinfo);
        assert_eq!(pull_uid(h.ctx()).unwrap(), "7");

        let h = Harness::new();
        let mut userinfo = serde_json::Map::new();
        userinfo.insert("id".into(), serde_json::json!(9));
        session_with_userinfo(&h, userinfo);
        assert_eq!(pull_uid(h.ctx()).unwrap(), "");
    }

    #[test]
    fn pull_uid_without_session_is_empty() {
        let h = Harness::new();
        assert_eq!(pull_uid(h.ctx()).unwrap(), "");
    }

    // ---------- 拉取 ----------

    #[test]
    fn pull_remote_creates_local_file_from_remote_draft() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 11, "title": "远端草稿", "status": "", "modified": 1_700_000_000 }
            ])),
        );
        h.http.enqueue(
            200,
            full_text("远端草稿", "# 远端草稿\n正文", true, "post_draft"),
        );
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.pulled, 1);
        assert_eq!(result.conflicts, 0);
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let row = h.ctx().db.get_article_by_cid("11").unwrap().unwrap();
        assert_eq!(row.article_type, ArticleType::PostDraft);
        assert_eq!(row.title, "远端草稿");
        assert_eq!(
            row.file_path,
            format!("{}/远端草稿.md", docs_root(&h).display())
        );
        let content =
            String::from_utf8(h.ctx().files.read(Path::new(&row.file_path)).unwrap()).unwrap();
        assert_eq!(content, "# 远端草稿\n正文");
        assert_eq!(row.content_hash, content_hash("# 远端草稿\n正文"));
        assert_eq!(row.remote_modified, 1_700_000_000);
    }

    #[test]
    fn pull_remote_uses_status_file_prefix_for_non_draft_states() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 21, "title": "待审文章", "status": "waiting", "modified": 1_700_000_100 }
            ])),
        );
        h.http
            .enqueue(200, full_text("待审文章", "# 待审文章", true, "post"));
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.pulled, 1, "{:?}", result.errors);
        let row = h.ctx().db.get_article_by_cid("21").unwrap().unwrap();
        assert_eq!(row.article_type, ArticleType::Waiting);
        assert_eq!(row.status, "waiting");
        assert!(
            row.file_path.ends_with("[待审核] 待审文章.md"),
            "{}",
            row.file_path
        );
    }

    #[test]
    fn pull_remote_keeps_local_file_when_dirty_and_counts_conflict() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "本地草稿", "本地已改");
        let mut row = ArticleRow::new("31", ArticleType::Waiting, 1);
        row.title = "旧标题".to_string();
        row.status = "waiting".to_string();
        row.author_id = "7".to_string();
        row.remote_modified = 100;
        row.content_hash = content_hash("上次同步的内容");
        row.file_path = file_path.clone();
        row.synced_at = 1;
        row.updated_at = 1;
        h.ctx().db.upsert_article(&row).unwrap();

        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 31, "title": "新标题", "status": "waiting", "modified": 200 }
            ])),
        );
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.conflicts, 1);
        assert_eq!(result.pulled, 0);
        // 本地内容没被覆盖。
        let content =
            String::from_utf8(h.ctx().files.read(Path::new(&file_path)).unwrap()).unwrap();
        assert_eq!(content, "本地已改");
        let after = h.ctx().db.get_article_by_cid("31").unwrap().unwrap();
        assert_eq!(after.title, "新标题");
        assert_eq!(after.remote_modified, 200);
        assert_eq!(after.content_hash, content_hash("上次同步的内容"));
        // 冲突判定优先于拉全文：没有发 contentsInfo（4 类各一次列表 = 4 个请求）。
        assert_eq!(h.requests().len(), 4);
    }

    #[test]
    fn pull_remote_skips_when_remote_is_not_newer() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "本地草稿", "内容");
        let mut row = ArticleRow::new("41", ArticleType::Post, 1);
        row.status = "publish".to_string();
        row.remote_modified = 500;
        row.content_hash = content_hash("内容");
        row.file_path = file_path;
        h.ctx().db.upsert_article(&row).unwrap();

        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 41, "title": "已发布", "status": "publish", "modified": 500 }
            ])),
        );
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.pulled, 0);
        assert_eq!(result.conflicts, 0);
        assert_eq!(result.total, 1);
        assert_eq!(h.requests().len(), 4);
    }

    #[test]
    fn pull_remote_overwrites_clean_local_file_and_reuses_path() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "旧名字", "旧内容");
        let mut row = ArticleRow::new("51", ArticleType::PostDraft, 1);
        row.content_hash = content_hash("旧内容");
        row.file_path = file_path.clone();
        row.remote_modified = 10;
        h.ctx().db.upsert_article(&row).unwrap();

        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 51, "title": "新名字", "status": "", "modified": 20 }
            ])),
        );
        h.http.enqueue(
            200,
            full_text("新名字", "# 新名字\n新内容", true, "post_draft"),
        );
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.pulled, 1, "{:?}", result.errors);
        let content =
            String::from_utf8(h.ctx().files.read(Path::new(&file_path)).unwrap()).unwrap();
        assert_eq!(content, "# 新名字\n新内容");
        let after = h.ctx().db.get_article_by_cid("51").unwrap().unwrap();
        assert_eq!(after.file_path, file_path, "覆盖内容时沿用旧路径、不改名");
        assert_eq!(after.title, "新名字");
        assert_eq!(after.content_hash, content_hash("# 新名字\n新内容"));
    }

    #[test]
    fn pull_remote_collects_per_type_errors_with_remote_prefix() {
        let h = Harness::new().with_api_config();
        // 草稿列表：服务端业务错误（code=0 → CoreError::Api）。
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 0, "msg": "列表炸了", "data": null }).to_string(),
        );
        // 待审核列表：空。
        h.http.enqueue(200, list_page(serde_json::json!([])));
        // 已发布列表：空。
        h.http.enqueue(200, list_page(serde_json::json!([])));
        // 已拒绝列表：同样业务错误，但要静默。
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 0, "msg": "拒绝炸了", "data": null }).to_string(),
        );

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        // 1.x 的 `if (remote !== 'reject')` 恒真（`remote` 只有 post_draft/post），
        // 所以「已拒绝」那一类的列表错误也会以 `post: ` 前缀进 errors。
        assert_eq!(
            result.errors,
            vec![
                "post_draft: 列表炸了".to_string(),
                "post: 拒绝炸了".to_string()
            ]
        );
        assert_eq!(result.total, 0);
    }

    #[test]
    fn pull_remote_records_article_error_when_full_text_fails() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 61, "title": "坏文章", "status": "", "modified": 1_700_000_000 }
            ])),
        );
        h.http.enqueue(500, "boom".to_string());
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.pulled, 0);
        assert_eq!(result.errors.len(), 1);
        assert!(
            result.errors[0].starts_with("坏文章: "),
            "{:?}",
            result.errors
        );
    }

    #[test]
    fn pull_remote_downloads_images_and_rewrites_refs() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            list_page(serde_json::json!([
                { "cid": 71, "title": "带图", "status": "", "modified": 1_700_000_000 }
            ])),
        );
        h.http.enqueue(
            200,
            full_text(
                "带图",
                "# 带图\n![x](https://cdn.test/pic.png)",
                true,
                "post_draft",
            ),
        );
        h.http.enqueue(200, "PNGDATA".to_string());
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.pulled, 1, "{:?}", result.errors);
        let row = h.ctx().db.get_article_by_cid("71").unwrap().unwrap();
        let content =
            String::from_utf8(h.ctx().files.read(Path::new(&row.file_path)).unwrap()).unwrap();
        assert_eq!(content, "# 带图\n![x](./.image/71/pic.png)");
        let image = h
            .ctx()
            .files
            .read(&docs_root(&h).join(".image").join("71").join("pic.png"))
            .unwrap();
        assert_eq!(image, b"PNGDATA");
    }

    #[test]
    fn pull_remote_without_image_root_is_noop() {
        // 注意：清理逻辑本身（删除 `.image/<孤儿 cid>`）无法用 MemFiles 覆盖——
        // `MemFiles::list` 只返回「parent 恰好是该目录的文件」，不会返回子目录，
        // 因此 `.image/` 下的目录项在测试里永远不可见。这里只验证「没有 `.image` 时
        // 拉取正常结束」这一条早退分支；删除行为由代码评审 + 端到端手工验证兜底。
        let h = Harness::new().with_api_config();
        for _ in 0..4 {
            h.http.enqueue(200, list_page(serde_json::json!([])));
        }
        let result = pull_remote(h.ctx(), "tok", "7").unwrap();
        assert_eq!(result.total, 0);
        assert!(!docs_root(&h).join(".image").exists());
    }

    // ---------- 推送 ----------

    #[test]
    fn push_to_draft_converts_markdown_uploads_and_tracks_hash() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "我的标题", "# 我的标题\n正文");
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": { "cid": 81 } }).to_string(),
        );

        let result = push_to_draft(h.ctx(), "tok", &file_path).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.cid.as_deref(), Some("81"));
        assert_eq!(result.article_type, Some(ArticleType::PostDraft));

        let request = h.last_request();
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.hqsf.test/api/contentsadd");
        let expected = encode_form(&[
            (
                "params".to_string(),
                format!(
                    "{{\"title\":{}}}",
                    serde_json::to_string("我的标题").unwrap()
                ),
            ),
            ("token".to_string(), "tok".to_string()),
            // L5 已落地：text 就是 `infra::markdown::md_to_html` 的输出（与 1.x 逐字节对等）。
            ("text".to_string(), md_to_html("# 我的标题\n正文")),
            ("isSpace".to_string(), "0".to_string()),
            ("isDraft".to_string(), "1".to_string()),
            ("isMd".to_string(), "0".to_string()),
        ]);
        assert_eq!(
            String::from_utf8_lossy(request.body.as_deref().unwrap()),
            expected
        );

        let row = h
            .ctx()
            .db
            .get_article_by_file_path(&file_path)
            .unwrap()
            .unwrap();
        assert_eq!(row.cid, "81");
        assert_eq!(row.article_type, ArticleType::PostDraft);
        assert_eq!(row.status, "");
        assert_eq!(row.content_hash, content_hash("# 我的标题\n正文"));
        assert_eq!(row.synced_at, 1_700_000_000_000);
    }

    #[test]
    fn publish_passes_meta_params_in_1x_order() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "发布稿", "# 发布稿");
        // metasList: category / tag / active 各一次。
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": [{ "mid": 3, "name": "原创作品" }] })
                .to_string(),
        );
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": [{ "mid": 4, "name": "科幻" }] })
                .to_string(),
        );
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": [{ "id": 5, "name": "春季征文" }] })
                .to_string(),
        );
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": { "cid": 91 } }).to_string(),
        );
        let meta = ArticleMeta {
            category: Some("原创作品".to_string()),
            tags: Some(vec!["科幻".to_string()]),
            active: Some("春季征文".to_string()),
            isopen: Some(false),
        };

        let result = publish(h.ctx(), "tok", &file_path, Some(&meta)).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.article_type, Some(ArticleType::Waiting));

        let body = String::from_utf8_lossy(h.last_request().body.as_deref().unwrap()).into_owned();
        let params = encode_form(&[(
            "params".to_string(),
            r#"{"title":"发布稿","category":"3","tag":"4","active":"5","isopen":0}"#.to_string(),
        )]);
        assert!(body.contains(&params), "{body}");
        assert!(body.contains("isDraft=0"), "{body}");
        let row = h
            .ctx()
            .db
            .get_article_by_file_path(&file_path)
            .unwrap()
            .unwrap();
        assert_eq!(row.article_type, ArticleType::Waiting);
        assert_eq!(row.status, "waiting");
    }

    #[test]
    fn push_returns_ok_false_payload_on_api_error() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "失败稿", "# 失败稿");
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 0, "msg": "服务器炸了", "data": null }).to_string(),
        );

        let result = push_to_draft(h.ctx(), "tok", &file_path).unwrap();
        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("服务器炸了"));
        assert_eq!(result.cid, None);
        assert_eq!(result.article_type, None);
    }

    #[test]
    fn push_reports_missing_cid_when_server_returns_bare_number() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "没有 cid", "# 没有 cid");
        // contentsAdd 返回裸数字（实测形态）。
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": 1 }).to_string(),
        );
        // findCidByTitle 也查不到。
        h.http.enqueue(200, list_page(serde_json::json!([])));

        let result = push_to_draft(h.ctx(), "tok", &file_path).unwrap();
        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some(MSG_CID_MISSING));
    }

    #[test]
    fn push_uploads_local_images_before_conversion() {
        let h = Harness::new().with_api_config();
        let root = docs_root(&h);
        let img_dir = root.join(".image").join("local");
        h.ctx().files.create_dir_all(&img_dir).unwrap();
        h.ctx().files.write(&img_dir.join("a.png"), b"IMG").unwrap();
        let file_path = write_draft(&h, "带图稿", "# 带图稿\n![x](./.image/local/a.png)");
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": { "url": "https://cdn.test/a.png" } })
                .to_string(),
        );
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": { "cid": 101 } }).to_string(),
        );

        let result = push_to_draft(h.ctx(), "tok", &file_path).unwrap();
        assert!(result.ok, "{:?}", result.error);
        let requests = h.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].url, "https://api.hqsf.test/api/uploadfile");
        let body = String::from_utf8_lossy(requests[1].body.as_deref().unwrap()).into_owned();
        assert!(
            body.contains("https%3A%2F%2Fcdn.test%2Fa.png"),
            "上传后的 URL 应写进正文: {body}"
        );
    }

    // ---------- 转存草稿 / 编辑远端 ----------

    #[test]
    fn convert_to_draft_updates_remote_and_index() {
        let h = Harness::new().with_api_config();
        h.http
            .enqueue(200, full_text("待审稿", "# 待审稿\n正文", true, "post"));
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": {} }).to_string(),
        );

        let result = convert_to_draft(h.ctx(), "tok", "7", "111").unwrap();
        assert!(result.converted);

        let requests = h.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].url, "https://api.hqsf.test/api/contentsupdate");
        let body = String::from_utf8_lossy(requests[1].body.as_deref().unwrap()).into_owned();
        assert!(body.contains("isDraft=1"), "{body}");
        assert!(
            body.contains(&crate::infra::net::api::encode_form(&[(
                "text".to_string(),
                md_to_html("# 待审稿\n正文"),
            )])),
            "text 应为 md_to_html 的输出: {body}"
        );

        let row = h.ctx().db.get_article_by_cid("111").unwrap().unwrap();
        assert_eq!(row.article_type, ArticleType::PostDraft);
        assert_eq!(row.status, "");
        assert_eq!(row.title, "待审稿");
        assert_eq!(row.author_id, "7");
    }

    #[test]
    fn convert_to_draft_is_noop_when_remote_is_already_draft() {
        let h = Harness::new().with_api_config();
        h.http
            .enqueue(200, full_text("草稿", "正文", true, "post_draft"));
        let result = convert_to_draft(h.ctx(), "tok", "7", "121").unwrap();
        assert!(!result.converted);
        assert_eq!(h.requests().len(), 1, "不应调用 contentsUpdate");
    }

    #[test]
    fn convert_to_draft_returns_early_when_index_says_draft() {
        let h = Harness::new().with_api_config();
        let mut row = ArticleRow::new("131", ArticleType::PostDraft, 1);
        row.title = "草稿".to_string();
        h.ctx().db.upsert_article(&row).unwrap();

        let result = convert_to_draft(h.ctx(), "tok", "7", "131").unwrap();
        assert!(!result.converted);
        assert!(h.requests().is_empty(), "索引已是草稿时不应发任何请求");
    }

    #[test]
    fn convert_to_draft_rejects_empty_body() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(200, full_text("空", "", true, "post"));
        let err = convert_to_draft(h.ctx(), "tok", "7", "141").unwrap_err();
        assert_eq!(err.to_string(), MSG_EMPTY_BODY);
    }

    #[test]
    fn edit_remote_article_converts_and_writes_local_file() {
        let h = Harness::new().with_api_config();
        h.http
            .enqueue(200, full_text("待编辑", "# 待编辑\n正文", true, "post"));
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": {} }).to_string(),
        );

        let result = edit_remote_article(h.ctx(), "tok", "7", "151").unwrap();
        assert!(result.converted);
        assert!(
            result.file_path.ends_with("待编辑.md"),
            "{}",
            result.file_path
        );
        let content =
            String::from_utf8(h.ctx().files.read(Path::new(&result.file_path)).unwrap()).unwrap();
        assert_eq!(content, "# 待编辑\n正文");
        let row = h.ctx().db.get_article_by_cid("151").unwrap().unwrap();
        assert_eq!(row.article_type, ArticleType::PostDraft);
        assert_eq!(row.file_path, result.file_path);
        assert_eq!(row.content_hash, content_hash("# 待编辑\n正文"));
    }

    #[test]
    fn edit_remote_article_reuses_existing_file_and_refuses_dirty_file() {
        let h = Harness::new().with_api_config();
        let file_path = write_draft(&h, "本地", "本地已改");
        let mut row = ArticleRow::new("161", ArticleType::PostDraft, 1);
        row.title = "本地".to_string();
        row.file_path = file_path.clone();
        row.content_hash = content_hash("上次同步");
        h.ctx().db.upsert_article(&row).unwrap();

        let err = edit_remote_article(h.ctx(), "tok", "7", "161").unwrap_err();
        assert_eq!(err.to_string(), MSG_LOCAL_DIRTY);
        assert!(h.requests().is_empty(), "脏文件检查应发生在网络请求之前");

        // 把本地文件回退成「与索引一致」后，复用旧路径并覆盖内容。
        h.ctx()
            .files
            .write(Path::new(&file_path), "上次同步".as_bytes())
            .unwrap();
        h.http
            .enqueue(200, full_text("新内容", "# 新内容", true, "post_draft"));
        let result = edit_remote_article(h.ctx(), "tok", "7", "161").unwrap();
        assert!(!result.converted);
        assert_eq!(result.file_path, file_path);
        let content =
            String::from_utf8(h.ctx().files.read(Path::new(&file_path)).unwrap()).unwrap();
        assert_eq!(content, "# 新内容");
    }

    #[test]
    fn local_dirty_reads_missing_file_as_clean() {
        let h = Harness::new();
        let mut row = ArticleRow::new("171", ArticleType::PostDraft, 1);
        row.file_path = format!("{}/不存在.md", docs_root(&h).display());
        row.content_hash = content_hash("x");
        assert!(!is_local_dirty(h.ctx(), &row));
    }

    #[test]
    fn push_errors_when_file_is_outside_docs_root() {
        let h = Harness::new();
        let err = push_to_draft(h.ctx(), "tok", "/etc/passwd").unwrap_err();
        assert_eq!(err.to_string(), "路径越界：仅允许访问本地存档目录");
    }

    #[test]
    fn push_errors_when_file_is_missing() {
        let h = Harness::new();
        let root = docs_root(&h);
        let missing = format!("{}/缺.md", root.display());
        let err = push_to_draft(h.ctx(), "tok", &missing).unwrap_err();
        // 1.x 这里是 `readFileSync` 的 ENOENT；内核统一映射为 `NotFound`（`未找到：<path>`）。
        assert_eq!(err.to_string(), format!("未找到：{missing}"));
    }

    #[test]
    fn js_helper_is_available_for_debugging() {
        assert_eq!(js(&serde_json::json!(3)), "3");
        assert_eq!(
            norm_ts(Some(&serde_json::json!(1_700_000_000_123i64))),
            1_700_000_000
        );
    }
}
