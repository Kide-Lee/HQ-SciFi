//! 阅读域命令（对应 `src/main/ipc/read.handlers.ts`，2 条通道）。
//!
//! 逐条对应：
//! - `hqsf:list-remote-articles` → [`list_remote_articles`]
//! - `hqsf:get-remote-article` → [`get_remote_article`]
//!
//! 命令层只做「取 token / uid → 调 adapter → 返回」，规整逻辑全在
//! [`crate::adapters::read`]。`list-metas` / `list-categories` 等底层读取 **不是** 本
//! lane 的通道（归 L7b），但它们的 adapter 仍在 `adapters/read.rs` 供各 lane 复用。

use serde::Deserialize;
use specta::Type;

use crate::CoreError;
use crate::CoreResult;
use crate::adapters::read::{
    self, ArticleDetail, ArticleFetchError, ArticleListOptions, ArticleListOut,
};
use crate::ctx::CoreCtx;
use crate::domain::review as review_rules;
use crate::services::net;

/// 未登录且服务端确认文章不可读时的文案前缀（`src/main/ipc/read.handlers.ts:27-30`）。
const READ_FULL_REQUIRES_LOGIN: &str = "阅读全文需要登录（";

/// `hqsf:list-remote-articles` 入参（1.x `opts: ArticleListOptions = {}`）。
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ListRemoteArticlesArgs {
    pub opts: Option<ArticleListOptions>,
}

/// `hqsf:list-remote-articles`：远端文章列表（信息流 / 精选 / 栏目筛选）。
pub fn list_remote_articles(
    ctx: &CoreCtx,
    args: ListRemoteArticlesArgs,
) -> CoreResult<ArticleListOut> {
    let opts = args.opts.unwrap_or_default();
    read::list_remote_articles(ctx, &opts)
}

/// `hqsf:get-remote-article` 入参。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GetRemoteArticleArgs {
    pub cid: String,
}

/// `hqsf:get-remote-article`：文章详情（带 10 分钟缓存与匿名作者脱敏）。
///
/// 1.x 的失败分支：**未登录**且错误是「服务端明确拒绝」时才包装成
/// `阅读全文需要登录（原因）`；网络故障原样透传（`read.handlers.ts:26-31`）。
pub fn get_remote_article(ctx: &CoreCtx, args: GetRemoteArticleArgs) -> CoreResult<ArticleDetail> {
    let token = net::token(ctx)?;
    let uid = read::session_uid(ctx)?;
    match read::fetch_remote_article(ctx, &args.cid, uid.as_deref()) {
        Ok(detail) => Ok(detail),
        Err(err) => {
            if token.is_none() && err.is_unavailable() {
                let reason = match &err {
                    ArticleFetchError::Unavailable(reason) => reason.clone(),
                    _ => String::new(),
                };
                let inner = if reason.is_empty() {
                    review_rules::ARTICLE_UNAVAILABLE_REASON.to_string()
                } else {
                    reason
                };
                Err(CoreError::app(format!(
                    "{READ_FULL_REQUIRES_LOGIN}{inner}）"
                )))
            } else {
                Err(err.into_core_error())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;
    use serde_json::json;

    fn contents_info_ok() -> String {
        json!({
            "title": "标题",
            "text": "正文",
            "score": "8.5",
            "authorId": 7,
            "userJson": {"uid": 7, "name": "作者"},
            "views": 3,
            "likes": 1,
            "commentsNum": 2,
            "created": 1_600_000_000,
            "modified": 1_600_000_001,
            "isAnonymous": false,
            "isLikes": 0,
            "markdown": 1,
            "introduction": "[music 163]x[/music 163]引言",
            "type": "post",
            "status": "approved"
        })
        .to_string()
    }

    #[test]
    fn list_remote_articles_forwards_options() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(
            200,
            json!({"code": 1, "msg": "ok", "total": 1, "data": [
                {"cid": 11, "title": "标题"}
            ]})
            .to_string(),
        );
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = list_remote_articles(
            &h.ctx,
            ListRemoteArticlesArgs {
                opts: Some(ArticleListOptions {
                    order: Some("created".to_string()),
                    limit: Some(5),
                    page: Some(2),
                    ..ArticleListOptions::default()
                }),
            },
        )
        .unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.total, 1);
        let request = h.requests().into_iter().next().unwrap();
        assert!(request.url.contains("/api/contentslist"));
        assert!(request.url.contains("limit=5"));
        assert!(request.url.contains("page=2"));
        assert!(request.url.contains("order=created"));
        assert!(request.url.contains("token=t"));
    }

    #[test]
    fn list_remote_articles_defaults_to_post_type() {
        let h = Harness::new().with_api_config();
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let out = list_remote_articles(&h.ctx, ListRemoteArticlesArgs::default()).unwrap();
        assert!(out.items.is_empty());
        assert_eq!(out.total, 0);
        // 最后一次请求是 metasList（活动 mid 集合），第一条才是文章列表。
        let request = h.requests().into_iter().next().unwrap();
        assert!(request.url.contains("limit=20"));
        assert!(request.url.contains("page=1"));
        assert!(request.url.contains("searchParams="));
    }

    #[test]
    fn get_remote_article_returns_adapted_detail() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(200, contents_info_ok());
        h.http
            .enqueue(200, json!({"code": 1, "msg": "ok", "data": []}).to_string());
        let detail = get_remote_article(
            &h.ctx,
            GetRemoteArticleArgs {
                cid: "42".to_string(),
            },
        )
        .unwrap();
        assert_eq!(detail.cid, "42");
        assert_eq!(detail.title, "标题");
        assert_eq!(detail.author_id, "7");
        assert_eq!(detail.introduction.as_deref(), Some("引言"));
        let first = h.requests().into_iter().next().unwrap();
        assert!(first.url.contains("/api/contentsinfo"));
        assert!(first.url.contains("key=42"));
    }

    #[test]
    fn get_remote_article_requires_login_when_not_logged_in() {
        let h = Harness::new().with_api_config();
        // 无 token：先 GET isMd=1、再 GET isMd=0，两次都是「没有 title 的响应」。
        h.http.enqueue(200, json!({"msg": ""}).to_string());
        h.http.enqueue(200, json!({"msg": ""}).to_string());
        let err = get_remote_article(
            &h.ctx,
            GetRemoteArticleArgs {
                cid: "42".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "阅读全文需要登录（未公开或不存在）");
    }

    #[test]
    fn get_remote_article_passes_through_unavailable_when_logged_in() {
        let h = Harness::new().with_api_config().with_token("t");
        h.http.enqueue(200, json!({"msg": ""}).to_string());
        h.http.enqueue(200, json!({"msg": ""}).to_string());
        h.http.enqueue(200, json!({"msg": ""}).to_string());
        let err = get_remote_article(
            &h.ctx,
            GetRemoteArticleArgs {
                cid: "42".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "拉取文章失败: 未公开或不存在");
    }
}
