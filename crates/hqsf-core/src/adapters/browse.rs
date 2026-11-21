//! 浏览/栏目适配层（1.x `ipc/browse.handlers.ts` + `adapters/read.adapter.ts` 的
//! `listMetas` / `listCategories` / `listGptModels` / `checkTextBlockStatus`）。
//!
//! 归属说明：`list-categories` / `list-metas` / `list-gpt-models` 三条通道归本 lane，
//! 其中 metas/categories 的字段规整在 read lane 的 `adapters/read.rs`（`MetaInfo` /
//! `CategoryMeta` 是那边共享出来的类型，避免同名类型两份），本模块只做命令层转发；
//! gpt 模型与违禁词检测的 HTTP 调用在本模块（read lane 不提供）。
//!
//! 1.x `check-forbidden` 的「未登录」分支是 `fail('未登录')`——传字符串给 `fail` 会得到
//! `error: undefined`（A3 已知 bug）。Rust 统一 `CoreError::app("未登录")`，属有意的行为修正。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::ctx::CoreCtx;
use crate::domain::user::{array_or_empty, num_at, str_at};
use crate::error::CoreResult;
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::services::net;

/// AI 模型（1.x `GptModel`，推荐栏目「AI模型」）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GptModel {
    pub id: String,
    pub name: String,
    pub intro: String,
    /// 1.x 恒输出字符串（缺失为空串），TS 侧是 `avatar?: string`
    pub avatar: String,
    #[serde(rename = "type")]
    pub kind: i64,
    pub price: i64,
    pub source: String,
}

/// 违禁词检测结果（1.x `{ code, msg }`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForbiddenCheck {
    pub code: i64,
    pub msg: String,
}

/// 原始模型条目 → `GptModel`。
pub fn to_gpt_model(item: &Value) -> GptModel {
    GptModel {
        id: str_at(item, &["id", "mid"]),
        name: str_at(item, &["name"]),
        intro: str_at(item, &["intro"]),
        avatar: str_at(item, &["avatar"]),
        kind: num_at(item, &["type"]),
        price: num_at(item, &["price"]),
        source: str_at(item, &["source"]),
    }
}

/// 推荐栏目「AI模型」列表（`gptList`，公开接口，token 可选）。
pub fn list_gpt_models(ctx: &CoreCtx) -> CoreResult<Vec<GptModel>> {
    let mut options = ApiOptions::get()
        .query("searchParams", "{}")
        .query("limit", "100")
        .query("page", "1")
        .query("order", "created");
    if let Some(token) = net::token(ctx)? {
        options = options.query("token", &token);
    }
    let resp = net::request::<Value>(ctx, endpoints::GPT_LIST, &options)?;
    Ok(array_or_empty(&resp.data)
        .iter()
        .map(to_gpt_model)
        .collect())
}

/// 违禁词检测（`hqContents/userTextBlockStatus`，POST `{text, token}`）。
///
/// 1.x 先把 markdown 用 `mdToHtml` 转成 HTML 再拼 `title + html`（`read.adapter.ts:1025`），
/// 这里同样走 L5 的 `infra::markdown::md_to_html`（与 1.x 逐字节对等）。
pub fn check_text_block_status(
    ctx: &CoreCtx,
    title: &str,
    markdown: &str,
) -> CoreResult<ForbiddenCheck> {
    let token = net::require_token(ctx, "未登录")?;
    let text = format!("{title}{}", crate::infra::markdown::md_to_html(markdown));
    let resp = net::request::<Value>(
        ctx,
        endpoints::USER_TEXT_BLOCK_STATUS,
        &ApiOptions::post().body("text", &text).body("token", &token),
    )?;
    Ok(ForbiddenCheck {
        code: resp.code,
        msg: resp.msg,
    })
}

#[cfg(test)]
mod tests {
    use crate::testkit::Harness;

    use super::*;

    #[test]
    fn to_gpt_model_normalizes_fields() {
        let raw = serde_json::json!({
            "mid": "3",
            "name": "GPT-4o",
            "intro": "通用",
            "type": "2",
            "price": "5",
            "source": "openai"
        });
        let m = to_gpt_model(&raw);
        assert_eq!(m.id, "3");
        assert_eq!(m.name, "GPT-4o");
        assert_eq!(m.avatar, "");
        assert_eq!(m.kind, 2);
        assert_eq!(m.price, 5);
        assert_eq!(m.source, "openai");
    }

    #[test]
    fn list_gpt_models_sends_expected_query_and_maps_items() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":[{"id":"1","name":"m","type":0,"price":2}]}"#.to_string(),
        );
        let out = list_gpt_models(h.ctx()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "m");
        let url = h.last_request().url;
        assert!(url.contains("/api/gptlist"), "{url}");
        assert!(url.contains("limit=100"), "{url}");
        assert!(url.contains("order=created"), "{url}");
        // 未登录时不带 token
        assert!(!url.contains("token="), "{url}");
    }

    #[test]
    fn list_gpt_models_appends_token_when_logged_in() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":1,"msg":"","data":[]}"#.to_string());
        list_gpt_models(h.ctx()).unwrap();
        assert!(h.last_request().url.contains("token=tok"));
    }

    #[test]
    fn check_text_block_status_posts_title_plus_text() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":1,"msg":"ok","data":null}"#.to_string());
        let out = check_text_block_status(h.ctx(), "标题", "正文").unwrap();
        assert_eq!(out.code, 1);
        assert_eq!(out.msg, "ok");
        let last = h.last_request();
        assert_eq!(last.method, "POST");
        let body = String::from_utf8_lossy(last.body.as_deref().unwrap_or_default()).to_string();
        assert!(body.contains("token=tok"), "{body}");
        assert!(body.contains("%E6%A0%87%E9%A2%98"), "{body}");
    }

    #[test]
    fn check_text_block_status_requires_login_with_plain_wording() {
        let h = Harness::new().with_api_config();
        let err = check_text_block_status(h.ctx(), "t", "b").unwrap_err();
        // A3：1.x 是 fail('未登录') → error undefined；Rust 修正为正常中文
        assert_eq!(err.to_string(), "未登录");
        assert!(h.requests().is_empty());
    }
}
