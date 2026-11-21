//! 评论相关的纯规则（原 `src/main/domain/activity-rules.ts` 的评论部分 +
//! `src/main/ipc/comment.handlers.ts` 的入参校验文案 + `src/main/comment-request.ts` 的
//! 请求参数规整）。
//!
//! 只做判定/文案，不碰 IO、不 import `adapters`（分层约束：`commands → services →
//! adapters → domain`，方向不可逆）。评论的输出类型在 [`crate::adapters::comment`]。

/// 服务端在活动期间对作者评论回复的占位文案；这类评论**不展示**（直接过滤），
/// 见 `src/main/domain/activity-rules.ts:10`。
pub const SERVER_HIDDEN_COMMENT: &str = "活动期间，作者评论回复暂时隐藏";

/// 评论正文下限（`src/main/ipc/comment.handlers.ts:40`，按 JS `.length` 即 UTF-16 计长）。
pub const MIN_TEXT_CHARS: usize = 4;

/// 评论正文上限（`src/main/ipc/comment.handlers.ts:41`）。
pub const MAX_TEXT_CHARS: usize = 2000;

/// 未登录提示（`src/main/ipc/comment.handlers.ts:35`）。
pub const NOT_LOGGED_IN: &str = "未登录，无法评论";

/// 入参不是对象（`src/main/ipc/comment.handlers.ts:36`）。
pub const INVALID_PAYLOAD: &str = "无效的评论数据";

/// 添加评论缺文章 ID（`src/main/ipc/comment.handlers.ts:38`）。
pub const MISSING_TARGET_CID: &str = "缺少目标文章 ID";

/// 拉取评论列表缺文章 ID（`src/main/ipc/comment.handlers.ts:12`，文案与添加不同）。
pub const MISSING_CID: &str = "缺少文章 ID";

/// 正文过短（`src/main/ipc/comment.handlers.ts:40`）。
pub const TEXT_TOO_SHORT: &str = "评论内容至少 4 个字";

/// 正文过长（`src/main/ipc/comment.handlers.ts:41`）。
pub const TEXT_TOO_LONG: &str = "评论内容过长（最多 2000 字）";

/// `parent` 类型非法（`src/main/ipc/comment.handlers.ts:43`）。
pub const INVALID_PARENT: &str = "无效的回复目标";

/// `reviewid` 类型非法（`src/main/ipc/comment.handlers.ts:47`）。
pub const INVALID_REVIEW_LINK: &str = "无效的评审关联";

/// 评论发布失败的兜底文案（`src/main/adapters/read.adapter.ts:957`）。
pub const SUBMIT_FAILED: &str = "评论发布失败";

/// JS 字符串长度：按 UTF-16 code unit 计数（`'😀'.length === 2`）。
///
/// 1.x 的所有「至少 4 字 / 最多 2000 字」门禁都是 JS `string.length`，用 Rust 的
/// `chars().count()`（码点）或 `len()`（字节）都会与 1.x 判定不一致。
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 是否为服务端占位评论（比较前两端 trim，与 `sanitizeCommentList` 一致）。
pub fn is_server_hidden(text: &str) -> bool {
    text.trim() == SERVER_HIDDEN_COMMENT
}

/// 真实用户 ID：非空且不是 `'0'`（`activity-rules.ts:81`）。
pub fn is_real_uid(uid: &str) -> bool {
    !uid.is_empty() && uid != "0"
}

/// 匿名活动文章下，评论者是否就是文章作者（需要匿名化展示名）。
///
/// 对应 `sanitizeCommentList`：`authorId` 与 `articleAuthorId` 都必须是真实 uid 且相等。
pub fn should_anonymize_comment(author_id: &str, article_author_id: &str) -> bool {
    is_real_uid(author_id) && is_real_uid(article_author_id) && author_id == article_author_id
}

/// 校验评论正文（先去两端空白，再按 UTF-16 计长）。
///
/// 返回 `Err(文案)` 时文案已与 1.x 逐字一致，调用方直接把它变成 `CoreError::app`。
pub fn validate_text(text: &str) -> Result<(), String> {
    let len = js_len(text.trim());
    if len < MIN_TEXT_CHARS {
        return Err(TEXT_TOO_SHORT.to_string());
    }
    if len > MAX_TEXT_CHARS {
        return Err(TEXT_TOO_LONG.to_string());
    }
    Ok(())
}

/// 校验文章 ID（trim 后非空）。
pub fn validate_cid(cid: &str) -> Result<(), String> {
    if cid.trim().is_empty() {
        return Err(MISSING_TARGET_CID.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_len_counts_utf16_code_units() {
        assert_eq!(js_len(""), 0);
        assert_eq!(js_len("荒启"), 2);
        // 每个 emoji 在 UTF-16 里占 2 个 code unit
        assert_eq!(js_len("😀"), 2);
        assert_eq!(js_len("a😀b"), 4);
    }

    #[test]
    fn validate_text_matches_js_length_rules() {
        let cases: [(&str, Result<(), String>); 6] = [
            ("", Err(TEXT_TOO_SHORT.to_string())),
            ("   ", Err(TEXT_TOO_SHORT.to_string())),
            ("abc", Err(TEXT_TOO_SHORT.to_string())),
            ("abcd", Ok(())),
            ("  abcd  ", Ok(())),
            ("😀😀", Ok(())),
        ];
        for (text, expected) in cases {
            assert_eq!(validate_text(text), expected, "text = {text:?}");
        }
    }

    #[test]
    fn validate_text_rejects_over_2000_utf16_units() {
        assert!(validate_text(&"a".repeat(2000)).is_ok());
        assert_eq!(
            validate_text(&"a".repeat(2001)),
            Err(TEXT_TOO_LONG.to_string())
        );
        // 1001 个 emoji = 2002 个 code unit，1.x 会拒绝
        assert_eq!(
            validate_text(&"😀".repeat(1001)),
            Err(TEXT_TOO_LONG.to_string())
        );
    }

    #[test]
    fn server_hidden_comment_is_trimmed_compare() {
        assert!(is_server_hidden(SERVER_HIDDEN_COMMENT));
        assert!(is_server_hidden(&format!("  {SERVER_HIDDEN_COMMENT}\n")));
        assert!(!is_server_hidden("正常评论"));
    }

    #[test]
    fn anonymize_rule_requires_real_matching_uids() {
        assert!(should_anonymize_comment("7", "7"));
        assert!(!should_anonymize_comment("7", "8"));
        assert!(!should_anonymize_comment("", ""));
        assert!(!should_anonymize_comment("0", "0"));
        assert!(!should_anonymize_comment("7", "0"));
    }

    #[test]
    fn validate_cid_matches_1x_messages() {
        assert_eq!(validate_cid("  "), Err(MISSING_TARGET_CID.to_string()));
        assert_eq!(validate_cid("1254"), Ok(()));
    }
}
