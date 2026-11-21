//! 用户域的纯工具：1.x `adapters/read.adapter.ts:38-60` 那些 JS 语义的 Python-Rust 版
//! （`num` / `str` / `normTs` / `optNum` / `boolish`）以及 `ipc/shared.ts` 的 `checkedUid`。
//!
//! 这些函数没有 IO，被 `adapters/{user,chat,notify,browse,interact}.rs` 共用：远端响应一律先
//! 当 `serde_json::Value` 收下（1.x 的入参就是 `Record<string, unknown>`，强类型 Raw 结构体会
//! 在某条数据字段类型不符时整条失败，与 1.x 的容错语义不一致），再用这里的工具做字段规整。
//!
//! 数值语义按 1.x 的 `Number()`：字符串数字也参与；NaN/Infinity 归 0。输出统一 `i64`
//! （契约字段是 TS `number`；荒启这些字段实测都是整数，`{created, views, total, ...}`）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// 契约里 `string | number` 的入参（uid/touid/cid/key/num …）。
///
/// 1.x 全部用 `String(x)` / `Number(x)` 宽容处理，所以命令层收这个而不是硬类型，
/// 被 `null`/缺省交给 `Option<JsonScalar>` 表达。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum JsonScalar {
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

impl JsonScalar {
    /// JS `String(v)`（只覆盖标量；这里出现的字段都是标量）。
    pub fn js_string(&self) -> String {
        match self {
            Self::Bool(b) => b.to_string(),
            Self::Int(i) => i.to_string(),
            Self::Float(f) => js_float_string(*f),
            Self::Text(s) => s.clone(),
        }
    }

    /// JS `Number(v)`；非有限返回 `None`（调用方当 NaN 处理）。
    pub fn js_number(&self) -> Option<f64> {
        match self {
            Self::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Self::Int(i) => Some(*i as f64),
            Self::Float(f) => f.is_finite().then_some(*f),
            Self::Text(s) => parse_js_number(s),
        }
    }

    /// JS `v === true`（注意不是 `boolean 宽松判断`：`1`/`'1'` 都算 false）。
    pub fn is_true(&self) -> bool {
        matches!(self, Self::Bool(true))
    }

    /// 转成 `serde_json::Value`（用于拼 `searchParams` 里的 `authorId` 等）。
    pub fn to_value(&self) -> Value {
        match self {
            Self::Bool(b) => Value::Bool(*b),
            Self::Int(i) => Value::from(*i),
            Self::Float(f) => serde_json::Number::from_f64(*f)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            Self::Text(s) => Value::String(s.clone()),
        }
    }
}

/// JS 数字字符串化：整数不带 `.0`。
fn js_float_string(f: f64) -> String {
    if !f.is_finite() {
        return "NaN".to_string();
    }
    if f.fract() == 0.0 && f.abs() < 1e15 {
        return (f as i64).to_string();
    }
    f.to_string()
}

fn js_number_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    js_float_string(n.as_f64().unwrap_or(0.0))
}

/// JS `Number(string)`（`null`/缺省由调用方转成 `None`）。
fn parse_js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(rest, 16).ok().map(|v| v as f64);
    }
    if t == "Infinity" || t == "+Infinity" {
        return None;
    }
    if t == "-Infinity" || t == "NaN" {
        return None;
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// JS `String(v)`：`null`/缺省 → `''`，数字按 JS 规则（`7` 而不是 `7.0`）。
pub fn str_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n),
        // 1.x 这些字段不会是数组/对象；兜底用 JSON 文本（JS 会是 "a,b"/"[object Object]"）。
        Value::Array(_) | Value::Object(_) => v.to_string(),
    }
}

/// JS `Number(v ?? 0)`，NaN/Infinity → 0。
pub fn num(v: &Value) -> i64 {
    number(v).map(|f| f as i64).unwrap_or(0)
}

/// JS `Number(v)`，非有限 → `None`（供 `optNum` 等需要区分 NaN 的场景）。
pub fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => parse_js_number(s),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// 1.x `optNum`：`null` / `''` → `None`；非有限 → `None`；否则取整。
pub fn opt_num(v: &Value) -> Option<i64> {
    if v.is_null() || v.as_str() == Some("") {
        return None;
    }
    number(v).map(|f| f as i64)
}

/// 1.x `num`：`0` 是有效值，用 `num(...) || undefined` 的调用方自己判 `== 0`。
pub fn num_or_undef(v: &Value) -> Option<i64> {
    let n = num(v);
    (n != 0).then_some(n)
}

/// 1.x `boolish`：`true` / `1` / `'1'` / `'true'`。
pub fn boolish(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64() == Some(1),
        Value::String(s) => s == "1" || s == "true",
        _ => false,
    }
}

/// 1.x `normTs`：统一成秒；非有限/<=0 → 0；毫秒（>1e12）→ 秒。
pub fn norm_ts(v: &Value) -> i64 {
    let Some(n) = number(v) else {
        return 0;
    };
    if n <= 0.0 {
        return 0;
    }
    if n > 1e12 {
        (n / 1000.0).floor() as i64
    } else {
        n as i64
    }
}

/// JS `a ?? b ?? c`：跳过 `null`/缺省，返回第一个存在的值。
pub fn first<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| match v.get(*key) {
        Some(Value::Null) | None => None,
        Some(found) => Some(found),
    })
}

/// `str(v[keys...])`。
pub fn str_at(v: &Value, keys: &[&str]) -> String {
    first(v, keys).map(str_of).unwrap_or_default()
}

/// `num(v[keys...])`。
pub fn num_at(v: &Value, keys: &[&str]) -> i64 {
    first(v, keys).map(num).unwrap_or(0)
}

/// `optNum(v[keys...])`。
pub fn opt_num_at(v: &Value, keys: &[&str]) -> Option<i64> {
    first(v, keys).and_then(opt_num)
}

/// `normTs(v[keys...])`。
pub fn norm_ts_at(v: &Value, keys: &[&str]) -> i64 {
    first(v, keys).map(norm_ts).unwrap_or(0)
}

/// 1.x `shared.ts` 的 `checkedUid`：`String(raw ?? '').trim()` 且 `/^\d+$/` 才用，否则 `'0'`。
pub fn checked_uid(raw: Option<&JsonScalar>) -> String {
    let s = raw.map(|v| v.js_string()).unwrap_or_default();
    let s = s.trim();
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) {
        s.to_string()
    } else {
        "0".to_string()
    }
}

/// 1.x `uidNum`：数字原样；字符串能转成正数就转数字（服务端过滤参数要求数字），否则原样。
pub fn uid_param(raw: Option<&JsonScalar>) -> Value {
    match raw {
        None => Value::String(String::new()),
        Some(JsonScalar::Float(f)) => serde_json::Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(js_float_string(*f))),
        Some(JsonScalar::Text(s)) => match parse_js_number(s) {
            Some(n) if n > 0.0 && n.fract() == 0.0 => Value::from(n as i64),
            Some(n) if n > 0.0 => serde_json::Number::from_f64(n)
                .map(Value::Number)
                .unwrap_or_else(|| Value::String(s.clone())),
            _ => Value::String(s.clone()),
        },
        Some(other) => other.to_value(),
    }
}

/// 1.x `String(x ?? '')`（用于 touid/cid/key 这类查询参数）。
pub fn js_str_param(raw: Option<&JsonScalar>) -> String {
    raw.map(|v| v.js_string()).unwrap_or_default()
}

/// 1.x `Number(page) || 1`。
pub fn page_or(raw: Option<&JsonScalar>) -> i64 {
    page_with(raw, 1)
}

/// 1.x `Number(limit) || 20`。
pub fn limit_or(raw: Option<&JsonScalar>) -> i64 {
    page_with(raw, 20)
}

fn page_with(raw: Option<&JsonScalar>, default: i64) -> i64 {
    let n = raw
        .and_then(|v| v.js_number())
        .map(|f| f as i64)
        .unwrap_or(0);
    if n == 0 { default } else { n }
}

/// 响应 `data` 可能是数组，也可能是 `{list: [...]}` / `{items: [...]}`（1.x 各处同款兜底）。
pub fn list_items(data: &Value) -> Vec<Value> {
    if let Some(arr) = data.as_array() {
        return arr.clone();
    }
    for key in ["list", "items"] {
        if let Some(arr) = data.get(key).and_then(Value::as_array) {
            return arr.clone();
        }
    }
    Vec::new()
}

/// 列表响应里非数组的 `data`（1.x `resp.data ?? []`）。
pub fn array_or_empty(data: &Value) -> Vec<Value> {
    data.as_array().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn str_of_matches_js_string_semantics() {
        assert_eq!(str_of(&Value::Null), "");
        assert_eq!(str_of(&json!("abc")), "abc");
        assert_eq!(str_of(&json!(7)), "7");
        assert_eq!(str_of(&json!(7.0)), "7");
        assert_eq!(str_of(&json!(7.5)), "7.5");
        assert_eq!(str_of(&json!(true)), "true");
    }

    #[test]
    fn num_accepts_numeric_strings_and_rejects_garbage() {
        assert_eq!(num(&Value::Null), 0);
        assert_eq!(num(&json!(12)), 12);
        assert_eq!(num(&json!("12")), 12);
        assert_eq!(num(&json!(" 12 ")), 12);
        assert_eq!(num(&json!("")), 0);
        assert_eq!(num(&json!("12abc")), 0);
        assert_eq!(num(&json!(true)), 1);
        assert_eq!(num(&json!(0x10)), 16);
    }

    #[test]
    fn opt_num_keeps_zero_but_drops_null_and_empty() {
        assert_eq!(opt_num(&Value::Null), None);
        assert_eq!(opt_num(&json!("")), None);
        assert_eq!(opt_num(&json!(0)), Some(0));
        assert_eq!(opt_num(&json!("0")), Some(0));
        assert_eq!(opt_num(&json!("abc")), None);
    }

    #[test]
    fn norm_ts_normalizes_milliseconds_to_seconds() {
        assert_eq!(norm_ts(&json!(1_700_000_000)), 1_700_000_000);
        assert_eq!(norm_ts(&json!(1_700_000_000_000_i64)), 1_700_000_000);
        assert_eq!(norm_ts(&json!(0)), 0);
        assert_eq!(norm_ts(&json!(-5)), 0);
        assert_eq!(norm_ts(&Value::Null), 0);
    }

    #[test]
    fn checked_uid_keeps_digits_only() {
        assert_eq!(checked_uid(Some(&JsonScalar::Int(7))), "7");
        assert_eq!(checked_uid(Some(&JsonScalar::Text(" 42 ".into()))), "42");
        assert_eq!(checked_uid(Some(&JsonScalar::Text("abc".into()))), "0");
        assert_eq!(checked_uid(Some(&JsonScalar::Text("".into()))), "0");
        assert_eq!(checked_uid(None), "0");
        assert_eq!(checked_uid(Some(&JsonScalar::Float(-3.0))), "0");
    }

    #[test]
    fn uid_param_turns_positive_numeric_strings_into_numbers() {
        assert_eq!(uid_param(Some(&JsonScalar::Int(7))), json!(7));
        assert_eq!(uid_param(Some(&JsonScalar::Text("7".into()))), json!(7));
        assert_eq!(
            uid_param(Some(&JsonScalar::Text("abc".into()))),
            json!("abc")
        );
        assert_eq!(uid_param(Some(&JsonScalar::Text("0".into()))), json!("0"));
    }

    #[test]
    fn first_skips_null_but_keeps_zero_and_empty_string() {
        let v = json!({"a": null, "b": 0, "c": ""});
        assert_eq!(first(&v, &["a", "b"]).map(str_of), Some("0".into()));
        assert_eq!(first(&v, &["a", "c"]).map(str_of), Some(String::new()));
        assert_eq!(first(&v, &["nope"]), None);
    }

    #[test]
    fn page_and_limit_default_like_js_or_operator() {
        assert_eq!(page_or(None), 1);
        assert_eq!(page_or(Some(&JsonScalar::Int(0))), 1);
        assert_eq!(page_or(Some(&JsonScalar::Int(3))), 3);
        assert_eq!(page_or(Some(&JsonScalar::Text("3".into()))), 3);
        assert_eq!(limit_or(None), 20);
        assert_eq!(limit_or(Some(&JsonScalar::Int(5))), 5);
    }

    #[test]
    fn list_items_accepts_array_and_wrapped_shapes() {
        assert_eq!(list_items(&json!([1, 2])).len(), 2);
        assert_eq!(list_items(&json!({"list": [1]})).len(), 1);
        assert_eq!(list_items(&json!({"items": [1, 2, 3]})).len(), 3);
        assert_eq!(list_items(&json!({"data": [1]})).len(), 0);
        assert_eq!(list_items(&Value::Null).len(), 0);
    }

    #[test]
    fn is_true_is_strict_like_ts_strict_equality() {
        assert!(JsonScalar::Bool(true).is_true());
        assert!(!JsonScalar::Bool(false).is_true());
        assert!(!JsonScalar::Int(1).is_true());
        assert!(!JsonScalar::Text("true".into()).is_true());
    }
}
