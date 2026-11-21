//! 浏览命令层（1.x `src/main/ipc/browse.handlers.ts`）。
//!
//! `list-categories` / `list-metas` / `list-gpt-models` 是公开读（未登录也返回数据）；
//! `check-forbidden` 需要登录——1.x 用 `fail('未登录')` 传字符串导致 `error: undefined`
//! （A3 类 bug），这里按正常中文文案返回 `未登录`。

use serde::Deserialize;
use specta::Type;

use crate::adapters::browse::{self, ForbiddenCheck, GptModel};
use crate::adapters::read::{self, CategoryMeta, MetaInfo};
use crate::ctx::CoreCtx;
use crate::domain::user::{JsonScalar, js_str_param};
use crate::error::CoreResult;

/// `list-metas` 参数：栏目类型（`active`/`category`/`tag`/…）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseMetasArgs {
    /// TS 字段名就是 `type`。
    #[serde(rename = "type")]
    pub meta_type: Option<JsonScalar>,
}

/// `check-forbidden` 参数：标题 + 正文。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckForbiddenArgs {
    pub title: Option<JsonScalar>,
    pub text: Option<JsonScalar>,
}

/// 作品库分类列表。
pub fn list_categories(ctx: &CoreCtx) -> CoreResult<Vec<CategoryMeta>> {
    read::list_categories(ctx)
}

/// 栏目/活动/tag 列表。
pub fn list_metas(ctx: &CoreCtx, args: BrowseMetasArgs) -> CoreResult<Vec<MetaInfo>> {
    read::list_metas(ctx, &js_str_param(args.meta_type.as_ref()))
}

/// 违禁词检测（未登录报 `未登录`）。
pub fn check_forbidden(ctx: &CoreCtx, args: CheckForbiddenArgs) -> CoreResult<ForbiddenCheck> {
    browse::check_text_block_status(
        ctx,
        &js_str_param(args.title.as_ref()),
        &js_str_param(args.text.as_ref()),
    )
}

/// GPT 模型列表。
pub fn list_gpt_models(ctx: &CoreCtx) -> CoreResult<Vec<GptModel>> {
    browse::list_gpt_models(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Harness;

    #[test]
    fn list_metas_passes_type() {
        let harness = Harness::new().with_api_config();
        harness
            .http
            .enqueue(200, serde_json::json!({"code": 1, "data": []}).to_string());
        let metas = list_metas(
            harness.ctx(),
            BrowseMetasArgs {
                meta_type: Some(JsonScalar::Text("active".to_string())),
            },
        )
        .expect("metas");
        assert!(metas.is_empty());
        let request = harness.last_request();
        assert!(
            request
                .url
                .contains("searchParams=%7B%22type%22%3A%22active%22%7D")
        );
    }

    #[test]
    fn check_forbidden_without_token_reports_normal_text() {
        let harness = Harness::new().with_api_config();
        let err = check_forbidden(
            harness.ctx(),
            CheckForbiddenArgs {
                title: Some(JsonScalar::Text("标题".to_string())),
                text: Some(JsonScalar::Text("正文".to_string())),
            },
        )
        .expect_err("should fail");
        assert_eq!(err.to_string(), "未登录");
    }

    #[test]
    fn check_forbidden_posts_title_and_text() {
        let harness = Harness::new().with_api_config().with_token("tok");
        harness.http.enqueue(
            200,
            serde_json::json!({"code": 1, "msg": "", "data": []}).to_string(),
        );
        let check = check_forbidden(
            harness.ctx(),
            CheckForbiddenArgs {
                title: Some(JsonScalar::Text("标题".to_string())),
                text: Some(JsonScalar::Text("正文".to_string())),
            },
        )
        .expect("check");
        assert_eq!(check.code, 1);
        let request = harness.last_request();
        assert_eq!(request.method, "POST");
        let body = String::from_utf8(request.body.expect("body")).expect("utf8");
        // 1.x 发的是 `title + mdToHtml(markdown)`（read.adapter.ts:1025）。
        let expected_text = format!("标题{}", crate::infra::markdown::md_to_html("正文"));
        assert!(
            body.contains(&crate::infra::net::api::encode_form(&[(
                "text".to_string(),
                expected_text
            )])),
            "{body}"
        );
        assert!(body.contains("token=tok"));
    }
}
