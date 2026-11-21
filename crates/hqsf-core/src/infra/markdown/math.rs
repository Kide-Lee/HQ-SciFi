//! 数学公式渲染：用 `rquickjs` 执行嵌入的 `assets/katex.min.js`，
//! 复刻 1.x `src/shared/markdownItMath.ts` 里的 `renderMath()`：
//!
//! ```js
//! try { return katex.renderToString(latex, { throwOnError: false, displayMode }) }
//! catch { /* 转义 & < > 后包 katex-error */ }
//! ```
//!
//! 为什么不是用 Rust 的 KaTeX 移植：1.x 的输出会写进服务端（发布内容），
//! 必须与前端同版本（KaTeX 0.18.4）**逐字节**一致——连 `style` 里的浮点数都算在内。
//! 唯一能保证这点的做法就是跑同一份 JS。JS 单例见 [`super::js`]（与 turndown 共用
//! 同一个 Context：两处都是「跑前端同一份实现」的场景）。

#[cfg(test)]
use crate::CoreError;
use crate::CoreResult;

/// 1.x 的异常兜底：只转义 `& < >`（不转义引号），与 `markdownItMath.ts` 的 catch 分支一致。
fn katex_error_html(latex: &str, display: bool) -> String {
    let escaped = latex
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    if display {
        format!("<div class=\"katex-error\">{escaped}</div>")
    } else {
        format!("<span class=\"katex-error\">{escaped}</span>")
    }
}

/// 渲染一个公式，返回 KaTeX HTML（与 1.x `katex.renderToString(latex,{throwOnError:false,displayMode})`
/// 逐字节一致）。
///
/// 与 1.x 的对应关系：1.x 的 `renderMath()` 会 `try/catch` 包一层；
/// 本函数只负责引擎调用，JS 抛异常时返回 `Err`，由 `md_to_html` 走 1.x 的
/// `<span/div class="katex-error">…` 兜底（KaTeX 自身的解析错误由
/// `throwOnError:false` 在 JS 内部处理，不会走到这里，与 1.x 相同）。
pub fn render(latex: &str, display: bool) -> CoreResult<String> {
    super::js::render_math(latex, display)
}

/// `md_to_html` 用：JS 引擎异常时复刻 1.x `renderMath` 的 catch 兜底。
pub(crate) fn render_or_fallback(latex: &str, display: bool) -> String {
    match render(latex, display) {
        Ok(html) => html,
        Err(_) => katex_error_html(latex, display),
    }
}

/// 测试专用：断言引擎错误文案前缀（避免把 rquickjs 的错误串写死进用例）。
#[cfg(test)]
fn assert_engine_error(err: &CoreError, prefix: &str) {
    let text = err.to_string();
    assert!(text.starts_with(prefix), "错误文案不符：{text}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_inline_math_like_katex_018() {
        // 期望值取自 Node oracle（node_modules/katex@0.18.4，mdToHtml 真实现）。
        let html = render("x^2", false).unwrap();
        assert!(html.starts_with("<span class=\"katex\"><span class=\"katex-mathml\">"));
        assert!(html.contains("<annotation encoding=\"application/x-tex\">x^2</annotation>"));
        assert!(html.contains("<span class=\"katex-html\" aria-hidden=\"true\">"));
        assert!(html.ends_with("</span></span>"));
    }

    #[test]
    fn renders_display_math_with_display_block() {
        let html = render("E = mc^2", true).unwrap();
        assert!(html.starts_with("<span class=\"katex-display\">"));
        assert!(
            html.contains("<math xmlns=\"http://www.w3.org/1998/Math/MathML\" display=\"block\">")
        );
    }

    #[test]
    fn throw_on_error_false_renders_katex_error_span() {
        // 与 1.x 相同：非法命令不抛异常，KaTeX 自己返回红色错误节点。
        let html = render("\\notacommand", false).unwrap();
        assert!(html.contains("<mstyle mathcolor=\"#cc0000\">"));
        assert!(html.contains("<span class=\"mord text\" style=\"color:#cc0000;\">"));
    }

    #[test]
    fn cjk_text_in_math_mode_is_rendered_as_fallback_glyph() {
        // 语料里 `$100 与 $` 这类输入会让 KaTeX 走 CJK fallback（console.warn 被静默）。
        let html = render("100 与 ", false).unwrap();
        assert!(html.contains("mord cjk_fallback"));
    }

    #[test]
    fn fallback_wraps_escaped_latex_when_engine_reports_error() {
        assert_eq!(
            katex_error_html("a<b&c>d", false),
            "<span class=\"katex-error\">a&lt;b&amp;c&gt;d</span>"
        );
        assert_eq!(
            katex_error_html("a<b&c>d", true),
            "<div class=\"katex-error\">a&lt;b&amp;c&gt;d</div>"
        );
    }

    #[test]
    fn engine_errors_keep_the_chinese_prefix() {
        // 引擎初始化失败时用户看到的是中文前缀（不会把 qjs 的内部错误直接抛给用户）。
        let err = CoreError::App("内嵌 JS 引擎初始化失败：boom".into());
        assert_engine_error(&err, "内嵌 JS 引擎初始化失败");
    }
}
