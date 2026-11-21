//! 用户协议通道（1.x `src/main/ipc/agreement.handlers.ts`，1 条）。
//!
//! 1.x handler 不校验 `trusted(event)`（`agreement.handlers.ts:6-12`）：协议门在首启/登录前
//! 展示，渲染层随时可读。内核同样不校验来源，等价保护交给壳层（命令只由本应用窗口 IPC 触发）。
//!
//! 业务逻辑（候选路径、版本号正则、错误文案）全在 [`crate::adapters::agreement`]。

use crate::CoreCtx;
use crate::adapters::agreement::{self, AgreementData};
use crate::error::CoreResult;

/// `hqsf:get-agreement` → `AgreementData{version,html}`。
pub fn get_agreement(ctx: &CoreCtx) -> CoreResult<AgreementData> {
    agreement::load_agreement(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FileStore;
    use crate::testkit::Harness;

    #[test]
    fn get_agreement_returns_version_and_html() {
        let h = Harness::new();
        let path = h.ctx().paths.resource_dir.join("agreement.md");
        h.files
            .write(&path, "> 版本：v1.2（草案）\n\n# 用户协议".as_bytes())
            .unwrap();

        let out = get_agreement(h.ctx()).unwrap();
        assert_eq!(out.version, "v1.2");
        assert!(out.html.contains("<h1>用户协议</h1>"), "{}", out.html);
    }

    #[test]
    fn get_agreement_reports_original_missing_file_message() {
        let h = Harness::new();
        let err = get_agreement(h.ctx()).unwrap_err();
        // 1.x：未找到用户协议文件（已尝试: <paths.join(', ')>）
        assert!(
            err.to_string().starts_with("未找到用户协议文件（已尝试: "),
            "{err}"
        );
    }
}
