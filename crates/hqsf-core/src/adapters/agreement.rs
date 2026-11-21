//! 用户协议读取（1.x `src/main/adapters/agreement.adapter.ts` 的 Rust 平移）。
//!
//! 1.x 的候选路径是 `[join(process.cwd(),'doc','用户协议.md'), join(process.resourcesPath,'agreement.md')]`，
//! 先命中先赢。Tauri 下没有「进程 cwd = 仓库根」这个概念（而且内核禁 `std::env`），随包资源经
//! `tauri.conf.json` 的 `bundle.resources` 一对一映射到 `resource_dir/agreement.md`，
//! 因此这里的候选换成：
//!
//! 1. `resource_dir/agreement.md`（随包资源，与 1.x 的 `resourcesPath/agreement.md` 对应）；
//! 2. `resource_dir/doc/用户协议.md`（开发/测试时把仓库 `doc/用户协议.md` 放到资源目录旁即可命中，
//!    等价于 1.x 的 `cwd/doc/用户协议.md` 分支）。
//!
//! 错误文案与 1.x 逐字一致，只是「已尝试」列表里是上面两条 `resource_dir` 路径。
//!
//! TODO(L5): 正文转换接缝见 [`md_to_html`]（1.x 调用 `mdToHtml(md)`，`agreement.adapter.ts:45`）。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use fancy_regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::CoreCtx;
use crate::error::{CoreError, CoreResult};
use crate::ports::AppPaths;

/// 协议首部的版本号标注：`版本：vX.Y`（1.x `VERSION_RE`，`agreement.adapter.ts:12`）。
///
/// 1.x：`/版本：\s*(v?\d[\d.]*)/`，取第一个捕获组（`v` 前缀可选）。
const VERSION_RE_PATTERN: &str = r"版本：\s*(v?\d[\d.]*)";

static VERSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(VERSION_RE_PATTERN).expect("协议版本正则必须可编译"));

/// `hqsf:get-agreement` 的载荷（契约 `AgreementData`：`version` + `html`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgreementData {
    pub version: String,
    pub html: String,
}

/// 1.x `agreementPaths()`：候选协议文件路径（顺序即「先命中先赢」）。
pub fn agreement_paths(paths: &AppPaths) -> Vec<PathBuf> {
    vec![
        paths.resource_dir.join("agreement.md"),
        paths.resource_dir.join("doc").join("用户协议.md"),
    ]
}

/// 1.x `loadAgreement()`：读协议 → 抽版本号 → 转 HTML。
///
/// 失败分支文案（`agreement.adapter.ts:38` / `:43`）逐字保留；读取失败由
/// [`crate::infra::fs`] 的错误原样抛出（1.x 是 `readFileSync` 的异常 → `fail(err)`）。
pub fn load_agreement(ctx: &CoreCtx) -> CoreResult<AgreementData> {
    let candidates = agreement_paths(&ctx.paths);
    let file = candidates
        .iter()
        .find(|candidate| ctx.files.exists(candidate))
        .cloned()
        .ok_or_else(|| {
            let joined = candidates
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(", ");
            CoreError::app(format!("未找到用户协议文件（已尝试: {joined}）"))
        })?;

    let markdown = String::from_utf8_lossy(&ctx.files.read(&file)?).into_owned();
    let version = version_of(&markdown).ok_or_else(|| {
        CoreError::app(format!(
            "用户协议中未找到版本号（{}，需在首部标注「版本：vX.Y」）",
            file.to_string_lossy()
        ))
    })?;

    // TODO(L5): 1.x `mdToHtml(md)`（`agreement.adapter.ts:45`），接缝见 [`md_to_html`]。
    let html = md_to_html(&markdown);
    Ok(AgreementData { version, html })
}

/// 从协议正文里抽版本号（1.x `md.match(VERSION_RE)?.[1]`）。
pub fn version_of(markdown: &str) -> Option<String> {
    let caps = VERSION_RE.captures(markdown).ok()??;
    caps.get(1).map(|group| group.as_str().to_string())
}

/// 协议文件路径是否在某个直接父目录下（仅测试用于核对候选列表，生产不用）。
#[allow(dead_code)]
pub fn is_in_dir(dir: &Path, path: &Path) -> bool {
    path.parent() == Some(dir)
}

// ---------- L5 接缝 ----------

/// md → HTML（1.x `mdToHtml`）：协议页正文，走 L5 的 `infra::markdown`（逐字节对等）。
fn md_to_html(markdown: &str) -> String {
    crate::infra::markdown::md_to_html(markdown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FileStore;
    use crate::testkit::Harness;

    fn write_agreement(h: &Harness, relative: &str, content: &str) {
        let path = h.ctx().paths.resource_dir.join(relative);
        h.files.write(&path, content.as_bytes()).unwrap();
    }

    #[test]
    fn agreement_paths_are_resource_dir_first() {
        let h = Harness::new();
        let paths = agreement_paths(&h.ctx().paths);
        assert_eq!(
            paths,
            vec![
                h.ctx().paths.resource_dir.join("agreement.md"),
                h.ctx().paths.resource_dir.join("doc").join("用户协议.md"),
            ]
        );
    }

    #[test]
    fn load_agreement_reads_version_and_converts_markdown() {
        let h = Harness::new();
        write_agreement(
            &h,
            "agreement.md",
            "> 版本：v1.2（草案）｜ 最后更新：2026-08-11\n\n# 用户协议\n正文",
        );

        let data = load_agreement(h.ctx()).unwrap();
        assert_eq!(data.version, "v1.2");
        // 与 1.x 一致：首部 blockquote 在前，正文标题渲染成 `<h1>`。
        assert!(data.html.starts_with("<blockquote>"), "{}", data.html);
        assert!(data.html.contains("<h1>用户协议</h1>"), "{}", data.html);
    }

    #[test]
    fn load_agreement_accepts_version_without_v_prefix() {
        let h = Harness::new();
        write_agreement(&h, "doc/用户协议.md", "版本： 2.0\n正文");
        let data = load_agreement(h.ctx()).unwrap();
        assert_eq!(data.version, "2.0");
    }

    #[test]
    fn load_agreement_reports_missing_files_with_attempted_paths() {
        let h = Harness::new();
        let err = load_agreement(h.ctx()).unwrap_err();
        let paths = agreement_paths(&h.ctx().paths);
        let joined = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(", ");
        assert_eq!(
            err.to_string(),
            format!("未找到用户协议文件（已尝试: {joined}）")
        );
    }

    #[test]
    fn load_agreement_reports_missing_version_with_file_path() {
        let h = Harness::new();
        write_agreement(&h, "agreement.md", "# 用户协议\n没有版本号");
        let file = h.ctx().paths.resource_dir.join("agreement.md");
        let err = load_agreement(h.ctx()).unwrap_err();
        assert_eq!(
            err.to_string(),
            format!(
                "用户协议中未找到版本号（{}，需在首部标注「版本：vX.Y」）",
                file.to_string_lossy()
            )
        );
    }

    #[test]
    fn version_of_takes_first_match_only() {
        assert_eq!(
            version_of("版本：v1.0\n版本：v9.9"),
            Some("v1.0".to_string())
        );
        assert_eq!(version_of("无"), None);
        assert_eq!(version_of("版本："), None);
    }

    #[test]
    fn agreement_data_serializes_camel_case() {
        let data = AgreementData {
            version: "v1.2".to_string(),
            html: "<p>x</p>".to_string(),
        };
        let value = serde_json::to_value(&data).unwrap();
        assert_eq!(value["version"], "v1.2");
        assert_eq!(value["html"], "<p>x</p>");
    }
}
