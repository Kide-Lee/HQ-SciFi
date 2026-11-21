//! 用户适配层（1.x `src/main/adapters/user.adapter.ts` 逐函数翻译）。
//!
//! 覆盖归本 lane 的 user 通道：资料 / 计数 / 本人状态 / 关注状态 / 关注与取关 /
//! 关注·粉丝列表 / 签到 / 资料修改 / 上传头像。
//! 收藏（markList）与动态聚合（动态 = 关注者文章+评审+评论扇出）依赖 read/review/comment
//! lane 的适配函数，落在本文件第二段（见 `list_marks` / `list_follow_feed`）。
//!
//! 接口实测结论（沿用 1.x 注释）：`userInfo?key=uid` 公开；`userData` 需登录且用 `uid`；
//! `fanList` 必须用 `touid`（用 `uid` 会拿到全站错数据）；`followList` 用 `uid`；
//! `isFollow` 的 code 0/1 即关注状态（不能走统一 envelope 抛错）。

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::adapters::comment::{self, CommentItem, CommentListResult};
use crate::adapters::read::{self, ArticleListOptions, Json, JsonObject, RemoteArticle};
use crate::adapters::review::{self, ReviewItem, ReviewListOut};
use crate::ctx::CoreCtx;
use crate::domain::user::{
    JsonScalar, array_or_empty, first, num_at, num_or_undef, opt_num, opt_num_at, str_at, str_of,
    uid_param,
};
use crate::error::CoreResult;
use crate::infra::net::api::ApiOptions;
use crate::infra::net::config::endpoints;
use crate::services::{auth, net};

/// 用户资料（`hqUsers/userInfo?key=uid`；公开可读）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub uid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduce: Option<String>,
    /// 主页背景图 URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
    /// 服务端等级值（1.x 保留原类型：number | string）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lv: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_key: Option<String>,
}

/// 用户计数（`hqUsers/userData?uid=`；需登录）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserStats {
    pub fan_num: i64,
    pub contents_num: i64,
    pub comments_num: i64,
    /// 今日是否已签到（0/1）
    pub is_clock: i64,
}

/// 当前账号状态（`hqUsers/userStatus?token`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelfStatus {
    pub assets: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lv: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

/// 关注/粉丝列表条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserFollowItem {
    pub uid: String,
    pub touid: String,
    pub created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_json: Option<Value>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
}

/// 关注/粉丝列表。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserFollowList {
    pub items: Vec<UserFollowItem>,
    pub total: i64,
}

/// 关注/取关结果（1.x `{ ok, error? }`；业务失败不抛错）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FollowOpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl FollowOpResult {
    pub fn success() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// 签到结果（1.x `ClockResult`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClockResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 签到奖励能量币
    #[serde(skip_serializing_if = "Option::is_none")]
    pub award: Option<i64>,
    /// 签到获得经验
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_exp: Option<i64>,
    /// 签到后最新能量币余额
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<i64>,
}

impl ClockResult {
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            award: None,
            add_exp: None,
            assets: None,
        }
    }
}

/// 上传头像结果（1.x `{ url }`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadedImage {
    pub url: String,
}

/// 本人资料可改字段（1.x `UserProfileUpdatePayload`，全部 string）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileUpdatePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub introduce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

/// 非空字符串 → `Some`（1.x `str(x) || undefined`）。
fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

/// `d.lv != null && d.lv !== '' ? d.lv : undefined`（保留原始 JSON 类型）。
fn lv_of(data: &Value) -> Option<Value> {
    match data.get("lv") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(other) => Some(other.clone()),
    }
}

/// 原始资料 → `UserProfile`（1.x `getUserProfile`）。
pub fn to_user_profile(data: &Value, uid: &str) -> UserProfile {
    UserProfile {
        uid: first(data, &["uid"])
            .map(str_of)
            .unwrap_or_else(|| uid.to_string()),
        name: str_at(data, &["screenName", "name"]),
        screen_name: non_empty(str_at(data, &["screenName"])),
        avatar: non_empty(str_at(data, &["avatar"])),
        introduce: non_empty(str_at(data, &["introduce"])),
        user_bg: non_empty(str_at(data, &["userBg"])),
        experience: first(data, &["experience"]).and_then(opt_num),
        lv: lv_of(data),
        assets: first(data, &["assets"]).and_then(opt_num),
        group_key: non_empty(str_at(data, &["groupKey"])),
    }
}

/// 用户资料（公开接口，`key` 参数是 uid 字符串）。
pub fn get_user_profile(ctx: &CoreCtx, uid: &str) -> CoreResult<UserProfile> {
    let resp = net::request::<Value>(
        ctx,
        endpoints::USER_INFO,
        &ApiOptions::get().query("key", uid),
    )?;
    Ok(to_user_profile(&resp.data, uid))
}

/// 用户计数（需登录；未登录返回 `None`，由渲染层降级）。
pub fn get_user_stats(ctx: &CoreCtx, uid: &str) -> CoreResult<Option<UserStats>> {
    let Some(token) = net::token(ctx)? else {
        return Ok(None);
    };
    let resp = net::request::<Value>(
        ctx,
        endpoints::USER_DATA,
        &ApiOptions::get().query("uid", uid).query("token", &token),
    )?;
    let d = &resp.data;
    Ok(Some(UserStats {
        fan_num: num_at(d, &["fanNum"]),
        contents_num: num_at(d, &["contentsNum"]),
        comments_num: num_at(d, &["commentsNum"]),
        is_clock: num_at(d, &["isClock"]),
    }))
}

/// 本人状态（能量币/经验/等级）。
pub fn get_self_status(ctx: &CoreCtx) -> CoreResult<Option<SelfStatus>> {
    let Some(token) = net::token(ctx)? else {
        return Ok(None);
    };
    let resp = net::request::<Value>(
        ctx,
        endpoints::USER_STATUS,
        &ApiOptions::get().query("token", &token),
    )?;
    let d = &resp.data;
    Ok(Some(SelfStatus {
        assets: num_at(d, &["assets"]),
        experience: first(d, &["experience"]).and_then(opt_num),
        lv: lv_of(d),
        name: non_empty(str_at(d, &["name"])),
        screen_name: non_empty(str_at(d, &["screenName"])),
        avatar: non_empty(str_at(d, &["avatar"])),
        user_bg: non_empty(str_at(d, &["userBg"])),
        introduce: non_empty(str_at(d, &["introduce"])),
        mail: non_empty(str_at(d, &["mail"])),
        phone: non_empty(str_at(d, &["phone"])),
    }))
}

/// 是否已关注（1.x raw 模式：`code === 1` 即已关注；未登录 false）。
pub fn get_follow_state(ctx: &CoreCtx, touid: &str) -> CoreResult<bool> {
    let Some(token) = net::token(ctx)? else {
        return Ok(false);
    };
    let resp = net::request_raw::<Value>(
        ctx,
        endpoints::IS_FOLLOW,
        &ApiOptions::get()
            .query("token", &token)
            .query("touid", touid),
    )?;
    Ok(resp.code == 1)
}

/// 关注/取关（`follow` 接口 `type` 1=关注 0=取关）。
pub fn set_follow(ctx: &CoreCtx, touid: &str, follow: bool) -> CoreResult<FollowOpResult> {
    let Some(token) = net::token(ctx)? else {
        return Ok(FollowOpResult::failure("未登录，无法关注"));
    };
    // 1.x 这里 `resp.code !== 1` 的分支实际走不到（apiRequest 已抛错），统一 catch 成 error。
    match net::request::<Value>(
        ctx,
        endpoints::FOLLOW,
        &ApiOptions::get()
            .query("token", &token)
            .query("touid", touid)
            .query("type", if follow { "1" } else { "0" }),
    ) {
        Ok(_) => Ok(FollowOpResult::success()),
        Err(err) => Ok(FollowOpResult::failure(err.to_string())),
    }
}

/// 原始关注/粉丝条目 → `UserFollowItem`（`userJson` 为目标用户信息）。
pub fn to_user_follow_item(item: &Value) -> UserFollowItem {
    let user_json = item.get("userJson").filter(|v| v.is_object()).cloned();
    let user = user_json.clone().unwrap_or(Value::Null);
    UserFollowItem {
        uid: {
            let from_item = first(item, &["uid"]);
            let from_user = first(&user, &["uid"]);
            from_item.or(from_user).map(str_of).unwrap_or_default()
        },
        touid: str_at(item, &["touid"]),
        created: num_at(item, &["created"]),
        user_json,
        name: str_at(&user, &["name", "nickname", "screenName"]),
        avatar: non_empty(str_at(&user, &["avatar"])),
        introduce: non_empty(str_at(&user, &["introduce"])),
        experience: first(&user, &["experience"]).and_then(opt_num),
    }
}

fn follow_list_from_response(resp: &crate::infra::net::api::ApiResponse<Value>) -> UserFollowList {
    let items: Vec<UserFollowItem> = crate::domain::user::array_or_empty(&resp.data)
        .iter()
        .map(to_user_follow_item)
        .collect();
    let total = resp.total.filter(|t| *t != 0).unwrap_or(items.len() as i64);
    UserFollowList { items, total }
}

/// 关注列表（`followList` 用 `uid`）。
pub fn list_follows(ctx: &CoreCtx, uid: &str, page: i64, limit: i64) -> CoreResult<UserFollowList> {
    let mut options = ApiOptions::get()
        .query("uid", uid)
        .query("limit", limit.to_string())
        .query("page", page.to_string());
    if let Some(token) = net::token(ctx)? {
        options = options.query("token", &token);
    }
    let resp = net::request::<Value>(ctx, endpoints::FOLLOW_LIST, &options)?;
    Ok(follow_list_from_response(&resp))
}

/// 粉丝列表（`fanList` **必须**用 `touid`；用 uid 会返回全站粉丝数据）。
pub fn list_fans(ctx: &CoreCtx, touid: &str, page: i64, limit: i64) -> CoreResult<UserFollowList> {
    let mut options = ApiOptions::get()
        .query("touid", touid)
        .query("limit", limit.to_string())
        .query("page", page.to_string());
    if let Some(token) = net::token(ctx)? {
        options = options.query("token", &token);
    }
    let resp = net::request::<Value>(ctx, endpoints::FAN_LIST, &options)?;
    Ok(follow_list_from_response(&resp))
}

/// 取整个响应体（1.x `raw: true`）。
fn request_value(ctx: &CoreCtx, name: &str, options: &ApiOptions) -> CoreResult<Value> {
    net::request_value(ctx, name, options)
}

/// 签到（`addLog {type:"clock"}`；成功后回读 `userStatus` 拿最新能量币余额）。
///
/// 1.x 的 `try/catch` 覆盖两次请求：任何失败都变成 `{ok:false,error}`，不抛错。
pub fn clock_in(ctx: &CoreCtx) -> CoreResult<ClockResult> {
    let Some(token) = net::token(ctx)? else {
        return Ok(ClockResult::failure("未登录，无法签到"));
    };
    let result = (|| -> CoreResult<ClockResult> {
        let params = serde_json::json!({ "type": "clock" }).to_string();
        let json = request_value(
            ctx,
            endpoints::ADD_LOG,
            &ApiOptions::get()
                .query("params", &params)
                .query("token", &token),
        )?;
        if json.get("code").and_then(Value::as_i64) != Some(1) {
            let msg = json
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            return Ok(ClockResult::failure(if msg.is_empty() {
                "签到失败".to_string()
            } else {
                msg
            }));
        }
        let clock_data = json.get("clockData").cloned().unwrap_or(Value::Null);
        let status = get_self_status(ctx)?;
        Ok(ClockResult {
            ok: true,
            error: None,
            award: first(&clock_data, &["award"]).and_then(opt_num),
            add_exp: first(&clock_data, &["addExp"]).and_then(opt_num),
            assets: status.map(|s| s.assets),
        })
    })();
    match result {
        Ok(result) => Ok(result),
        Err(err) => Ok(ClockResult::failure(err.to_string())),
    }
}

/// 修改本人资料（`hqUsers/userEdit`，POST `{token, params}`；只放非 null 字段）。
pub fn update_user_profile(ctx: &CoreCtx, payload: &UserProfileUpdatePayload) -> CoreResult<()> {
    let token = net::require_token(ctx, "未登录，无法修改资料")?;
    let mut params = Map::new();
    let fields = [
        ("screenName", &payload.screen_name),
        ("avatar", &payload.avatar),
        ("userBg", &payload.user_bg),
        ("introduce", &payload.introduce),
        ("mail", &payload.mail),
        ("phone", &payload.phone),
    ];
    for (key, value) in fields {
        if let Some(value) = value {
            params.insert(key.to_string(), Value::String(value.clone()));
        }
    }
    net::request::<Value>(
        ctx,
        endpoints::USER_EDIT,
        &ApiOptions::post()
            .body("token", &token)
            .body("params", Value::Object(params).to_string()),
    )?;
    Ok(())
}

/// 选择图片并上传（1.x `media-service.pickUpload`）：
/// 对话框仅做扩展名过滤（内核端口不支持 filters，故这里不做二次类型校验，与 1.x 一致）。
pub fn pick_upload_user_image(ctx: &CoreCtx) -> CoreResult<Option<UploadedImage>> {
    let token = net::require_token(ctx, "未登录，无法上传图片")?;
    let Some(path) = ctx.platform.dialog.pick_image("选择要上传的图片")? else {
        return Ok(None);
    };
    let bytes = ctx.files.read(&path)?;
    let filename = file_name(&path);
    let url = net::upload(ctx, &token, &filename, &bytes)?;
    Ok(Some(UploadedImage { url }))
}

/// `path.basename(file)`；1.x 取不到时不会出现，这里回退固定名以免上传字段为空。
fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "image".to_string())
}

// ---------- 收藏（`user.adapter.ts:243` `listMarks`） ----------

/// 收藏条目里的活动/栏目引用（1.x `toMarkItem` 只映射 `{mid,name,type}`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserMarkRef {
    pub mid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub meta_type: Option<String>,
}

/// 收藏条目（`src/shared/domain/index.ts` `UserMarkItem`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserMarkItem {
    pub cid: String,
    pub title: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub views: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments_num: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_info: Option<Value>,
    /// TS 是 `active?: MetaRef[] | null`：显式 null 表示「没有活动」，不能用 skip。
    pub active: Option<Vec<UserMarkRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_score: Option<bool>,
}

/// `user-marks` 返回体：`{ items, total }`。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserMarkList {
    pub items: Vec<UserMarkItem>,
    pub total: i64,
}

/// `active` 数组 → 引用列表（非数组 → `None`，序列化成显式 `null`）。
fn mark_refs(value: &Value) -> Option<Vec<UserMarkRef>> {
    value.as_array().map(|items| {
        items
            .iter()
            .map(|item| UserMarkRef {
                mid: str_at(item, &["mid", "id"]),
                name: non_empty(str_at(item, &["name"])),
                meta_type: non_empty(str_at(item, &["type"])),
            })
            .collect()
    })
}

/// 收藏原始 JSON → [`UserMarkItem`]（`toMarkItem`）。
pub fn to_mark_item(item: &Value) -> UserMarkItem {
    let images = item.as_object().and_then(|_| {
        item.get("images").and_then(|value| {
            value
                .as_array()
                .map(|items| items.iter().map(str_of).collect::<Vec<String>>())
        })
    });
    UserMarkItem {
        cid: str_at(item, &["cid", "id"]),
        title: match first(item, &["title"]) {
            Some(title) => str_of(title),
            None => "未命名".to_string(),
        },
        kind: non_empty(str_at(item, &["type"])),
        text: non_empty(str_at(item, &["text"])),
        cover: non_empty(str_at(item, &["cover"])),
        images,
        score: non_empty(str_at(item, &["score"])),
        views: num_or_undef(item.get("views").unwrap_or(&Value::Null)),
        likes: num_or_undef(item.get("likes").unwrap_or(&Value::Null)),
        comments_num: num_or_undef(item.get("commentsNum").unwrap_or(&Value::Null)),
        created: opt_num_at(item, &["created"]),
        size: opt_num_at(item, &["size"]),
        author_id: non_empty(str_at(item, &["authorId"])),
        author_info: item.get("authorInfo").cloned().filter(|v| !v.is_null()),
        active: item.get("active").and_then(mark_refs),
        hide_score: None,
    }
}

/// 1.x `getMarkArticleMeta`：按 cid 回查文章，判断是否要隐藏评分。
///
/// 偏差：1.x 有 5 分钟 `markArticleMetaCache`；内核的 read 缓存只存 authorId/isAnonymous，
/// 没有 hideScore，因此这里每次直连（活动 mid 集合仍有 5 分钟缓存）。
fn mark_article_hides_score(ctx: &CoreCtx, cid: &str) -> bool {
    if cid.is_empty() {
        return false;
    }
    let mut params = JsonObject::new();
    params.insert("cid".to_string(), Json::String(cid.to_string()));
    let opts = ArticleListOptions {
        search_params: Some(params),
        limit: Some(2),
        order: Some("created".to_string()),
        ..Default::default()
    };
    match read::list_remote_articles(ctx, &opts) {
        Ok(out) => out
            .items
            .iter()
            .find(|article| article.cid == cid)
            .is_some_and(|article| article.hide_score == Some(true)),
        Err(_) => false,
    }
}

/// 活动期隐藏评分（`knownHidden` → 隐藏；`active` 为空则回查文章元数据）。
fn apply_mark_hide(ctx: &CoreCtx, item: &mut UserMarkItem, mids: &BTreeSet<String>) {
    let hidden_by_active = item
        .active
        .as_ref()
        .is_some_and(|refs| refs.iter().any(|meta| mids.contains(&meta.mid)));
    if hidden_by_active {
        item.score = Some("-.-".to_string());
        item.hide_score = Some(true);
        return;
    }
    let active_empty = item.active.as_ref().is_none_or(Vec::is_empty);
    if active_empty && mark_article_hides_score(ctx, &item.cid) {
        item.score = Some("-.-".to_string());
        item.hide_score = Some(true);
    }
}

/// 我的收藏（`markList`；未登录返回空列表——命令层先报「未登录，无法查看收藏」）。
pub fn list_marks(ctx: &CoreCtx, page: i64, limit: i64) -> CoreResult<UserMarkList> {
    let Some(token) = net::token(ctx)? else {
        return Ok(UserMarkList::default());
    };
    let options = ApiOptions::get()
        .query("token", token)
        .query("limit", limit.to_string())
        .query("page", page.to_string());
    let resp = net::request::<Value>(ctx, endpoints::MARK_LIST, &options)?;
    let mids = read::get_ongoing_review_mids(ctx);
    let mut items: Vec<UserMarkItem> = array_or_empty(&resp.data)
        .iter()
        .map(to_mark_item)
        .collect();
    for item in &mut items {
        apply_mark_hide(ctx, item, &mids);
    }
    let total = resp.total.unwrap_or(0);
    let total = if total == 0 {
        items.len() as i64
    } else {
        total
    };
    Ok(UserMarkList { items, total })
}

// ---------- 用户文章 / 评审 / 评论 ----------

/// 用户发表的文章（`listRemoteArticles(searchParams={type:'post',authorId})`）。
pub fn list_user_articles(
    ctx: &CoreCtx,
    uid: Option<&JsonScalar>,
    page: i64,
    limit: i64,
) -> CoreResult<read::ArticleListOut> {
    let mut params = JsonObject::new();
    params.insert("type".to_string(), Json::String("post".to_string()));
    params.insert("authorId".to_string(), Json::from_value(&uid_param(uid)));
    let opts = ArticleListOptions {
        search_params: Some(params),
        limit: Some(limit),
        page: Some(page),
        order: Some("created".to_string()),
        ..Default::default()
    };
    read::list_remote_articles(ctx, &opts)
}

/// 用户发表的评审（`reviewList` + `searchParams={uid}`，再做活动期脱敏）。
pub fn list_user_reviews(
    ctx: &CoreCtx,
    uid: &str,
    page: i64,
    limit: i64,
) -> CoreResult<ReviewListOut> {
    let token = net::token(ctx)?;
    let search_params = Value::Object(Map::from_iter([(
        "uid".to_string(),
        Value::String(uid.to_string()),
    )]));
    let mut options = ApiOptions::get()
        .query("searchParams", search_params.to_string())
        .query("limit", limit.to_string())
        .query("page", page.to_string())
        .query("order", "created");
    if let Some(token) = token.as_deref() {
        options = options.query("token", token);
    }
    let resp = net::request::<Value>(ctx, endpoints::REVIEW_LIST, &options)?;
    let mut items: Vec<ReviewItem> = array_or_empty(&resp.data)
        .iter()
        .map(review::to_review_item)
        .collect();
    let mids = read::get_ongoing_review_mids(ctx);
    let my_uid = auth::session_uid(ctx);
    let my_uid = (!my_uid.is_empty()).then_some(my_uid);
    review::sanitize_review_list(&mut items, &mids, my_uid.as_deref());
    let total = resp.total.unwrap_or(0);
    let total = if total == 0 {
        items.len() as i64
    } else {
        total
    };
    Ok(ReviewListOut { items, total })
}

/// 用户发表的评论（`commentsList searchParams={type:'comment',authorId}`；authorId 数字）。
pub fn list_user_comments(
    ctx: &CoreCtx,
    uid: Option<&JsonScalar>,
    page: i64,
    limit: i64,
) -> CoreResult<CommentListResult> {
    let search_params = Value::Object(Map::from_iter([
        ("type".to_string(), Value::String("comment".to_string())),
        ("authorId".to_string(), uid_param(uid)),
    ]));
    comment::fetch_comments_by_search_params(
        ctx,
        &search_params,
        limit,
        page,
        Some("created"),
        None,
    )
}

// ---------- 关注动态（`listFollowFeed`） ----------

/// 动态条目类型（1.x `kind`: `article|review|comment|review_comment`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FollowFeedKind {
    #[default]
    Article,
    Review,
    Comment,
    ReviewComment,
}

/// 关注动态条目（`src/shared/domain/index.ts` `FollowFeedItem`）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FollowFeedItem {
    pub kind: FollowFeedKind,
    pub created: i64,
    pub uid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<i64>,
    pub cid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub article_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_score: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_num: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub views: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments_num: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_author: Option<String>,
}

/// 动态里的作者（1.x 内的 `u`）。
#[derive(Debug, Clone, Default, PartialEq)]
struct FeedUser {
    uid: String,
    name: String,
    avatar: Option<String>,
    experience: Option<i64>,
}

impl FeedUser {
    /// 活动期文章隐藏评分时，作者对外显示为「匿名用户」（`avatar`/`experience` 同 1.x 保留）。
    fn anonymized(&self) -> Self {
        Self {
            uid: self.uid.clone(),
            name: "匿名用户".to_string(),
            avatar: None,
            experience: self.experience,
        }
    }
}

/// 1.x `reviewIdOf`：`reviewid` 为 `null`/`''`/`'0'` → `None`。
fn review_id_of(reviewid: Option<&String>) -> Option<String> {
    let value = reviewid?;
    if value.is_empty() || value == "0" {
        return None;
    }
    Some(value.clone())
}

fn to_feed_article(author: &FeedUser, article: &RemoteArticle, hide_score: bool) -> FollowFeedItem {
    let score = if hide_score || article.score.is_empty() || article.score == "-.-" {
        None
    } else {
        Some(article.score.clone())
    };
    FollowFeedItem {
        kind: FollowFeedKind::Article,
        created: article.created,
        uid: author.uid.clone(),
        user_name: Some(author.name.clone()),
        avatar: author.avatar.clone(),
        experience: author.experience,
        cid: article.cid.clone(),
        article_title: Some(article.title.clone()),
        text: (!article.text.is_empty()).then(|| article.text.clone()),
        score,
        hide_score: Some(hide_score),
        views: Some(article.views),
        likes: Some(article.likes),
        comments_num: Some(article.comments_num),
        size: article.size,
        ..Default::default()
    }
}

fn to_feed_review(author: &FeedUser, item: &ReviewItem, hide_score: bool) -> FollowFeedItem {
    let info = item
        .article_info
        .clone()
        .map(|object| Json::Object(object).to_value())
        .unwrap_or(Value::Null);
    let article_title = str_at(&info, &["title"]);
    let actual = item.actualscore.clone();
    let article_score = str_at(&info, &["score"]);
    let score = if hide_score {
        None
    } else if !actual.is_empty() && actual != "-.-" {
        Some(actual)
    } else if !article_score.is_empty() && article_score != "-.-" {
        Some(article_score)
    } else {
        None
    };
    let zonghe = item.zonghe.trim();
    let dianzi = item.dianzi.trim();
    let text = if !zonghe.is_empty() {
        Some(zonghe.to_string())
    } else if !dianzi.is_empty() {
        Some(dianzi.to_string())
    } else {
        None
    };
    FollowFeedItem {
        kind: FollowFeedKind::Review,
        created: item.created,
        uid: author.uid.clone(),
        user_name: Some(author.name.clone()),
        avatar: author.avatar.clone(),
        experience: author.experience,
        cid: item.cid.clone(),
        article_title: Some(article_title),
        review_id: Some(item.id.clone()),
        text,
        score,
        hide_score: Some(hide_score),
        reply_num: num_or_undef(&Value::from(item.reply_num)),
        ..Default::default()
    }
}

fn to_feed_comment(author: &FeedUser, item: &CommentItem) -> FollowFeedItem {
    let reviewid = review_id_of(item.reviewid.as_ref());
    let kind = if reviewid.is_some() {
        FollowFeedKind::ReviewComment
    } else {
        FollowFeedKind::Comment
    };
    FollowFeedItem {
        kind,
        created: item.created,
        uid: author.uid.clone(),
        user_name: Some(author.name.clone()),
        avatar: author.avatar.clone(),
        experience: author.experience,
        cid: item.cid.clone(),
        article_title: item.article_title.clone(),
        comment_id: Some(item.coid.clone()),
        text: Some(item.text.clone()),
        reviewid,
        review_author: item.review_author.clone(),
        ..Default::default()
    }
}

/// 关注动态聚合：关注的人（最多 100）× 每人文章/评审/评论各 1 页 5 条，合并倒序截断 300。
///
/// 偏差：1.x 用 `mapLimit(...,4)` 并发扇出；内核顺序请求（结果集与排序一致，只是更慢）。
pub fn list_follow_feed(ctx: &CoreCtx, self_uid: &str) -> CoreResult<Vec<FollowFeedItem>> {
    const MAX_USERS: i64 = 100;
    const LIMIT_PER_USER: i64 = 5;
    const CAP: usize = 300;

    if net::token(ctx)?.is_none() || self_uid.is_empty() {
        return Ok(Vec::new());
    }
    let follows = list_follows(ctx, self_uid, 1, MAX_USERS)?;
    let mut feed: Vec<FollowFeedItem> = Vec::new();
    for follow in &follows.items {
        let user_json = follow.user_json.as_ref();
        let uid = user_json
            .and_then(|user| first(user, &["uid"]))
            .map(str_of)
            .filter(|uid| !uid.is_empty())
            .unwrap_or_else(|| follow.touid.clone());
        let author = FeedUser {
            uid: uid.clone(),
            name: follow.name.clone(),
            avatar: follow.avatar.clone(),
            experience: follow.experience,
        };

        if let Ok(articles) =
            list_user_articles(ctx, Some(&JsonScalar::Text(uid.clone())), 1, LIMIT_PER_USER)
        {
            for article in &articles.items {
                let hide_score = article.hide_score == Some(true);
                let shown = if hide_score {
                    author.anonymized()
                } else {
                    author.clone()
                };
                feed.push(to_feed_article(&shown, article, hide_score));
            }
        }
        if let Ok(reviews) = list_user_reviews(ctx, &uid, 1, LIMIT_PER_USER) {
            for item in &reviews.items {
                let hide_score = item.hide_score == Some(true);
                feed.push(to_feed_review(&author, item, hide_score));
            }
        }
        if let Ok(comments) =
            list_user_comments(ctx, Some(&JsonScalar::Text(uid.clone())), 1, LIMIT_PER_USER)
        {
            for item in &comments.items {
                feed.push(to_feed_comment(&author, item));
            }
        }
    }
    feed.sort_by_key(|item| std::cmp::Reverse(item.created));
    feed.truncate(CAP);
    Ok(feed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{FileStore, SecretStore};
    use crate::testkit::Harness;

    #[test]
    fn to_user_profile_prefers_screen_name_and_keeps_lv_type() {
        let raw = serde_json::json!({
            "uid": 7,
            "screenName": "阿星",
            "name": "老名字",
            "avatar": "a.png",
            "introduce": "",
            "experience": "12",
            "lv": "3",
            "assets": 0,
            "groupKey": "vip"
        });
        let p = to_user_profile(&raw, "7");
        assert_eq!(p.uid, "7");
        assert_eq!(p.name, "阿星");
        assert_eq!(p.screen_name.as_deref(), Some("阿星"));
        assert_eq!(p.avatar.as_deref(), Some("a.png"));
        assert_eq!(p.introduce, None);
        assert_eq!(p.experience, Some(12));
        assert_eq!(p.lv, Some(serde_json::json!("3")));
        assert_eq!(p.assets, Some(0));
        assert_eq!(p.group_key.as_deref(), Some("vip"));
    }

    #[test]
    fn to_user_profile_falls_back_to_argument_uid() {
        let p = to_user_profile(&serde_json::json!({}), "42");
        assert_eq!(p.uid, "42");
        assert_eq!(p.name, "");
        assert_eq!(p.lv, None);
    }

    #[test]
    fn get_user_profile_queries_key_param() {
        let h = Harness::new().with_api_config();
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"uid":7,"name":"n","experience":3}}"#.to_string(),
        );
        let p = get_user_profile(h.ctx(), "7").unwrap();
        assert_eq!(p.name, "n");
        assert_eq!(p.experience, Some(3));
        assert!(h.last_request().url.contains("key=7"));
    }

    #[test]
    fn get_user_stats_is_none_without_session() {
        let h = Harness::new().with_api_config();
        assert_eq!(get_user_stats(h.ctx(), "7").unwrap(), None);
        assert!(h.requests().is_empty());
    }

    #[test]
    fn get_user_stats_maps_counts() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"fanNum":"5","contentsNum":2,"commentsNum":1,"isClock":1}}"#
        .to_string());
        let s = get_user_stats(h.ctx(), "7").unwrap().unwrap();
        assert_eq!(
            s,
            UserStats {
                fan_num: 5,
                contents_num: 2,
                comments_num: 1,
                is_clock: 1
            }
        );
        assert!(h.last_request().url.contains("uid=7"));
        assert!(h.last_request().url.contains("token=tok"));
    }

    #[test]
    fn get_self_status_is_none_without_session_and_maps_optional_fields() {
        let h = Harness::new().with_api_config();
        assert_eq!(get_self_status(h.ctx()).unwrap(), None);

        h.secrets
            .set(net::SESSION_SECRET_KEY, r#"{"token":"tok"}"#)
            .unwrap();
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"assets":10,"experience":"8","name":"n","mail":""}}"#
                .to_string(),
        );
        let s = get_self_status(h.ctx()).unwrap().unwrap();
        assert_eq!(s.assets, 10);
        assert_eq!(s.experience, Some(8));
        assert_eq!(s.name.as_deref(), Some("n"));
        assert_eq!(s.mail, None);
    }

    #[test]
    fn get_follow_state_uses_raw_code() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(200, r#"{"code":1,"msg":"ok"}"#.to_string());
        assert!(get_follow_state(h.ctx(), "9").unwrap());
        h.http
            .enqueue(200, r#"{"code":0,"msg":"未关注"}"#.to_string());
        assert!(!get_follow_state(h.ctx(), "9").unwrap());
        assert!(h.last_request().url.contains("touid=9"));
    }

    #[test]
    fn get_follow_state_is_false_without_session() {
        let h = Harness::new().with_api_config();
        assert!(!get_follow_state(h.ctx(), "9").unwrap());
        assert!(h.requests().is_empty());
    }

    #[test]
    fn set_follow_sends_type_and_reports_business_errors() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(200, r#"{"code":1,"msg":""}"#.to_string());
        assert_eq!(
            set_follow(h.ctx(), "9", true).unwrap(),
            FollowOpResult::success()
        );
        let url = h.last_request().url;
        assert!(url.contains("type=1"), "{url}");
        assert!(url.contains("touid=9"), "{url}");

        h.http
            .enqueue(200, r#"{"code":0,"msg":"不能关注自己"}"#.to_string());
        let out = set_follow(h.ctx(), "9", false).unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("不能关注自己"));
    }

    #[test]
    fn set_follow_without_session_returns_error_result() {
        let h = Harness::new().with_api_config();
        let out = set_follow(h.ctx(), "9", true).unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("未登录，无法关注"));
        assert!(h.requests().is_empty());
    }

    #[test]
    fn to_user_follow_item_maps_user_json_fields() {
        let raw = serde_json::json!({
            "uid": 3,
            "touid": 8,
            "created": 1700000000,
            "userJson": {"uid": 8, "nickname": "小明", "avatar": "b.png", "experience": "6"}
        });
        let item = to_user_follow_item(&raw);
        assert_eq!(item.uid, "3");
        assert_eq!(item.touid, "8");
        assert_eq!(item.created, 1_700_000_000);
        assert_eq!(item.name, "小明");
        assert_eq!(item.avatar.as_deref(), Some("b.png"));
        assert_eq!(item.experience, Some(6));
        assert!(item.user_json.is_some());
    }

    #[test]
    fn list_follows_uses_uid_and_list_fans_uses_touid() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":[],"total":11}"#.to_string(),
        );
        let out = list_follows(h.ctx(), "7", 2, 30).unwrap();
        assert_eq!(out.total, 11);
        let url = h.last_request().url;
        assert!(url.contains("uid=7"), "{url}");
        assert!(url.contains("page=2"), "{url}");
        assert!(url.contains("limit=30"), "{url}");

        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":[{"touid":3}]}"#.to_string(),
        );
        let out = list_fans(h.ctx(), "7", 1, 20).unwrap();
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].touid, "3");
        // total 缺省时回落成条目数
        assert_eq!(out.total, 1);
        assert!(h.last_request().url.contains("touid=7"));
    }

    #[test]
    fn clock_in_returns_award_and_latest_assets() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":null,"clockData":{"award":"5","addExp":3}}"#.to_string(),
        );
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"assets":25}}"#.to_string(),
        );
        let out = clock_in(h.ctx()).unwrap();
        assert!(out.ok, "{out:?}");
        assert_eq!(out.award, Some(5));
        assert_eq!(out.add_exp, Some(3));
        assert_eq!(out.assets, Some(25));
        assert_eq!(h.requests().len(), 2);
    }

    #[test]
    fn clock_in_reports_business_failure_message() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":0,"msg":"今天已经签到过了"}"#.to_string());
        let out = clock_in(h.ctx()).unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("今天已经签到过了"));
        assert_eq!(h.requests().len(), 1);
    }

    #[test]
    fn clock_in_without_session_reports_error_result() {
        let h = Harness::new().with_api_config();
        let out = clock_in(h.ctx()).unwrap();
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("未登录，无法签到"));
    }

    #[test]
    fn update_user_profile_posts_only_present_fields() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.http
            .enqueue(200, r#"{"code":1,"msg":"","data":null}"#.to_string());
        let payload = UserProfileUpdatePayload {
            screen_name: Some("新名".into()),
            introduce: Some("介绍".into()),
            ..Default::default()
        };
        update_user_profile(h.ctx(), &payload).unwrap();
        let last = h.last_request();
        assert_eq!(last.method, "POST");
        let body = String::from_utf8_lossy(last.body.as_deref().unwrap_or_default()).to_string();
        assert!(body.contains("token=tok"), "{body}");
        assert!(body.contains("params="), "{body}");
        // params 是 JSON 字符串，被 URL 编码后中文是 %XX 形式；用解码验证明文
        let decoded = url_decode(&body);
        assert!(decoded.contains("\"screenName\":\"新名\""), "{decoded}");
        assert!(decoded.contains("\"introduce\":\"介绍\""), "{decoded}");
        assert!(!decoded.contains("avatar"), "{decoded}");
    }

    fn url_decode(text: &str) -> String {
        let mut out = Vec::new();
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                    if let Ok(byte) = u8::from_str_radix(hex, 16) {
                        out.push(byte);
                        i += 3;
                        continue;
                    }
                    out.push(bytes[i]);
                    i += 1;
                }
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                byte => {
                    out.push(byte);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).to_string()
    }

    #[test]
    fn update_user_profile_without_session_errors() {
        let h = Harness::new().with_api_config();
        let err = update_user_profile(h.ctx(), &UserProfileUpdatePayload::default()).unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法修改资料");
    }

    #[test]
    fn pick_upload_user_image_requires_login_and_sends_file() {
        let h = Harness::new().with_api_config();
        let err = pick_upload_user_image(h.ctx()).unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法上传图片");

        let h = Harness::new().with_api_config().with_token("tok");
        h.files
            .write(&std::path::PathBuf::from("/tmp/头像.png"), b"png-bytes")
            .unwrap();
        h.dialog
            .picked_image
            .lock()
            .unwrap()
            .replace(std::path::PathBuf::from("/tmp/头像.png"));
        h.http.enqueue(
            200,
            r#"{"code":1,"msg":"","data":{"url":"https://cdn/x.png"}}"#.to_string(),
        );
        let out = pick_upload_user_image(h.ctx()).unwrap().unwrap();
        assert_eq!(out.url, "https://cdn/x.png");
        let last = h.last_request();
        assert_eq!(last.method, "POST");
        let body = String::from_utf8_lossy(last.body.as_deref().unwrap_or_default()).to_string();
        assert!(body.contains("name=\"token\""), "{body}");
        assert!(body.contains("tok"), "{body}");
        assert!(body.contains("png-bytes"), "{body}");
    }

    #[test]
    fn pick_upload_user_image_returns_none_when_dialog_cancelled() {
        let h = Harness::new().with_api_config().with_token("tok");
        assert_eq!(pick_upload_user_image(h.ctx()).unwrap(), None);
        assert!(h.requests().is_empty());
    }
}
