//! 同步域命令（1.x `src/main/ipc/sync.handlers.ts`，4 条通道）。
//!
//! 逐条对应：
//! - `hqsf:sync-pull` → [`sync_pull`]
//! - `hqsf:sync-push` → [`sync_push`]
//! - `hqsf:convert-to-draft` → [`convert_to_draft`]
//! - `hqsf:edit-remote-article` → [`edit_remote_article`]
//!
//! 命令层只做 1.x handler 里那点「取 token / uid、校验空 cid」的事，同步规则全在
//! [`crate::services::sync`]、HTTP 形状在 [`crate::adapters::sync`]、纯规则在
//! [`crate::domain::sync`]。
//!
//! 与 1.x 的差异：`trusted(event)` 是 Electron 的 sender 校验（`sync.handlers.ts` 每条的第一行），
//! Tauri 下命令只由本应用窗口的 IPC 触发，等价保护由壳层负责，内核不做（同 docs lane 约定）。
//! `sync-push` 的失败**不是** Err 而是载荷里的 `{ok:false,error}`（1.x 直接透传 service 返回值），
//! 这里保持同样形状。

use crate::CoreCtx;
use crate::domain::sync::{
    ArticleMeta, ConvertDraftResult, EditRemoteResult, PullResult, PushResult,
};
use crate::error::{CoreError, CoreResult};
use crate::services::{auth, net, sync as sync_service};

/// 1.x `sync.handlers.ts:13` / `:24`：拉取与推送共用一句未登录文案。
pub const MSG_NOT_LOGGED_IN_PULL_OR_PUSH: &str = "未登录，无法同步";
/// 1.x `sync.handlers.ts:35`。
pub const MSG_NOT_LOGGED_IN_CONVERT: &str = "未登录，无法转存草稿";
/// 1.x `sync.handlers.ts:49`。
pub const MSG_NOT_LOGGED_IN_EDIT: &str = "未登录，无法编辑";
/// 1.x `sync.handlers.ts:37` / `:51`：`String(cid ?? '').trim()` 为空时的文案。
pub const MSG_MISSING_CID: &str = "缺少文章 ID";

/// `hqsf:sync-pull` → `PullResult{pulled,conflicts,total,errors}`。
///
/// 1.x 的登录判定是 `token && uid` 两个都非空（`sync.handlers.ts:11-13`），且 **uid 只认
/// `userinfo.uid`**（不兜底 `id`）——见 [`sync_service::pull_uid`]。
pub fn sync_pull(ctx: &CoreCtx) -> CoreResult<PullResult> {
    let token = net::token(ctx)?;
    let uid = sync_service::pull_uid(ctx)?;
    let Some(token) = token else {
        return Err(CoreError::app(MSG_NOT_LOGGED_IN_PULL_OR_PUSH));
    };
    if uid.is_empty() {
        return Err(CoreError::app(MSG_NOT_LOGGED_IN_PULL_OR_PUSH));
    }
    sync_service::pull_remote(ctx, &token, &uid)
}

/// `hqsf:sync-push`（`filePath`、`isDraft`、`meta?`）→ `PushResult{ok,cid?,type?,error?}`。
///
/// 1.x handler 只校验 token（不需要 uid），然后 `isDraft ? pushToDraft : publish`；
/// 失败以 `{ok:false,error}` 载荷返回，因此这里的 `Err` 只用于「未登录」这一类。
pub fn sync_push(
    ctx: &CoreCtx,
    file_path: String,
    is_draft: bool,
    meta: Option<ArticleMeta>,
) -> CoreResult<PushResult> {
    let token = net::token(ctx)?.ok_or_else(|| CoreError::app(MSG_NOT_LOGGED_IN_PULL_OR_PUSH))?;
    sync_service::push(ctx, &token, &file_path, is_draft, meta.as_ref())
}

/// `hqsf:convert-to-draft`（`cid`）→ `ConvertDraftResult{converted}`。
pub fn convert_to_draft(ctx: &CoreCtx, cid: String) -> CoreResult<ConvertDraftResult> {
    let token = net::token(ctx)?.ok_or_else(|| CoreError::app(MSG_NOT_LOGGED_IN_CONVERT))?;
    let key = cid.trim();
    if key.is_empty() {
        return Err(CoreError::app(MSG_MISSING_CID));
    }
    // 1.x 这里用 `uid ?? id`（`sync.handlers.ts:38`），与 sync-pull 的「只认 uid」不同。
    let uid = auth::session_uid(ctx);
    sync_service::convert_to_draft(ctx, &token, &uid, key)
}

/// `hqsf:edit-remote-article`（`cid`）→ `EditRemoteResult{filePath,converted}`。
pub fn edit_remote_article(ctx: &CoreCtx, cid: String) -> CoreResult<EditRemoteResult> {
    let token = net::token(ctx)?.ok_or_else(|| CoreError::app(MSG_NOT_LOGGED_IN_EDIT))?;
    let key = cid.trim();
    if key.is_empty() {
        return Err(CoreError::app(MSG_MISSING_CID));
    }
    let uid = auth::session_uid(ctx);
    sync_service::edit_remote_article(ctx, &token, &uid, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use serde_json::{Map, Value, json};

    use crate::infra::fs;
    use crate::infra::session::{self, SessionData};
    use crate::testkit::Harness;

    fn login(h: &Harness, token: &str, userinfo: Map<String, Value>) {
        let data = SessionData {
            token: token.to_string(),
            userinfo,
            insecure: false,
        };
        session::save(h.ctx(), &data).unwrap();
    }

    fn uid_only(uid: u64) -> Map<String, Value> {
        let mut userinfo = Map::new();
        userinfo.insert("uid".into(), json!(uid));
        userinfo
    }

    fn docs_root(h: &Harness) -> PathBuf {
        fs::ensure_docs_root(h.ctx().files.as_ref(), &h.ctx().paths, &h.ctx().db).unwrap()
    }

    fn write_draft(h: &Harness, title: &str, content: &str) -> String {
        let root = docs_root(h);
        fs::create_local_draft(h.ctx().files.as_ref(), &root, title, content, "").unwrap()
    }

    fn empty_list() -> String {
        json!({ "code": 1, "msg": "", "data": [], "total": 0 }).to_string()
    }

    // ---------- 未登录 / 参数校验 ----------

    #[test]
    fn sync_pull_requires_login() {
        let h = Harness::new().with_api_config();
        let err = sync_pull(h.ctx()).unwrap_err();
        assert_eq!(err.to_string(), MSG_NOT_LOGGED_IN_PULL_OR_PUSH);
    }

    #[test]
    fn sync_pull_requires_uid_even_with_token() {
        let h = Harness::new().with_api_config();
        // 只有 token、没有会话 userinfo.uid：1.x `if (!token || !uid)` 同样拒绝。
        login(&h, "tok", Map::new());
        let err = sync_pull(h.ctx()).unwrap_err();
        assert_eq!(err.to_string(), MSG_NOT_LOGGED_IN_PULL_OR_PUSH);
    }

    #[test]
    fn sync_pull_does_not_fall_back_to_id() {
        let h = Harness::new().with_api_config();
        let mut userinfo = Map::new();
        userinfo.insert("id".into(), json!(42));
        login(&h, "tok", userinfo);
        let err = sync_pull(h.ctx()).unwrap_err();
        assert_eq!(err.to_string(), MSG_NOT_LOGGED_IN_PULL_OR_PUSH);
    }

    #[test]
    fn sync_push_requires_login() {
        let h = Harness::new().with_api_config();
        let err = sync_push(h.ctx(), "/x.md".to_string(), true, None).unwrap_err();
        assert_eq!(err.to_string(), MSG_NOT_LOGGED_IN_PULL_OR_PUSH);
    }

    #[test]
    fn convert_to_draft_requires_login_and_cid() {
        let h = Harness::new().with_api_config();
        let err = convert_to_draft(h.ctx(), "7".to_string()).unwrap_err();
        assert_eq!(err.to_string(), MSG_NOT_LOGGED_IN_CONVERT);

        login(&h, "tok", Map::new());
        let err = convert_to_draft(h.ctx(), "   ".to_string()).unwrap_err();
        assert_eq!(err.to_string(), MSG_MISSING_CID);
    }

    #[test]
    fn edit_remote_article_requires_login_and_cid() {
        let h = Harness::new().with_api_config();
        let err = edit_remote_article(h.ctx(), "7".to_string()).unwrap_err();
        assert_eq!(err.to_string(), MSG_NOT_LOGGED_IN_EDIT);

        login(&h, "tok", Map::new());
        let err = edit_remote_article(h.ctx(), "".to_string()).unwrap_err();
        assert_eq!(err.to_string(), MSG_MISSING_CID);
    }

    // ---------- 成功路径 ----------

    #[test]
    fn sync_pull_runs_all_four_kinds_with_uid() {
        let h = Harness::new().with_api_config();
        login(&h, "tok", uid_only(7));
        for _ in 0..4 {
            h.http.enqueue(200, empty_list());
        }

        let result = sync_pull(h.ctx()).unwrap();
        assert_eq!(result.total, 0);
        assert_eq!(result.pulled, 0);
        assert_eq!(result.conflicts, 0);
        assert!(result.errors.is_empty());

        let requests = h.requests();
        assert_eq!(requests.len(), 4);
        // 四类的 searchParams 都带 authorId=7；草稿类 type=post_draft，其余 type=post + status。
        assert!(requests[0].url.contains("authorId"), "{}", requests[0].url);
    }

    #[test]
    fn sync_push_draft_delegates_to_push_to_draft() {
        let h = Harness::new().with_api_config();
        login(&h, "tok", Map::new());
        let file_path = write_draft(&h, "命令层草稿", "# 命令层草稿");
        h.http.enqueue(
            200,
            json!({ "code": 1, "msg": "", "data": { "cid": 88 } }).to_string(),
        );

        let result = sync_push(h.ctx(), file_path, true, None).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.cid.as_deref(), Some("88"));
        assert_eq!(
            result.article_type,
            Some(crate::domain::article::ArticleType::PostDraft)
        );
    }

    #[test]
    fn sync_push_publish_passes_meta_and_waits_for_review() {
        let h = Harness::new().with_api_config();
        login(&h, "tok", Map::new());
        let file_path = write_draft(&h, "命令层发布", "# 命令层发布");
        h.http.enqueue(
            200,
            json!({ "code": 1, "msg": "", "data": { "cid": 99 } }).to_string(),
        );
        let meta = ArticleMeta {
            category: None,
            tags: None,
            active: None,
            isopen: Some(true),
        };

        let result = sync_push(h.ctx(), file_path, false, Some(meta)).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(
            result.article_type,
            Some(crate::domain::article::ArticleType::Waiting)
        );
        let body = String::from_utf8_lossy(h.last_request().body.as_deref().unwrap()).into_owned();
        assert!(body.contains("isDraft=0"), "{body}");
        assert!(
            body.contains("isopen%22%3A1"),
            "meta.isopen 应进 params: {body}"
        );
    }

    #[test]
    fn convert_to_draft_trims_cid_before_calling_service() {
        let h = Harness::new().with_api_config();
        login(&h, "tok", uid_only(7));
        // contentsInfo 的 mock 是裸对象（`fetchRemoteObject` 不消费 `{code,msg,data}` 信封）。
        h.http.enqueue(
            200,
            json!({ "title": "草稿", "text": "正文", "markdown": 1, "type": "post_draft" })
                .to_string(),
        );

        let result = convert_to_draft(h.ctx(), " 123 ".to_string()).unwrap();
        // 远端本来就是草稿 → converted=false，但请求里 cid 必须是修剪后的 "123"。
        assert!(!result.converted);
        assert_eq!(h.requests().len(), 1);
        // 有 token 时编辑形态先走 POST（body `key=<cid>`）。
        let body = String::from_utf8_lossy(h.requests()[0].body.as_deref().unwrap()).into_owned();
        assert!(body.contains("key=123"), "{body}");
    }

    #[test]
    fn edit_remote_article_returns_file_path() {
        let h = Harness::new().with_api_config();
        login(&h, "tok", Map::new());
        h.http.enqueue(
            200,
            json!({ "title": "远端文章", "text": "# 远端文章", "markdown": 1, "type": "post_draft" }).to_string(),
        );

        let result = edit_remote_article(h.ctx(), "321".to_string()).unwrap();
        assert!(
            result.file_path.ends_with("远端文章.md"),
            "{}",
            result.file_path
        );
        assert!(!result.converted);
    }
}
