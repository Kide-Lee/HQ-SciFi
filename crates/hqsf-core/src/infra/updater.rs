//! 更新检查（原 `src/main/infra/updater/index.ts`）。
//!
//! 1.x 不用 `electron-updater`：从 GitHub Releases API 取最新 tag，与当前版本比较，
//! 把结果作为 [`UpdateState`] 推给渲染层；渲染层只显示横幅 + 「前往下载」，
//! 下载/安装都是 `shell.openExternal(release.html_url)` 打开浏览器（deb 包不自动更新）。
//! Rust 侧**逐字段复刻**同一套状态机，不做自动安装。
//!
//! 状态 `lastState` 在 1.x 是模块级变量；内核没有全局状态，容器由壳层持有并注入
//! （见 [`UpdateStateStore`]），命令/服务都以 `&UpdateStateStore` 读写。

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::infra::net::api::USER_AGENT;
use crate::ports::{HttpRequest, HttpTransport};

/// GitHub 仓库属主（`src/main/infra/updater/index.ts:12`）。
pub const GITHUB_OWNER: &str = "Kide-Lee";

/// GitHub 仓库名（`src/main/infra/updater/index.ts:13`）。
pub const GITHUB_REPO: &str = "HQ-SciFi";

/// 后端 → 渲染层的更新状态事件通道名。
///
/// 注意契约 A2：`hqsf:update-state` 同时也是 invoke 通道（`commands::updater::update_state`），
/// 两条语义共用同一个字符串。
pub const EVENT_UPDATE_STATE: &str = "hqsf:update-state";

/// Release notes 截断长度（1.x `body?.slice(0, 500)`）。
pub const NOTES_LIMIT: usize = 500;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const SNIPPET_LIMIT: usize = 200;

/// GitHub releases 接口地址（1.x 用模板字符串拼）。
pub fn latest_release_url() -> String {
    format!("https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest")
}

/// 更新流程状态（1.x `src/shared/domain/index.ts:53-60`，逐字段一致）。
///
/// 线上形状是内部标记联合：`{"status":"available","version":…,"notes":…,"url":…}`；
/// 变体名 kebab-case（`not-available`），字段名都是单词、无需再转换。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateState {
    /// 还没检查过（进程启动时的初始值）。
    #[default]
    Idle,
    /// 正在检查（请求发出前先广播，渲染层显示「检查中」）。
    Checking,
    /// 有新版本可下载。
    Available {
        /// 去掉 `v` 前缀的版本号，如 `0.2.0`。
        version: String,
        /// Release 正文前 [`NOTES_LIMIT`] 个字符；没有正文时是空串（1.x 的 `|| ''`）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
        /// 下载页（GitHub release 页面）；响应缺 `html_url` 时为 `None`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// 已是最新（或远端版本更低）。
    NotAvailable,
    /// 下载进度（1.x 未使用 electron-updater，保留变体保持契约完整）。
    Downloading { percent: f64 },
    /// 下载完成（同上，1.x 未使用）。
    Downloaded {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    /// 检查失败（`message` 直接展示给用户）。
    Error { message: String },
}

/// 进程内更新状态（1.x `let lastState: UpdateState`）。
///
/// 壳层构造一次并放进 Tauri managed state；`Mutex` 只为满足 `Send + Sync`，
/// 实际调用是「读一次 / 写一次」，不会长期持锁。
#[derive(Debug)]
pub struct UpdateStateStore {
    app_version: String,
    state: Mutex<UpdateState>,
}

impl UpdateStateStore {
    /// `app_version` 是壳层注入的当前版本（1.x `app.getVersion()`），检查时与 release tag 比较。
    pub fn new(app_version: impl Into<String>) -> Self {
        Self {
            app_version: app_version.into(),
            state: Mutex::new(UpdateState::default()),
        }
    }

    /// 当前应用版本（只读）。
    pub fn app_version(&self) -> &str {
        &self.app_version
    }

    /// 最近一次状态（`hqsf:update-state` invoke 返回它）。
    pub fn get(&self) -> UpdateState {
        self.lock().clone()
    }

    /// 写入新状态并返回写入后的状态（对应 1.x `setState`，便于「先更新再广播」）。
    pub fn set(&self, state: UpdateState) -> UpdateState {
        let mut guard = self.lock();
        *guard = state;
        guard.clone()
    }

    fn lock(&self) -> MutexGuard<'_, UpdateState> {
        // 持锁时 panic 只会发生在测试断言里；恢复内值比让后续命令全部 panic 更合适。
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// GitHub `releases/latest` 响应里用到的字段（1.x `ReleaseInfo`）。
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ReleaseInfo {
    /// git tag，如 `v0.2.0`；缺失时按空串处理（比较后不会判定有新版本）。
    #[serde(default)]
    pub tag_name: String,
    /// release 页面地址；1.x 类型上是 string，运行时可能缺失，这里保留 `None`。
    #[serde(default)]
    pub html_url: Option<String>,
    /// release 正文（Markdown），可能不存在。
    #[serde(default)]
    pub body: Option<String>,
}

/// 取 GitHub 最新 release（经 [`crate::ports::HttpTransport`]，可脱网单测）。
///
/// 请求头与 1.x 一致：`Accept: application/vnd.github+json`；`User-Agent` 按迁移约定
/// 统一用 [`USER_AGENT`]（1.x 这里写死的是 `hqsf-client`，见报告里的偏差说明）。
pub fn fetch_latest_release(http: &dyn HttpTransport) -> CoreResult<ReleaseInfo> {
    let mut headers = BTreeMap::new();
    headers.insert(
        "Accept".to_string(),
        "application/vnd.github+json".to_string(),
    );
    headers.insert("User-Agent".to_string(), USER_AGENT.to_string());

    let response = http
        .send(HttpRequest {
            method: "GET".to_string(),
            url: latest_release_url(),
            headers,
            body: None,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        })
        .map_err(|err| CoreError::app(format!("网络请求失败: {err}")))?;

    if !response.is_success() {
        // 1.x 文案：`GitHub 请求失败（HTTP ${res.status}）`
        return Err(CoreError::app(format!(
            "GitHub 请求失败（HTTP {}）",
            response.status
        )));
    }

    let text = String::from_utf8_lossy(&response.body).to_string();
    serde_json::from_str::<ReleaseInfo>(&text).map_err(|_| {
        CoreError::app(format!(
            "接口返回非 JSON（HTTP {}）: {}",
            response.status,
            snippet(&text)
        ))
    })
}

/// 由 release 与当前版本算出状态（1.x `checkForGitHubUpdate` 的比较 + 构造部分）。
///
/// - `tag` 去掉 `v`/`V` 前缀，与 1.x `normalizeVersion` 一致；
/// - 远端严格大于当前版本才算 `available`（相等/更低都算 `not-available`）。
pub fn state_for_release(app_version: &str, release: &ReleaseInfo) -> UpdateState {
    let latest = normalize_version(&release.tag_name);
    let current = normalize_version(app_version);
    if compare_versions(&latest, &current) > 0 {
        UpdateState::Available {
            version: latest,
            // 1.x：`release.body?.slice(0, 500) || ''`，没有正文也带空串。
            notes: Some(
                release
                    .body
                    .as_deref()
                    .unwrap_or_default()
                    .chars()
                    .take(NOTES_LIMIT)
                    .collect(),
            ),
            url: release.html_url.clone(),
        }
    } else {
        UpdateState::NotAvailable
    }
}

/// 去掉首尾空白与开头的 `v`/`V`（1.x `normalizeVersion`：`trim().replace(/^v/i, '')`）。
pub fn normalize_version(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    trimmed.to_string()
}

/// 逐段比较版本号（1.x `compareVersions`）：按 `.` 分段、每段 `parseInt`（失败按 0），
/// 段数不足按 0 补齐。返回值只保证符号有意义（负数/0/正数），不承诺是差值。
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let pa = version_parts(a);
    let pb = version_parts(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return if x > y { 1 } else { -1 };
        }
    }
    0
}

fn version_parts(version: &str) -> Vec<i64> {
    version
        .split('.')
        .map(|part| part.trim().parse::<i64>().unwrap_or(0))
        .collect()
}

/// 启动后自动检查的前置条件（1.x `scheduleAutoUpdateCheck` 的判断部分）。
///
/// 1.x：`if (!settings.autoUpdate) return;` 且 `if (process.platform === 'linux'
/// && !process.env.APPIMAGE) return;`——Linux 的 deb 包不支持自动更新，只有 AppImage 才检查。
/// 10 秒延迟与定时器由壳层创建（内核没有定时器能力，`Clock` 只能取当前时间）。
pub fn auto_check_enabled(auto_update: bool, platform: &str, appimage: bool) -> bool {
    if !auto_update {
        return false;
    }
    !(platform == "linux" && !appimage)
}

/// 与 `infra/net/api.rs` 的私有 `snippet` 同义（那边不可见，按同规则复刻一次）。
fn snippet(text: &str) -> String {
    text.chars().take(SNIPPET_LIMIT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::ScriptedHttp;
    use serde_json::json;

    fn release(tag: &str, body: Option<&str>, url: Option<&str>) -> ReleaseInfo {
        ReleaseInfo {
            tag_name: tag.to_string(),
            html_url: url.map(str::to_string),
            body: body.map(str::to_string),
        }
    }

    #[test]
    fn normalize_version_strips_whitespace_and_leading_v() {
        assert_eq!(normalize_version("  v0.2.0\n"), "0.2.0");
        assert_eq!(normalize_version("V1.0"), "1.0");
        assert_eq!(normalize_version("0.1.0"), "0.1.0");
        assert_eq!(normalize_version(""), "");
    }

    #[test]
    fn compare_versions_follows_the_1x_algorithm() {
        // 表驱动：1.x `compareVersions` 的语义（含 parseInt 失败按 0、缺段补 0）。
        let cases: [(&str, &str, i32); 7] = [
            ("0.2.0", "0.1.0", 1),
            ("0.1.0", "0.2.0", -1),
            ("0.1.0", "0.1.0", 0),
            ("0.1", "0.1.0", 0),
            ("1.0.0", "0.9.9", 1),
            ("0.1.0-beta", "0.1.0", 0),
            ("v0.2.0", "0.10.0", -1),
        ];
        for (a, b, expected) in cases {
            let got = compare_versions(a, b);
            assert_eq!(
                got.signum(),
                expected.signum(),
                "compare_versions({a:?}, {b:?}) = {got}"
            );
        }
    }

    #[test]
    fn newer_release_is_available_with_notes_and_url() {
        let state = state_for_release(
            "0.1.0",
            &release("v0.2.0", Some("新版本说明"), Some("https://example.test/r")),
        );
        assert_eq!(
            state,
            UpdateState::Available {
                version: "0.2.0".into(),
                notes: Some("新版本说明".into()),
                url: Some("https://example.test/r".into()),
            }
        );
    }

    #[test]
    fn same_or_older_release_is_not_available() {
        assert_eq!(
            state_for_release("0.2.0", &release("v0.2.0", None, None)),
            UpdateState::NotAvailable
        );
        assert_eq!(
            state_for_release("0.3.0", &release("v0.2.0", None, None)),
            UpdateState::NotAvailable
        );
    }

    #[test]
    fn missing_body_becomes_an_empty_notes_string() {
        let state = state_for_release("0.1.0", &release("v0.2.0", None, None));
        match state {
            UpdateState::Available { notes, url, .. } => {
                assert_eq!(notes.as_deref(), Some(""));
                assert_eq!(url, None);
            }
            other => panic!("期望 available，得到 {other:?}"),
        }
    }

    #[test]
    fn notes_are_truncated_to_the_1x_limit() {
        let body = "说".repeat(NOTES_LIMIT + 100);
        let state = state_for_release("0.1.0", &release("v0.2.0", Some(&body), None));
        match state {
            UpdateState::Available { notes, .. } => {
                assert_eq!(notes.unwrap().chars().count(), NOTES_LIMIT);
            }
            other => panic!("期望 available，得到 {other:?}"),
        }
    }

    #[test]
    fn update_state_serializes_with_status_tag_and_camel_case_fields() {
        assert_eq!(
            serde_json::to_value(UpdateState::Idle).unwrap(),
            json!({ "status": "idle" })
        );
        assert_eq!(
            serde_json::to_value(UpdateState::NotAvailable).unwrap(),
            json!({ "status": "not-available" })
        );
        assert_eq!(
            serde_json::to_value(UpdateState::Checking).unwrap(),
            json!({ "status": "checking" })
        );
        assert_eq!(
            serde_json::to_value(UpdateState::Downloading { percent: 42.5 }).unwrap(),
            json!({ "status": "downloading", "percent": 42.5 })
        );
        assert_eq!(
            serde_json::to_value(UpdateState::Downloaded {
                version: "0.2.0".into(),
                notes: Some("说明".into()),
            })
            .unwrap(),
            json!({ "status": "downloaded", "version": "0.2.0", "notes": "说明" })
        );
        assert_eq!(
            serde_json::to_value(UpdateState::Error {
                message: "检查更新失败".into(),
            })
            .unwrap(),
            json!({ "status": "error", "message": "检查更新失败" })
        );
        assert_eq!(
            serde_json::to_value(UpdateState::Available {
                version: "0.2.0".into(),
                notes: Some("说明".into()),
                url: Some("https://example.test/r".into()),
            })
            .unwrap(),
            json!({
                "status": "available",
                "version": "0.2.0",
                "notes": "说明",
                "url": "https://example.test/r",
            })
        );
    }

    #[test]
    fn update_state_roundtrips_through_json() {
        let states = [
            UpdateState::Idle,
            UpdateState::Checking,
            UpdateState::NotAvailable,
            UpdateState::Available {
                version: "0.2.0".into(),
                notes: Some(String::new()),
                url: None,
            },
            UpdateState::Downloading { percent: 1.0 },
            UpdateState::Error {
                message: "网络请求失败".into(),
            },
        ];
        for state in states {
            let text = serde_json::to_string(&state).unwrap();
            assert_eq!(serde_json::from_str::<UpdateState>(&text).unwrap(), state);
        }
    }

    #[test]
    fn store_starts_idle_and_keeps_the_last_state() {
        let store = UpdateStateStore::new("0.1.0");
        assert_eq!(store.app_version(), "0.1.0");
        assert_eq!(store.get(), UpdateState::Idle);
        let written = store.set(UpdateState::Checking);
        assert_eq!(written, UpdateState::Checking);
        assert_eq!(store.get(), UpdateState::Checking);
    }

    #[test]
    fn fetch_latest_release_sends_the_1x_headers() {
        let http = ScriptedHttp::new().push(
            200,
            r#"{"tag_name":"v0.2.0","html_url":"https://example.test/r","body":"notes"}"#,
        );
        let release = fetch_latest_release(&http).unwrap();
        assert_eq!(release.tag_name, "v0.2.0");
        assert_eq!(release.html_url.as_deref(), Some("https://example.test/r"));
        assert_eq!(release.body.as_deref(), Some("notes"));

        let request = &http.calls.lock().unwrap()[0];
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.url,
            "https://api.github.com/repos/Kide-Lee/HQ-SciFi/releases/latest"
        );
        assert_eq!(request.headers["Accept"], "application/vnd.github+json");
        assert_eq!(request.headers["User-Agent"], USER_AGENT);
    }

    #[test]
    fn fetch_latest_release_reports_the_http_status() {
        let http = ScriptedHttp::new().push(404, r#"{"message":"Not Found"}"#);
        let err = fetch_latest_release(&http).unwrap_err();
        assert_eq!(err.to_string(), "GitHub 请求失败（HTTP 404）");
    }

    #[test]
    fn fetch_latest_release_reports_non_json() {
        let http = ScriptedHttp::new().push(200, "not json");
        let err = fetch_latest_release(&http).unwrap_err();
        assert_eq!(err.to_string(), "接口返回非 JSON（HTTP 200）: not json");
    }

    #[test]
    fn auto_check_is_disabled_on_linux_without_appimage() {
        // 1.x：设置关闭 → 不检查；Linux 且非 AppImage → 不检查；其余平台/AppImage → 检查。
        assert!(!auto_check_enabled(false, "win32", false));
        assert!(!auto_check_enabled(false, "linux", true));
        assert!(!auto_check_enabled(true, "linux", false));
        assert!(auto_check_enabled(true, "linux", true));
        assert!(auto_check_enabled(true, "win32", false));
        assert!(auto_check_enabled(true, "darwin", false));
    }
}
