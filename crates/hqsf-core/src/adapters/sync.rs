//! 同步相关 API 适配（1.x `src/main/services/sync-service.ts` 里直接内联的 HTTP 形状）。
//!
//! 拆到这里只为让 `services::sync` 专注编排（DB/文件/图片），所有「接口名 + 查询参数 +
//! 响应字段名」都收敛在本文件，便于和 `api.config.json` / 接口调研文档对照。
//!
//! 逐字对齐 1.x 的点：
//! - `contentsList` 的 `searchParams` 是 `JSON.stringify` 出来的字符串，字段顺序
//!   `type[,status],authorId`；分页 `limit=50`，终止条件 `page*PAGE_SIZE>=total || 空页`。
//! - `contentsAdd`/`contentsUpdate` 的 form body 字段顺序 `params, token, text, isSpace,
//!   isDraft, isMd`。
//! - 远端 `code != 1` 已由 `infra::net::api::api_request` 转成 `CoreError::Api`，本层不重复校验。

use serde_json::Value;

use crate::CoreCtx;
use crate::adapters::read::{ArticleFetchError, fetch_remote_object, field, js_to_string};
use crate::domain::sync::{PAGE_SIZE, update_draft_params_json};
use crate::error::CoreResult;
use crate::infra::net::api::{ApiOptions, ApiResponse};
use crate::infra::net::config::endpoints;
use crate::services::net;

/// `contentsList` 的一个条目（只保留拉取合并需要的最小字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteListItem {
    /// `String(item.cid ?? '')`；空串在合并时跳过。
    pub cid: String,
    /// `item.title ?? '未命名'`。
    pub title: String,
    /// `item.status ?? ''`。
    pub status: String,
    /// `normTs(item.modified)`（秒）。
    pub modified: i64,
}

/// `contentsInfo` 编辑形态拉回来的全文（1.x `fetchFullText` 的返回值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFullText {
    pub title: String,
    pub html: String,
    /// 服务端 `markdown===1` 时 `html` 其实是 md 原文。
    pub markdown: bool,
    /// 服务端 `type`（`post_draft` / `post` …）。
    pub article_type: Option<String>,
}

/// 拉取某一态的远端列表（1.x `listRemote`），自动翻页。
///
/// 返回 `Vec<RemoteListItem>`（保持服务端顺序；合并按该顺序处理，影响 `errors` 顺序）。
pub fn list_remote(
    ctx: &CoreCtx,
    token: &str,
    author_id: &str,
    remote_type: &str,
    status: Option<&str>,
) -> CoreResult<Vec<RemoteListItem>> {
    let search_params = match status {
        Some(status) => format!(
            "{{\"type\":{},\"status\":{},\"authorId\":{}}}",
            json_str(remote_type),
            json_str(status),
            json_str(author_id)
        ),
        None => format!(
            "{{\"type\":{},\"authorId\":{}}}",
            json_str(remote_type),
            json_str(author_id)
        ),
    };

    let mut items: Vec<RemoteListItem> = Vec::new();
    let mut page: i64 = 1;
    loop {
        let options = ApiOptions::get()
            .query("searchParams", &search_params)
            .query("limit", PAGE_SIZE.to_string())
            .query("page", page.to_string())
            .query("token", token);
        let response: ApiResponse<Value> = net::request(ctx, endpoints::CONTENTS_LIST, &options)?;
        // 1.x `resp.data ?? []`；非数组（脏数据）按空列表处理（1.x 的 `...list` 会抛
        // TypeError 并被上层 catch 成 `errors` 一项，这里选择不把脏数据当失败）。
        let list = match &response.data {
            Value::Array(list) => list.clone(),
            _ => Vec::new(),
        };
        for item in &list {
            items.push(remote_item(item));
        }
        let total = response.total.unwrap_or(list.len() as i64);
        if page.saturating_mul(PAGE_SIZE) >= total || list.is_empty() {
            break;
        }
        page += 1;
    }
    Ok(items)
}

/// 单条 `contentsList` 条目 → [`RemoteListItem`]（1.x `pullRemote` 的字段取值）。
fn remote_item(item: &Value) -> RemoteListItem {
    let title = match field(item, "title") {
        Some(Value::String(title)) => title.clone(),
        Some(_) => js_to_string(field(item, "title").unwrap_or(&Value::Null)),
        None => "未命名".to_string(),
    };
    RemoteListItem {
        cid: field(item, "cid").map(js_to_string).unwrap_or_default(),
        title,
        status: field(item, "status").map(js_to_string).unwrap_or_default(),
        modified: crate::adapters::read::norm_ts(field(item, "modified")),
    }
}

/// 拉一篇文章的全文（1.x `fetchFullText`）：走 `adapters::read::fetch_remote_object`
/// （contentsInfo 编辑形态：POST 优先、GET 回退）。
pub fn fetch_full_text(ctx: &CoreCtx, cid: &str) -> Result<RemoteFullText, ArticleFetchError> {
    let object = fetch_remote_object(ctx, cid)?;
    let title = match field(&object, "title") {
        Some(Value::String(title)) => title.clone(),
        _ => "未命名".to_string(),
    };
    let html = match field(&object, "text") {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    };
    let markdown = matches!(
        field(&object, "markdown"),
        Some(Value::Number(number)) if number.as_f64() == Some(1.0)
    );
    let article_type = match field(&object, "type") {
        Some(Value::String(kind)) => Some(kind.clone()),
        _ => None,
    };
    Ok(RemoteFullText {
        title,
        html,
        markdown,
        article_type,
    })
}

/// 按标题回查刚创建的文章 cid（1.x `findCidByTitle`）。
///
/// 1.x 用 `catch { return undefined }` 吞掉所有错误（回查只是补救手段），这里同样吞掉，
/// 返回 `None` 时由调用方返回「上传成功但未返回文章 ID…」。
pub fn find_cid_by_title(
    ctx: &CoreCtx,
    token: &str,
    title: &str,
    is_draft: bool,
) -> Option<String> {
    let remote_type = if is_draft { "post_draft" } else { "post" };
    let search_params = format!("{{\"type\":{}}}", json_str(remote_type));
    let mut options = ApiOptions::get()
        .query("searchParams", &search_params)
        .query("limit", PAGE_SIZE.to_string())
        .query("page", "1")
        .query("order", "modified")
        .query("token", token);
    if !title.is_empty() {
        options = options.query("searchKey", title);
    }
    let response: ApiResponse<Value> =
        net::request(ctx, endpoints::CONTENTS_LIST, &options).ok()?;
    let Value::Array(list) = &response.data else {
        return None;
    };
    let mut matches: Vec<&Value> = list
        .iter()
        .filter(|item| field(item, "title").map(js_to_string).as_deref() == Some(title))
        .collect();
    matches.sort_by_key(|item| {
        std::cmp::Reverse(crate::adapters::read::norm_ts(field(item, "modified")))
    });
    let cid = matches.first().and_then(|item| field(item, "cid"))?;
    Some(js_to_string(cid))
}

/// 元数据名称 → 服务端 mid（1.x `metaNameToId`）；失败一律 `None`（1.x 吞错）。
pub fn meta_name_to_id(
    ctx: &CoreCtx,
    token: Option<&str>,
    meta_type: &str,
    name: &str,
) -> Option<String> {
    let search_params = format!("{{\"type\":{}}}", json_str(meta_type));
    let mut options = ApiOptions::get()
        .query("searchParams", &search_params)
        .query("limit", "200")
        .query("page", "1")
        .query("order", "order");
    if let Some(token) = token {
        options = options.query("token", token);
    }
    let response: ApiResponse<Value> = net::request(ctx, endpoints::METAS_LIST, &options).ok()?;
    let Value::Array(list) = &response.data else {
        return None;
    };
    let hit = list
        .iter()
        .find(|item| field(item, "name").map(js_to_string).unwrap_or_default() == name)?;
    let mid = field(hit, "mid").or_else(|| field(hit, "id"))?;
    Some(js_to_string(mid))
}

/// 提交文章（1.x `upload` 里的 contentsAdd/contentsUpdate 调用）：返回响应 `data`。
///
/// 有 `cid` 走 `contentsUpdate`（覆盖），否则走 `contentsAdd`（新建）。
pub fn submit_content(
    ctx: &CoreCtx,
    token: &str,
    params_json: &str,
    text: &str,
    is_draft: bool,
    cid: Option<&str>,
) -> CoreResult<Value> {
    let options = content_body(params_json, token, text, is_draft);
    let endpoint = if cid.is_some() {
        endpoints::CONTENTS_UPDATE
    } else {
        endpoints::CONTENTS_ADD
    };
    let response: ApiResponse<Value> = net::request(ctx, endpoint, &options)?;
    Ok(response.data)
}

/// 服务端转存草稿（1.x `updateToDraft`）：`contentsUpdate` + `isDraft=1`。
pub fn update_to_draft(
    ctx: &CoreCtx,
    token: &str,
    cid: &str,
    title: &str,
    text: &str,
) -> CoreResult<()> {
    let params_json = update_draft_params_json(cid, title);
    let options = content_body(&params_json, token, text, true);
    // 1.x 在 apiRequest 之后还有 `if (resp.code !== 1) throw new Error(resp.msg || '转存草稿失败')`；
    // 本层 `api_request` 已把 `code != 1` 转成 `CoreError::Api{msg}`（msg 空时是
    // 「接口错误（code=…）」），该防御分支不可达，故不重复实现。
    let _response: ApiResponse<Value> = net::request(ctx, endpoints::CONTENTS_UPDATE, &options)?;
    Ok(())
}

/// 提交正文的 form body（1.x `body` 对象，字段顺序即 `encode_form` 的输出顺序）。
fn content_body(params_json: &str, token: &str, text: &str, is_draft: bool) -> ApiOptions {
    ApiOptions::post()
        .body("params", params_json)
        .body("token", token)
        .body("text", text)
        .body("isSpace", "0")
        .body("isDraft", if is_draft { "1" } else { "0" })
        .body("isMd", "0")
}

/// 1.x `extractCid(resp)`：只认真对象里的 `cid ?? id`。
///
/// `contentsAdd` 实测成功时 `data` 可能是裸数字（`1`），必须丢弃，否则会把 cid 记成
/// `"1"` 导致下次重复创建文章。
pub fn extract_cid(data: &Value) -> Option<String> {
    if !data.is_object() {
        return None;
    }
    field(data, "cid")
        .or_else(|| field(data, "id"))
        .map(js_to_string)
}

/// `JSON.stringify` 里的字符串片段（与 `serde_json` 的转义一致）。
fn json_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::net::api::encode_form;
    use crate::testkit::Harness;

    fn list_body(items: Value, total: i64) -> String {
        serde_json::json!({ "code": 1, "msg": "", "data": items, "total": total }).to_string()
    }

    #[test]
    fn list_remote_pages_until_total_and_builds_search_params() {
        let h = Harness::new().with_api_config();
        // total 必须大于 PAGE_SIZE(50) 才会请求第 2 页（1.x 的 break 条件是
        // `page * 50 >= total || list.length === 0`）。
        h.http
            .enqueue(200, list_body(serde_json::json!([{ "cid": 1 }]), 60));
        h.http.enqueue(
            200,
            list_body(serde_json::json!([{ "cid": 2, "title": "B" }]), 60),
        );

        let items = list_remote(h.ctx(), "tok", "7", "post", Some("waiting")).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].cid, "1");
        assert_eq!(items[0].title, "未命名");
        assert_eq!(items[1].cid, "2");

        let requests = h.requests();
        assert_eq!(requests.len(), 2);
        let expected_query = encode_form(&[
            (
                "searchParams".to_string(),
                r#"{"type":"post","status":"waiting","authorId":"7"}"#.to_string(),
            ),
            ("limit".to_string(), "50".to_string()),
            ("page".to_string(), "1".to_string()),
            ("token".to_string(), "tok".to_string()),
        ]);
        assert_eq!(
            requests[0].url,
            format!("https://api.hqsf.test/api/contentslist?{expected_query}")
        );
        assert!(requests[1].url.contains("page=2"));
    }

    #[test]
    fn extract_cid_only_accepts_objects() {
        assert_eq!(
            extract_cid(&serde_json::json!({ "cid": 12 })),
            Some("12".to_string())
        );
        assert_eq!(
            extract_cid(&serde_json::json!({ "id": "3" })),
            Some("3".to_string())
        );
        assert_eq!(
            extract_cid(&serde_json::json!({ "cid": null, "id": 9 })),
            Some("9".to_string())
        );
        assert_eq!(extract_cid(&serde_json::json!(1)), None);
        assert_eq!(extract_cid(&serde_json::json!([{ "cid": 1 }])), None);
        assert_eq!(extract_cid(&Value::Null), None);
    }

    #[test]
    fn fetch_full_text_maps_1x_fields() {
        let h = Harness::new().with_api_config();
        // `fetchRemoteObject` 消费的是 contentsInfo 的裸对象（不是 `{code,msg,data}` 信封）。
        h.http.enqueue(
            200,
            serde_json::json!({ "title": "标题", "text": "# 正文", "markdown": 1, "type": "post_draft" })
                .to_string(),
        );
        let full = fetch_full_text(h.ctx(), "7").unwrap();
        assert_eq!(full.title, "标题");
        assert_eq!(full.html, "# 正文");
        assert!(full.markdown);
        assert_eq!(full.article_type.as_deref(), Some("post_draft"));
    }

    #[test]
    fn submit_content_posts_form_body_in_1x_order() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": { "cid": 8 } }).to_string(),
        );

        let data = submit_content(
            h.ctx(),
            "tok",
            r#"{"title":"标题"}"#,
            "<p>x</p>",
            true,
            None,
        )
        .unwrap();
        assert_eq!(extract_cid(&data), Some("8".to_string()));

        let request = h.last_request();
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.hqsf.test/api/contentsadd");
        let expected = encode_form(&[
            ("params".to_string(), r#"{"title":"标题"}"#.to_string()),
            ("token".to_string(), "tok".to_string()),
            ("text".to_string(), "<p>x</p>".to_string()),
            ("isSpace".to_string(), "0".to_string()),
            ("isDraft".to_string(), "1".to_string()),
            ("isMd".to_string(), "0".to_string()),
        ]);
        assert_eq!(
            String::from_utf8_lossy(request.body.as_deref().unwrap()),
            expected
        );
    }

    #[test]
    fn submit_content_uses_contents_update_when_cid_present() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": {} }).to_string(),
        );
        submit_content(
            h.ctx(),
            "tok",
            r#"{"title":"标题","cid":"8"}"#,
            "x",
            false,
            Some("8"),
        )
        .unwrap();
        assert_eq!(
            h.last_request().url,
            "https://api.hqsf.test/api/contentsupdate"
        );
        let body = String::from_utf8_lossy(h.last_request().body.as_deref().unwrap()).into_owned();
        assert!(body.contains("isDraft=0"), "{body}");
    }

    #[test]
    fn find_cid_by_title_prefers_newest_match_and_ignores_errors() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            list_body(
                serde_json::json!([
                    { "cid": 1, "title": "同名", "modified": 100 },
                    { "cid": 2, "title": "同名", "modified": 200 },
                    { "cid": 3, "title": "别的", "modified": 300 }
                ]),
                3,
            ),
        );
        assert_eq!(
            find_cid_by_title(h.ctx(), "tok", "同名", true),
            Some("2".to_string())
        );

        let h = Harness::new().with_api_config();
        h.http.enqueue(500, "boom".to_string());
        assert_eq!(find_cid_by_title(h.ctx(), "tok", "同名", false), None);
    }

    #[test]
    fn meta_name_to_id_matches_exact_name() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({
                "code": 1,
                "msg": "",
                "data": [{ "mid": 5, "name": "原创作品" }, { "name": "其他", "id": 6 }]
            })
            .to_string(),
        );
        assert_eq!(
            meta_name_to_id(h.ctx(), Some("tok"), "category", "原创作品"),
            Some("5".to_string())
        );
        assert_eq!(
            meta_name_to_id(h.ctx(), Some("tok"), "category", "缺"),
            None
        );
    }

    #[test]
    fn update_to_draft_sends_is_draft_one() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            serde_json::json!({ "code": 1, "msg": "", "data": {} }).to_string(),
        );
        update_to_draft(h.ctx(), "tok", "8", "标题", "<p>x</p>").unwrap();
        let body = String::from_utf8_lossy(h.last_request().body.as_deref().unwrap()).into_owned();
        assert!(body.contains("isDraft=1"), "{body}");
        assert!(
            body.contains("params=%7B%22cid%22%3A%228%22%2C%22title%22"),
            "{body}"
        );
    }
}
