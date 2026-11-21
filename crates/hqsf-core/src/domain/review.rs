//! 评审相关的纯规则（原 `src/main/domain/activity-rules.ts` 的评审部分 +
//! `src/main/ipc/review.handlers.ts` 的入参校验文案 + `src/main/adapters/read.adapter.ts`
//! 里 `sanitizeReviewList` 的判定）。
//!
//! 输出类型与请求拼装在 [`crate::adapters::review`]；本模块只提供判定与文案，
//! 便于表驱动测试，也避免 `domain` 反向依赖 `adapters`。

use std::collections::BTreeSet;

use serde_json::Value;

/// 五个评分维度的字段名与顺序（`src/main/ipc/review.handlers.ts:27`）。
/// 顺序有意义：校验时按此顺序短路，先报哪个维度的错是 1.x 的行为。
pub const DIMENSIONS: [&str; 5] = ["dianzi", "wenbi", "renwu", "jiezou", "liyi"];

/// 每个维度的评语下限（`src/main/ipc/review.handlers.ts:30`，JS `.length` 计长）。
pub const MIN_COMMENT_CHARS: usize = 10;

/// 评分下限（含）。
pub const MIN_SCORE: f64 = 0.0;

/// 评分上限（含）。
pub const MAX_SCORE: f64 = 10.0;

/// 单维度评分被隐藏时的展示值（`activity-rules.ts:59`）。
pub const HIDDEN_SCORE: &str = "-.-";

/// 五维总评分被隐藏时的展示值（`activity-rules.ts:60`）。
pub const HIDDEN_SCORE_LIST: &str = "-.-,-.-,-.-,-.-,-.-";

/// 非法调用来源（1.x `trusted(event)` 失败时的文案）。
///
/// 内核拿不到 Tauri 事件，来源校验由壳层做；这里导出常量供壳层复用，保证文案唯一。
pub const ILLEGAL_SOURCE: &str = "非法调用来源";

/// 提交评审时未登录（`src/main/ipc/review.handlers.ts:20`）。
pub const NOT_LOGGED_IN_SUBMIT: &str = "未登录，无法评审";

/// 表态时未登录（`src/main/ipc/review.handlers.ts:46`，1.x 文案就比提交短）。
pub const NOT_LOGGED_IN_ATTITUDE: &str = "未登录";

/// 入参不是对象（`src/main/ipc/review.handlers.ts:22`）。
pub const INVALID_PAYLOAD: &str = "无效的评审数据";

/// 缺文章 ID（`src/main/ipc/review.handlers.ts:23`）。
pub const MISSING_CID: &str = "缺少目标文章 ID";

/// `id` 类型非法（`src/main/ipc/review.handlers.ts:25`）。
pub const INVALID_REVIEW_ID: &str = "无效的评审 ID";

/// 评审提交失败的兜底文案（`read.adapter.ts:729`）。
pub const SUBMIT_FAILED: &str = "提交失败";

/// 表态失败的兜底文案（`read.adapter.ts:745`）。
pub const ATTITUDE_FAILED: &str = "表态失败";

/// 文章不可读错误的固定前缀（`read.adapter.ts:411`）。
pub const ARTICLE_UNAVAILABLE_PREFIX: &str = "拉取文章失败: ";

/// 服务端没给消息时的兜底（`read.adapter.ts:413`）。
pub const ARTICLE_UNAVAILABLE_REASON: &str = "未公开或不存在";

/// `mid` 是否落在「进行中/评审中」活动集合里（`activity-rules.ts:25`）。
///
/// `mid == null` 一律 false；集合里存的是字符串形式。
pub fn is_in_mids(mids: &BTreeSet<String>, mid: Option<&str>) -> bool {
    mid.is_some_and(|m| mids.contains(m))
}

/// 评审是否必须隐藏评分（`activity-rules.ts:55-64`）。
///
/// 命中活动且**不是自己的**评审才隐藏；自己的评审始终保留评分。
pub fn should_hide_review_score(
    active_id: Option<&str>,
    mids: &BTreeSet<String>,
    review_uid: &str,
    my_uid: Option<&str>,
) -> bool {
    let is_mine = my_uid.is_some_and(|u| !u.is_empty() && u == review_uid);
    !is_mine && is_in_mids(mids, active_id)
}

/// 校验单个维度的评语长度，错误文案与 1.x 逐字一致。
pub fn validate_dimension_text(dimension: &str, text: &str) -> Result<(), String> {
    let len = crate::domain::comment::js_len(text.trim());
    if len < MIN_COMMENT_CHARS {
        return Err(format!("「{dimension}」评语需至少 10 字"));
    }
    Ok(())
}

/// 校验单个维度的评分，错误文案与 1.x 逐字一致。
///
/// `score` 语义是 1.x 的 `Number(payload[d + 'Score'])`：非数字/NaN/无穷 都算非法
/// （见 [`js_number`]）。边界 `0` 与 `10` 合法。
pub fn validate_dimension_score(dimension: &str, score: f64) -> Result<(), String> {
    if !score.is_finite() || !(MIN_SCORE..=MAX_SCORE).contains(&score) {
        return Err(format!("「{dimension}」评分需在 0-10 之间"));
    }
    Ok(())
}

/// JS `Number(v)` 的近似实现（只用于评分校验，不参与展示）。
///
/// - `null` → 0、`true` → 1、`false` → 0、数字原样
/// - 字符串：先 trim，空串 0；`"Infinity"`/`"-Infinity"` → ±∞；其余按十进制/十六进制解析，
///   解析失败 → `NaN`
/// - 数组：空数组 0、单元素数组递归、多元素 → `NaN`
/// - 对象 → `NaN`
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_from_str(s),
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => js_number(items.first()),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn js_number_from_str(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_or(f64::NAN, |v| v as f64);
    }
    // Rust 的 `f64::from_str` 接受 `nan`/`inf` 等 JS 不认的写法，先挡掉。
    let lower = s.to_ascii_lowercase();
    if lower.contains("nan") || lower.contains("inf") {
        return f64::NAN;
    }
    s.parse::<f64>().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mids(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    #[test]
    fn is_in_mids_matches_1x() {
        let set = mids(&["3", "9"]);
        assert!(is_in_mids(&set, Some("3")));
        assert!(is_in_mids(&set, Some("9")));
        assert!(!is_in_mids(&set, Some("4")));
        assert!(!is_in_mids(&set, None));
        assert!(!is_in_mids(&mids(&[]), Some("3")));
    }

    #[test]
    fn own_review_keeps_score_others_hide() {
        let set = mids(&["5"]);
        // 别人的评审命中活动 → 隐藏
        assert!(should_hide_review_score(Some("5"), &set, "7", Some("1")));
        // 自己的评审 → 保留
        assert!(!should_hide_review_score(Some("5"), &set, "7", Some("7")));
        // 未登录（无 my_uid）→ 隐藏
        assert!(should_hide_review_score(Some("5"), &set, "7", None));
        assert!(should_hide_review_score(Some("5"), &set, "7", Some("")));
        // 不在活动中 → 不隐藏
        assert!(!should_hide_review_score(Some("6"), &set, "7", None));
        assert!(!should_hide_review_score(None, &set, "7", None));
    }

    #[test]
    fn dimension_text_requires_ten_utf16_units() {
        assert_eq!(
            validate_dimension_text("dianzi", "  九 个 字 不 够"),
            Err("「dianzi」评语需至少 10 字".to_string())
        );
        assert_eq!(
            validate_dimension_text("dianzi", "一二三四五六七八九十"),
            Ok(())
        );
        // 5 个 emoji = 10 code unit，1.x 认为够
        assert_eq!(validate_dimension_text("wenbi", "😀😀😀😀😀"), Ok(()));
    }

    #[test]
    fn dimension_score_bounds() {
        assert_eq!(validate_dimension_score("renwu", 0.0), Ok(()));
        assert_eq!(validate_dimension_score("renwu", 10.0), Ok(()));
        assert_eq!(validate_dimension_score("renwu", 5.5), Ok(()));
        assert_eq!(
            validate_dimension_score("renwu", -0.5),
            Err("「renwu」评分需在 0-10 之间".to_string())
        );
        assert_eq!(
            validate_dimension_score("renwu", 10.5),
            Err("「renwu」评分需在 0-10 之间".to_string())
        );
        assert_eq!(
            validate_dimension_score("renwu", f64::NAN),
            Err("「renwu」评分需在 0-10 之间".to_string())
        );
    }

    #[test]
    fn js_number_follows_js_number_semantics() {
        let cases: [(Value, f64); 12] = [
            (json!(null), 0.0),
            (json!(true), 1.0),
            (json!(false), 0.0),
            (json!(7), 7.0),
            (json!(7.5), 7.5),
            (json!("8"), 8.0),
            (json!(" 8.5 "), 8.5),
            (json!(""), 0.0),
            (json!("0x10"), 16.0),
            (json!([9]), 9.0),
            (json!([]), 0.0),
            (json!({ "a": 1 }), f64::NAN),
        ];
        for (value, expected) in cases {
            let got = js_number(Some(&value));
            if expected.is_nan() {
                assert!(got.is_nan(), "value = {value}");
            } else {
                assert_eq!(got, expected, "value = {value}");
            }
        }
        assert_eq!(js_number(None), 0.0);
        assert!(js_number(Some(&json!("abc"))).is_nan());
    }
}
