//! 测试替身：内核的所有端口在这里都有假实现。
//!
//! 迁移 plan 的每条 lane 都用它写测试，禁止在单元测试里碰真实文件系统/网络/钥匙串。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::ports::{
    AppPaths, Clock, DirEntry, EventSink, FileMeta, FileStore, HttpRequest, HttpResponse,
    HttpTransport, SecretStore,
};
use crate::{CoreError, CoreResult};

/// 内存文件系统。
#[derive(Default)]
pub struct MemFiles {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
    dirs: Mutex<HashMap<PathBuf, ()>>,
}

impl MemFiles {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_file(self, path: impl Into<PathBuf>, data: impl Into<Vec<u8>>) -> Self {
        let p = path.into();
        {
            // 像真实文件系统一样把祖先目录登记出来，`list`/`exists` 才能看到它们。
            let mut dirs = self.dirs.lock().unwrap();
            let mut cur = p.parent();
            while let Some(d) = cur {
                dirs.insert(d.to_path_buf(), ());
                cur = d.parent();
            }
        }
        self.files.lock().unwrap().insert(p, data.into());
        self
    }

    pub fn snapshot(&self) -> HashMap<PathBuf, Vec<u8>> {
        self.files.lock().unwrap().clone()
    }
}

fn missing(path: &Path) -> CoreError {
    crate::ports::io_not_found(path)
}

impl FileStore for MemFiles {
    fn read(&self, path: &Path) -> CoreResult<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| missing(path))
    }

    fn write(&self, path: &Path, data: &[u8]) -> CoreResult<()> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), data.to_vec());
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> CoreResult<()> {
        self.files
            .lock()
            .unwrap()
            .remove(path)
            .map(|_| ())
            .ok_or_else(|| missing(path))
    }

    fn remove_dir_all(&self, path: &Path) -> CoreResult<()> {
        let mut files = self.files.lock().unwrap();
        files.retain(|p, _| !p.starts_with(path));
        self.dirs.lock().unwrap().remove(path);
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> CoreResult<()> {
        let mut files = self.files.lock().unwrap();
        let data = files.remove(from).ok_or_else(|| missing(from))?;
        files.insert(to.to_path_buf(), data);
        Ok(())
    }

    fn create_dir_all(&self, path: &Path) -> CoreResult<()> {
        self.dirs.lock().unwrap().insert(path.to_path_buf(), ());
        Ok(())
    }

    fn list(&self, dir: &Path) -> CoreResult<Vec<DirEntry>> {
        let files = self.files.lock().unwrap();
        let mut out = Vec::new();
        for (path, data) in files.iter() {
            if path.parent() == Some(dir) {
                out.push(DirEntry {
                    name: path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: path.clone(),
                    is_dir: false,
                    size: data.len() as u64,
                    modified_ms: 0,
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    fn exists(&self, path: &Path) -> bool {
        self.files.lock().unwrap().contains_key(path)
            || self.dirs.lock().unwrap().contains_key(path)
    }

    fn metadata(&self, path: &Path) -> CoreResult<FileMeta> {
        let files = self.files.lock().unwrap();
        if let Some(data) = files.get(path) {
            return Ok(FileMeta {
                is_dir: false,
                size: data.len() as u64,
                modified_ms: 0,
            });
        }
        if self.dirs.lock().unwrap().contains_key(path) {
            return Ok(FileMeta {
                is_dir: true,
                size: 0,
                modified_ms: 0,
            });
        }
        Err(missing(path))
    }
}

/// 内存凭据存储（模拟钥匙串）。
#[derive(Default)]
pub struct MemSecrets {
    map: Mutex<HashMap<String, String>>,
}

impl MemSecrets {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemSecrets {
    fn get(&self, key: &str) -> CoreResult<Option<String>> {
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> CoreResult<()> {
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> CoreResult<()> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

/// 脚本化的 HTTP：按顺序吐出预设响应，并记录收到的请求。
#[derive(Default)]
pub struct ScriptedHttp {
    responses: Mutex<VecDeque<HttpResponse>>,
    pub calls: Mutex<Vec<HttpRequest>>,
}

impl ScriptedHttp {
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加一个预设响应（`&self` 版，`Harness` 里用；`push` 保持 builder 语义不变）。
    pub fn enqueue(&self, status: u16, body: impl Into<String>) {
        self.responses.lock().unwrap().push_back(HttpResponse {
            status,
            headers: BTreeMap::new(),
            body: body.into().into_bytes(),
        });
    }

    pub fn push(self, status: u16, body: impl Into<String>) -> Self {
        self.responses.lock().unwrap().push_back(HttpResponse {
            status,
            headers: BTreeMap::new(),
            body: body.into().into_bytes(),
        });
        self
    }
}

impl HttpTransport for ScriptedHttp {
    fn send(&self, req: HttpRequest) -> CoreResult<HttpResponse> {
        self.calls.lock().unwrap().push(req);
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| CoreError::app("ScriptedHttp: 没有预设响应了"))
    }
}

/// 记录事件的 sink。
#[derive(Default)]
pub struct RecordingEvents {
    pub emitted: Mutex<Vec<(String, serde_json::Value)>>,
}

impl RecordingEvents {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last(&self) -> Option<(String, serde_json::Value)> {
        self.emitted.lock().unwrap().last().cloned()
    }
}

impl EventSink for RecordingEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.emitted
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }
}

/// 固定时钟。
pub struct FixedClock(pub i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

// ---------- 平台端口的假实现 ----------

/// 记录写入的剪贴板；读取可预设内容。
#[derive(Default)]
pub struct MemClipboard {
    pub text: Mutex<String>,
    pub html: Mutex<String>,
    pub written: Mutex<Vec<String>>,
}

impl MemClipboard {
    pub fn new() -> Self {
        Self::default()
    }
}

impl crate::ports::Clipboard for MemClipboard {
    fn read_text(&self) -> CoreResult<String> {
        Ok(self.text.lock().unwrap().clone())
    }
    fn read_html(&self) -> CoreResult<String> {
        Ok(self.html.lock().unwrap().clone())
    }
    fn write_text(&self, text: &str) -> CoreResult<()> {
        self.written.lock().unwrap().push(text.to_string());
        *self.text.lock().unwrap() = text.to_string();
        Ok(())
    }
}

/// 对话框假实现：预设「选中的路径」，并记录弹出的消息。
#[derive(Default)]
pub struct ScriptedDialog {
    pub picked_dir: Mutex<Option<PathBuf>>,
    pub picked_image: Mutex<Option<PathBuf>>,
    pub messages: Mutex<Vec<(crate::ports::MessageKind, String, String)>>,
    pub message_box_response: Mutex<i32>,
    pub message_boxes: Mutex<Vec<crate::ports::MessageBoxOptions>>,
}

impl ScriptedDialog {
    pub fn new() -> Self {
        Self::default()
    }
}

impl crate::ports::Dialog for ScriptedDialog {
    fn pick_directory(
        &self,
        _title: &str,
        _default_path: Option<&std::path::Path>,
    ) -> CoreResult<Option<PathBuf>> {
        Ok(self.picked_dir.lock().unwrap().clone())
    }
    fn pick_image(&self, _title: &str) -> CoreResult<Option<PathBuf>> {
        Ok(self.picked_image.lock().unwrap().clone())
    }
    fn show_message(&self, kind: crate::ports::MessageKind, title: &str, message: &str) {
        self.messages
            .lock()
            .unwrap()
            .push((kind, title.to_string(), message.to_string()));
    }
    fn show_message_box(&self, options: &crate::ports::MessageBoxOptions) -> CoreResult<i32> {
        self.message_boxes.lock().unwrap().push(options.clone());
        Ok(*self.message_box_response.lock().unwrap())
    }
}

/// 外部程序假实现：只记录调用（测试断言「有没有真的想去开浏览器」）。
#[derive(Default)]
pub struct RecordingLauncher {
    pub opened: Mutex<Vec<String>>,
    pub revealed: Mutex<Vec<PathBuf>>,
    pub opened_paths: Mutex<Vec<PathBuf>>,
    pub trashed: Mutex<Vec<PathBuf>>,
}

impl RecordingLauncher {
    pub fn new() -> Self {
        Self::default()
    }
}

impl crate::ports::Launcher for RecordingLauncher {
    fn open_external(&self, url: &str) -> CoreResult<()> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn reveal_in_folder(&self, path: &std::path::Path) -> CoreResult<()> {
        self.revealed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
    fn open_path(&self, path: &std::path::Path) -> CoreResult<()> {
        self.opened_paths.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
    fn trash(&self, path: &std::path::Path) -> CoreResult<()> {
        self.trashed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

/// 窗口假实现：记录缩放/CSS/JS 调用，最大化状态可切换。
#[derive(Default)]
pub struct FakeWindow {
    pub zoom: Mutex<Vec<f64>>,
    pub css: Mutex<Vec<String>>,
    pub removed_css: Mutex<Vec<String>>,
    pub js: Mutex<Vec<String>>,
    pub maximized: Mutex<bool>,
    pub minimized: Mutex<u32>,
    pub closed: Mutex<u32>,
    pub devtools: Mutex<u32>,
}

impl FakeWindow {
    pub fn new() -> Self {
        Self::default()
    }
}

impl crate::ports::WindowOps for FakeWindow {
    fn minimize(&self) {
        *self.minimized.lock().unwrap() += 1;
    }
    fn toggle_maximize(&self) -> CoreResult<bool> {
        let mut m = self.maximized.lock().unwrap();
        *m = !*m;
        Ok(*m)
    }
    fn close(&self) {
        *self.closed.lock().unwrap() += 1;
    }
    fn is_maximized(&self) -> bool {
        *self.maximized.lock().unwrap()
    }
    fn toggle_devtools(&self) {
        *self.devtools.lock().unwrap() += 1;
    }
    fn set_zoom(&self, factor: f64) -> CoreResult<()> {
        self.zoom.lock().unwrap().push(factor);
        Ok(())
    }
    fn insert_css(&self, css: &str) -> CoreResult<String> {
        if css.is_empty() {
            return Ok(String::new());
        }
        let key = format!("css-{}", self.css.lock().unwrap().len() + 1);
        self.css.lock().unwrap().push(css.to_string());
        Ok(key)
    }
    fn remove_css(&self, key: &str) {
        self.removed_css.lock().unwrap().push(key.to_string());
    }
    fn execute_js(&self, js: &str) -> CoreResult<()> {
        self.js.lock().unwrap().push(js.to_string());
        Ok(())
    }
}

/// 内存库（每个测试一份，互不干扰）。
pub fn db() -> Arc<crate::infra::db::Db> {
    Arc::new(crate::infra::db::Db::open_in_memory().expect("内存库打开失败"))
}

/// 组装一套全假的平台端口。
pub fn platform() -> crate::ports::Platform {
    crate::ports::Platform {
        clipboard: Arc::new(MemClipboard::new()),
        dialog: Arc::new(ScriptedDialog::new()),
        launcher: Arc::new(RecordingLauncher::new()),
        window: Arc::new(FakeWindow::new()),
    }
}

/// 组装一个全内存的 `CoreCtx`，测试直接用。
pub fn ctx() -> Arc<crate::CoreCtx> {
    Arc::new(crate::CoreCtx::new(
        Arc::new(MemFiles::new()),
        Arc::new(MemSecrets::new()),
        Arc::new(ScriptedHttp::new()),
        Arc::new(RecordingEvents::new()),
        Arc::new(FixedClock(1_700_000_000_000)),
        AppPaths {
            data_dir: PathBuf::from("/data"),
            resource_dir: PathBuf::from("/resources"),
            documents_dir: PathBuf::from("/documents"),
            test_mode: false,
        },
        db(),
        platform(),
    ))
}

/// 一份**能通过 `validate`** 的测试用 API 配置（39 个必需接口齐全）。
///
/// 各 lane 的测试要打接口时，用 `Harness::new().with_api_config()`，
/// 或直接把这个字符串写进 `MemFiles` 的 `resource_dir/api.config.json`。
pub fn api_config_json() -> String {
    let endpoints = crate::infra::net::config::REQUIRED_ENDPOINTS
        .iter()
        .map(|(name, _desc)| {
            format!(
                "\"{name}\":{{\"path\":\"/api/{}\",\"method\":\"GET\"}}",
                name.to_lowercase()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"baseUrl\":\"https://api.hqsf.test/\",\"endpoints\":{{{endpoints}}}}}")
}

/// 把测试用 API 配置写进 `ctx.paths.resource_dir`（内核默认的第一候选路径）。
pub fn install_api_config(ctx: &crate::CoreCtx) {
    let path = ctx.paths.resource_dir.join("api.config.json");
    ctx.files
        .write(&path, api_config_json().as_bytes())
        .expect("写入测试用 api.config.json 失败");
}

/// 测试装配台：一次性拿到 `CoreCtx` 与所有假端口，方便断言「发了什么请求 / 弹了什么框」。
///
/// ```ignore
/// let h = Harness::new().with_api_config();
/// h.http.push_json(r#"{"code":1,"msg":"","data":{"uid":7}}"#);
/// let out = get_user_profile(h.ctx(), 7).unwrap();
/// assert!(h.last_request().url.contains("uid=7"));
/// ```
pub struct Harness {
    pub ctx: Arc<crate::CoreCtx>,
    pub files: Arc<MemFiles>,
    pub secrets: Arc<MemSecrets>,
    pub http: Arc<ScriptedHttp>,
    pub events: Arc<RecordingEvents>,
    pub clipboard: Arc<MemClipboard>,
    pub dialog: Arc<ScriptedDialog>,
    pub launcher: Arc<RecordingLauncher>,
    pub window: Arc<FakeWindow>,
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Harness {
    pub fn new() -> Self {
        let files = Arc::new(MemFiles::new());
        let secrets = Arc::new(MemSecrets::new());
        let http = Arc::new(ScriptedHttp::new());
        let events = Arc::new(RecordingEvents::new());
        let clipboard = Arc::new(MemClipboard::new());
        let dialog = Arc::new(ScriptedDialog::new());
        let launcher = Arc::new(RecordingLauncher::new());
        let window = Arc::new(FakeWindow::new());

        let platform = crate::ports::Platform {
            clipboard: clipboard.clone(),
            dialog: dialog.clone(),
            launcher: launcher.clone(),
            window: window.clone(),
        };

        let ctx = Arc::new(crate::CoreCtx::new(
            files.clone(),
            secrets.clone(),
            http.clone(),
            events.clone(),
            Arc::new(FixedClock(1_700_000_000_000)),
            AppPaths {
                data_dir: PathBuf::from("/data"),
                resource_dir: PathBuf::from("/resources"),
                documents_dir: PathBuf::from("/documents"),
                test_mode: false,
            },
            db(),
            platform,
        ));

        Self {
            ctx,
            files,
            secrets,
            http,
            events,
            clipboard,
            dialog,
            launcher,
            window,
        }
    }

    /// 装好一份合法的 API 配置。
    pub fn with_api_config(self) -> Self {
        install_api_config(&self.ctx);
        self
    }

    pub fn ctx(&self) -> &crate::CoreCtx {
        &self.ctx
    }

    /// 预置会话（token 存 `SecretStore` 的 `hqsf.session`，值为 JSON）。
    pub fn with_token(self, token: &str) -> Self {
        self.secrets
            .set(
                crate::services::net::SESSION_SECRET_KEY,
                &serde_json::json!({ "token": token, "savedAt": 1_700_000_000_000_i64 })
                    .to_string(),
            )
            .unwrap();
        self
    }

    /// 最后收到的 HTTP 请求。
    pub fn last_request(&self) -> HttpRequest {
        self.http
            .calls
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("还没有发出任何请求")
    }

    /// 已发出的全部 HTTP 请求。
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.http.calls.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_files_behave_like_a_file_store() {
        let fs = MemFiles::new();
        fs.create_dir_all(Path::new("/data/docs")).unwrap();
        fs.write(Path::new("/data/docs/a.md"), b"hello").unwrap();
        assert!(fs.exists(Path::new("/data/docs/a.md")));
        assert_eq!(fs.read(Path::new("/data/docs/a.md")).unwrap(), b"hello");
        assert!(!fs.exists(Path::new("/data/docs/missing.md")));
        assert_eq!(
            fs.read(Path::new("/data/docs/missing.md"))
                .unwrap_err()
                .code(),
            "not_found"
        );

        let listed = fs.list(Path::new("/data/docs")).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "a.md");

        fs.rename(Path::new("/data/docs/a.md"), Path::new("/data/docs/b.md"))
            .unwrap();
        assert!(!fs.exists(Path::new("/data/docs/a.md")));
        assert!(fs.exists(Path::new("/data/docs/b.md")));

        fs.remove_file(Path::new("/data/docs/b.md")).unwrap();
        assert!(!fs.exists(Path::new("/data/docs/b.md")));
    }

    #[test]
    fn scripted_http_records_requests_in_order() {
        let http = ScriptedHttp::new().push(200, r#"{"ok":true}"#);
        let resp = http
            .send(HttpRequest {
                method: "GET".into(),
                url: "https://example.test/x".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(resp.status, 200);
        assert!(resp.is_success());
        assert_eq!(http.calls.lock().unwrap().len(), 1);
        // 没有预设后应报错，避免测试静默通过
        assert!(http.send(HttpRequest::default()).is_err());
    }

    #[test]
    fn secrets_roundtrip() {
        let s = MemSecrets::new();
        assert!(s.get("token").unwrap().is_none());
        s.set("token", "abc").unwrap();
        assert_eq!(s.get("token").unwrap().as_deref(), Some("abc"));
        s.delete("token").unwrap();
        assert!(s.get("token").unwrap().is_none());
    }

    #[test]
    fn events_are_recorded() {
        let ev = RecordingEvents::new();
        ev.emit("hqsf:update-state", serde_json::json!({"state":"idle"}));
        let (name, payload) = ev.last().unwrap();
        assert_eq!(name, "hqsf:update-state");
        assert_eq!(payload["state"], "idle");
    }
}
