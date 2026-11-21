//! 图片本地缓存：1.x `src/main/infra/media/imgcache.ts` 的内核对等实现。
//!
//! 渲染层 `<img>` 的 src 换成 `hqsf-img://fetch?url=<encodeURIComponent(远端图)>`，
//! 壳层协议 handler 调 [`MediaCache::get`]：首次下载并落盘到 `data_dir/cache/images/`，
//! 之后直接读本地文件——离线可用 + 减少重复下载。文件名 = `sha1(url)`，天然去重。
//! 下载时把 Content-Type 写进 `<sha1>.meta`，后续命中照常返回。
//!
//! 缓存不限时（离线可用），只有总量上限（16MB）：1.x 用磁盘文件 mtime 当「最后使用
//! 时间」（命中即 touch），超限按最后使用时间从旧到新删。
//!
//! 性能优化（与 1.x 一一对应）：
//! - 内存 LRU（上限 8MB）：重复访问同一图直接返回；
//! - in-flight 去重：同一 URL 并发请求只下载一次，其余等同一结果；
//! - 走 [`FileStore`](crate::ports::FileStore) 端口，不直接碰 `std::fs`。
//!
//! 与 1.x 的**有意偏差**（内核端口能力所限，见文件尾测试与迁移报告）：
//! - `FileStore` 没有 `utimes`，无法真的刷新磁盘 mtime；磁盘 LRU 时间用进程内
//!   `touch` 表记录（`imgcache.ts:203-212` 的 `utimes` 无法逐字复刻）。
//! - 唯一下载入口 `services::net::download_image` 只返回字节、不返回响应头，所以
//!   `.meta` 里的 Content-Type 固定为 `application/octet-stream`（1.x 取响应头，
//!   `imgcache.ts:182`）；下载失败的文案沿用 `download_image` 的「图片下载失败
//!   （HTTP n）」，而不是 1.x 的 `fetch failed: n`（`imgcache.ts:177`）。
//!
//! [`FileStore`]: crate::ports::FileStore

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::{CoreCtx, CoreError, CoreResult};

/// 缓存根目录（相对 `data_dir`），1.x `CACHE_ROOT`。
const CACHE_ROOT: &str = "cache/images";
/// 单图最大缓存字节（10MB，防超大图刷盘），1.x `MAX_IMAGE_BYTES`。
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// 图片缓存总容量上限（16MB），1.x `CACHE_MAX_BYTES`。
const CACHE_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// 清理目标水位（上限的 80%，避免频繁清理），1.x `CACHE_TARGET_BYTES`。
const CACHE_TARGET_BYTES: u64 = CACHE_MAX_BYTES * 4 / 5;
/// 内存缓存上限（8MB）：LRU 淘汰最久未用，1.x `MEM_MAX_BYTES`。
const MEM_MAX_BYTES: usize = 8 * 1024 * 1024;
/// `.tmp` 下载临时文件保留时长（1 小时），1.x `TMP_MAX_AGE_MS`。
const TMP_MAX_AGE_MS: i64 = 60 * 60 * 1000;
/// touch 节流（5 分钟），1.x `TOUCH_INTERVAL_MS`。
const TOUCH_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// `.meta` 缺省 Content-Type（与 1.x `readContentType` 的兜底一致）。
const DEFAULT_CONTENT_TYPE: &str = "application/octet-stream";

/// 图片缓存的可观测状态（给命令层/诊断用；1.x 没有，是内核新增。）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MediaCacheStats {
    /// 内存缓存占用字节数。
    pub memory_bytes: usize,
    /// 内存缓存条目数。
    pub memory_entries: usize,
    /// 内存命中次数。
    pub memory_hits: u64,
    /// 磁盘命中次数。
    pub disk_hits: u64,
    /// 实际下载次数。
    pub downloads: u64,
    /// 因 in-flight 去重而等待其他线程下载的次数。
    pub inflight_waits: u64,
    /// 全量扫描清理次数。
    pub sweeps: u64,
}

/// 内存缓存条目。
struct MemEntry {
    bytes: Arc<[u8]>,
    ct: String,
    /// 最后使用时间（毫秒），用于 LRU 排序。
    last_used: i64,
    /// 单调序号：同毫秒内的多次访问靠它定序（`Date.now()` 会并列）。
    seq: u64,
}

#[derive(Default)]
struct MemState {
    entries: HashMap<String, MemEntry>,
    bytes: usize,
}

#[derive(Default)]
struct Counters {
    memory_hits: u64,
    disk_hits: u64,
    downloads: u64,
    inflight_waits: u64,
    sweeps: u64,
}

/// 一次取图的结果：图片字节 + Content-Type。
type CacheEntry = (Arc<[u8]>, String);
/// leader 的最终结果；`Err` 里放已格式化好的文案（跨线程共享用 String）。
type PendingResult = Result<CacheEntry, String>;

/// 一次 in-flight 下载的会合点：leader 完成后写入结果并唤醒所有 follower。
struct Pending {
    result: Mutex<Option<PendingResult>>,
    ready: Condvar,
}

/// 图片缓存（1.x `imgcache.ts` 的模块级状态）。
///
/// 与 1.x 一样是进程级单例语义：`MediaCache::new()` 后由壳层/命令层持有；
/// 内部全部 `Mutex`/原子量，`&self` 可并发调用。
#[derive(Default)]
pub struct MediaCache {
    mem: Mutex<MemState>,
    /// hash → 正在进行的下载（同一 URL 并发只下载一次）。
    inflight: Mutex<HashMap<String, Arc<Pending>>>,
    /// hash → 最后使用时间（毫秒）。代替 1.x 的 `utimes`（端口没有该能力）。
    touch: Mutex<HashMap<String, i64>>,
    counters: Mutex<Counters>,
    /// 内存 LRU 的同毫秒定序。
    seq: AtomicU64,
    /// 全量扫描清理的并发节流（1.x `sweepRunning`）。
    sweep_running: AtomicBool,
}

impl MediaCache {
    /// 新建一个空缓存（1.x 的模块级状态在首次使用时惰性初始化）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 取图：内存缓存 → in-flight 去重 → 磁盘 → 下载（1.x `resolveImage`）。
    ///
    /// 返回 `Arc<[u8]>`，命中缓存时零拷贝共享。
    pub fn get(&self, ctx: &CoreCtx, url: &str) -> CoreResult<Arc<[u8]>> {
        self.get_with_content_type(ctx, url).map(|(bytes, _)| bytes)
    }

    /// 取图并返回 Content-Type（壳层 `hqsf-img://` 协议 handler 需要写响应头）。
    pub fn get_with_content_type(
        &self,
        ctx: &CoreCtx,
        url: &str,
    ) -> CoreResult<(Arc<[u8]>, String)> {
        let hash = sha1_hex(url.as_bytes());
        let dir = images_dir(ctx);
        let file = dir.join(&hash);
        let now = ctx.clock.now_ms();

        // 1. 内存缓存（LRU）。
        if let Some((bytes, ct)) = self.mem_get(&hash, now) {
            self.touch(&hash, now);
            self.bump(|c| c.memory_hits += 1);
            return Ok((bytes, ct));
        }

        // 2. in-flight 去重：同一 URL 并发只下载一次，其余等同一结果。
        let (pending, leader) = {
            let mut inflight = lock(&self.inflight);
            match inflight.get(&hash) {
                Some(existing) => (Arc::clone(existing), false),
                None => {
                    let fresh = Arc::new(Pending {
                        result: Mutex::new(None),
                        ready: Condvar::new(),
                    });
                    inflight.insert(hash.clone(), Arc::clone(&fresh));
                    (fresh, true)
                }
            }
        };

        if !leader {
            return self.wait_for_pending(&pending);
        }

        // 3./4. leader：磁盘命中或下载。
        let result = self.load_or_download(ctx, url, &file, &dir, &hash, now);

        // 先发布结果再摘掉 inflight：follower 拿到的一定是完整结果。
        {
            let mut slot = lock(&pending.result);
            *slot = Some(result.clone());
            pending.ready.notify_all();
        }
        {
            let mut inflight = lock(&self.inflight);
            if inflight
                .get(&hash)
                .is_some_and(|current| Arc::ptr_eq(current, &pending))
            {
                inflight.remove(&hash);
            }
        }

        result.map_err(CoreError::App)
    }

    /// 等待 leader 的结果（in-flight 去重的 follower 路径）。
    fn wait_for_pending(&self, pending: &Pending) -> CoreResult<(Arc<[u8]>, String)> {
        self.bump(|c| c.inflight_waits += 1);
        let mut slot = lock(&pending.result);
        loop {
            if let Some(value) = slot.as_ref() {
                return value.clone().map_err(CoreError::App);
            }
            slot = pending
                .ready
                .wait(slot)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// 磁盘命中则读盘，否则下载（1.x `resolveImage` 的步骤 3/4）。
    fn load_or_download(
        &self,
        ctx: &CoreCtx,
        url: &str,
        file: &Path,
        dir: &Path,
        hash: &str,
        now: i64,
    ) -> Result<(Arc<[u8]>, String), String> {
        if let Ok(bytes) = ctx.files.read(file) {
            let ct = read_content_type(ctx, file);
            self.touch(hash, now);
            let shared: Arc<[u8]> = Arc::from(bytes);
            self.mem_insert(hash, Arc::clone(&shared), ct.clone(), now);
            self.bump(|c| c.disk_hits += 1);
            return Ok((shared, ct));
        }

        let downloaded =
            crate::services::net::download_image(ctx, url).map_err(|e| e.to_string())?;
        if downloaded.len() > MAX_IMAGE_BYTES {
            // 1.x `imgcache.ts:179`：单图超限直接失败，不落盘。
            return Err("image too large".to_string());
        }

        let ct = DEFAULT_CONTENT_TYPE.to_string();
        let shared: Arc<[u8]> = Arc::from(downloaded);
        // 落盘失败不阻断本次返回（1.x 的 writeFile 失败会让 resolveImage 抛错，
        // 但图片已经在内存里；这里选择更宽松的「返回可用结果」并在下次重试）。
        let _ = ctx.files.create_dir_all(dir);
        let tmp = tmp_path(file);
        if ctx.files.write(&tmp, &shared).is_ok() {
            // 目标已存在（并发写入）时 rename 失败，保留 tmp 交给 sweep 清理。
            let _ = ctx.files.rename(&tmp, file);
        }
        let _ = ctx.files.write(&meta_path(file), meta_json(&ct).as_bytes());

        self.mem_insert(hash, Arc::clone(&shared), ct.clone(), now);
        self.touch(hash, now);
        self.bump(|c| c.downloads += 1);
        // 1.x 落盘后异步 `void sweepCache(dir)`；内核同步跑一次（尽力而为，忽略错误）。
        self.sweep(ctx);
        Ok((shared, ct))
    }

    /// 命中内存缓存并推进 LRU 次序（1.x `memGet`）。
    fn mem_get(&self, hash: &str, now: i64) -> Option<(Arc<[u8]>, String)> {
        let seq = self.next_seq();
        let mut mem = lock(&self.mem);
        let entry = mem.entries.get_mut(hash)?;
        entry.last_used = now;
        entry.seq = seq;
        Some((Arc::clone(&entry.bytes), entry.ct.clone()))
    }

    /// 写入内存缓存；超出 8MB 时淘汰最久未用（不淘汰刚插入的这条）。
    fn mem_insert(&self, hash: &str, bytes: Arc<[u8]>, ct: String, now: i64) {
        let seq = self.next_seq();
        let mut mem = lock(&self.mem);
        if let Some(prev) = mem.entries.remove(hash) {
            mem.bytes = mem.bytes.saturating_sub(prev.bytes.len());
        }
        mem.bytes += bytes.len();
        mem.entries.insert(
            hash.to_string(),
            MemEntry {
                bytes,
                ct,
                last_used: now,
                seq,
            },
        );
        while mem.bytes > MEM_MAX_BYTES && mem.entries.len() > 1 {
            let oldest = mem
                .entries
                .iter()
                .filter(|(key, _)| key.as_str() != hash)
                .min_by_key(|(_, entry)| (entry.last_used, entry.seq))
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else { break };
            if let Some(entry) = mem.entries.remove(&oldest) {
                mem.bytes = mem.bytes.saturating_sub(entry.bytes.len());
            }
        }
    }

    /// 记录「最后使用时间」（节流），作为磁盘容量 LRU 的排序依据。
    fn touch(&self, hash: &str, now: i64) {
        let mut touch = lock(&self.touch);
        if let Some(prev) = touch.get(hash)
            && now.saturating_sub(*prev) < TOUCH_INTERVAL_MS
        {
            return;
        }
        touch.insert(hash.to_string(), now);
    }

    /// 清空缓存目录并释放内存缓存，返回**磁盘释放字节数**（1.x `clearImageCache`）。
    ///
    /// 给「清除缓存」命令用：1.x 的 `freed_bytes` 只统计磁盘占用。
    pub fn clear_all(&self, ctx: &CoreCtx) -> u64 {
        let dir = images_dir(ctx);
        // 删除前统计大小（1.x 同样尽力而为：读失败按 0 处理）。
        let mut freed = 0_u64;
        if let Ok(entries) = ctx.files.list(&dir) {
            for entry in entries {
                if !entry.is_dir {
                    freed = freed.saturating_add(entry.size);
                }
            }
        }
        let _ = ctx.files.remove_dir_all(&dir);
        self.clear_memory();
        freed
    }

    /// 只清内存缓存，返回释放的内存字节数。
    ///
    /// 1.x 的「清除缓存」是 [`Self::clear_all`]；这个入口给「只想腾内存」的调用方。
    pub fn clear(&self) -> u64 {
        self.clear_memory()
    }

    fn clear_memory(&self) -> u64 {
        let mut mem = lock(&self.mem);
        let freed = mem.bytes as u64;
        mem.entries.clear();
        mem.bytes = 0;
        lock(&self.touch).clear();
        freed
    }

    /// 当前缓存状态快照。
    pub fn stats(&self) -> MediaCacheStats {
        let mem = lock(&self.mem);
        let counters = lock(&self.counters);
        MediaCacheStats {
            memory_bytes: mem.bytes,
            memory_entries: mem.entries.len(),
            memory_hits: counters.memory_hits,
            disk_hits: counters.disk_hits,
            downloads: counters.downloads,
            inflight_waits: counters.inflight_waits,
            sweeps: counters.sweeps,
        }
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    fn bump(&self, f: impl FnOnce(&mut Counters)) {
        f(&mut lock(&self.counters));
    }

    /// 容量清理：超限时按「最后使用时间」从旧到新删到目标水位（1.x `sweepCache`）。
    fn sweep(&self, ctx: &CoreCtx) {
        if self.sweep_running.swap(true, Ordering::AcqRel) {
            return;
        }
        self.sweep_inner(ctx);
        self.sweep_running.store(false, Ordering::Release);
        self.bump(|c| c.sweeps += 1);
    }

    fn sweep_inner(&self, ctx: &CoreCtx) {
        let dir = images_dir(ctx);
        let Ok(entries) = ctx.files.list(&dir) else {
            return;
        };
        let now = ctx.clock.now_ms();
        let mut total = 0_u64;
        let mut images: Vec<(String, PathBuf, u64, i64)> = Vec::new();
        let mut on_disk = std::collections::HashSet::new();
        for entry in entries {
            if entry.is_dir {
                continue;
            }
            let name = entry.name.clone();
            if name.ends_with(".meta") {
                continue;
            }
            if name.ends_with(".tmp") {
                // 超时的 .tmp 残留直接删（正常下载中的 .tmp 年龄远小于 1 小时）。
                if entry.modified_ms > 0 && now.saturating_sub(entry.modified_ms) > TMP_MAX_AGE_MS {
                    let _ = ctx.files.remove_file(&entry.path);
                }
                continue;
            }
            on_disk.insert(name.clone());
            total = total.saturating_add(entry.size);
            let last_used = lock(&self.touch)
                .get(&name)
                .copied()
                .unwrap_or(entry.modified_ms);
            images.push((name, entry.path, entry.size, last_used));
        }
        // touch 表里已不在磁盘的条目（文件被删或从未落盘）清出去。
        lock(&self.touch).retain(|key, _| on_disk.contains(key));

        images.sort_by_key(|(_, _, _, last_used)| *last_used);
        for (name, path, size, _) in images {
            if total <= CACHE_TARGET_BYTES {
                break;
            }
            if ctx.files.remove_file(&path).is_ok() {
                let _ = ctx.files.remove_file(&meta_path(&path));
                total = total.saturating_sub(size);
                lock(&self.touch).remove(&name);
            }
        }
    }
}

/// 进程级共享缓存（1.x 的 `imgcache.ts` 模块级状态等价物）。
///
/// 壳层协议 handler、`clear-cache` 命令与后续的媒体命令都应取这一份，
/// 否则内存 LRU 与 in-flight 去重会被拆成多份、失去意义。
pub fn shared() -> &'static MediaCache {
    static CACHE: std::sync::OnceLock<MediaCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(MediaCache::new)
}

/// 「清除缓存」用：清空共享缓存的磁盘目录 + 内存缓存，返回释放的磁盘字节数。
///
/// 等价 1.x `clearImageCache()`（`imgcache.ts:246-278`）。`services::settings::clear_cache`
/// 里的 `TODO(media-cache)` 接这个函数即可（该文件不属于本 lane 的写权限）。
pub fn clear_image_cache(ctx: &CoreCtx) -> u64 {
    shared().clear_all(ctx)
}

/// 图片缓存目录（`<data_dir>/cache/images`）。
pub fn images_dir(ctx: &CoreCtx) -> PathBuf {
    let mut dir = ctx.paths.data_dir.clone();
    for part in CACHE_ROOT.split('/') {
        dir.push(part);
    }
    dir
}

fn meta_path(file: &Path) -> PathBuf {
    let mut raw = file.as_os_str().to_os_string();
    raw.push(".meta");
    PathBuf::from(raw)
}

fn tmp_path(file: &Path) -> PathBuf {
    let mut raw = file.as_os_str().to_os_string();
    raw.push(".tmp");
    PathBuf::from(raw)
}

fn meta_json(ct: &str) -> String {
    serde_json::json!({ "ct": ct }).to_string()
}

/// 读取 `<sha1>.meta` 里的 Content-Type（缺省 octet-stream）。
fn read_content_type(ctx: &CoreCtx, file: &Path) -> String {
    let Ok(raw) = ctx.files.read(&meta_path(file)) else {
        return DEFAULT_CONTENT_TYPE.to_string();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return DEFAULT_CONTENT_TYPE.to_string();
    };
    value
        .get("ct")
        .and_then(|ct| ct.as_str())
        .filter(|ct| !ct.is_empty())
        .unwrap_or(DEFAULT_CONTENT_TYPE)
        .to_string()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // 缓存是尽力而为的旁路设施：某个线程 panic 毒化了锁，也不该让整个应用拒绝服务。
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// SHA-1（十六进制小写）。1.x 用 `crypto.createHash('sha1')` 当缓存文件名。
///
/// 本机没有 sha1 crate（workspace 只有 sha2，且不改 Cargo.toml），这里按 FIPS 180-4
/// 自实现；输出与 `sha1sum` 一致（见测试里的标准向量）。
fn sha1_hex(input: &[u8]) -> String {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);

    let mut message = Vec::with_capacity(input.len() + 72);
    message.extend_from_slice(input);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    // 消息长度已补齐到 64 的整数倍，按固定块长遍历（`chunks_exact` 会被 clippy 建议换
    // `as_chunks`，用显式下标避免引用新 API）。
    for start in (0..message.len()).step_by(64) {
        let chunk = &message[start..start + 64];
        let mut w = [0_u32; 80];
        for (i, slot) in w.iter_mut().take(16).enumerate() {
            let at = i * 4;
            *slot = u32::from_be_bytes([chunk[at], chunk[at + 1], chunk[at + 2], chunk[at + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = String::with_capacity(40);
    for word in h {
        out.push_str(&format!("{word:08x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::ports::{FileStore as _, HttpRequest, HttpResponse, HttpTransport};
    use crate::testkit::Harness;

    fn image_path(ctx: &CoreCtx, url: &str) -> PathBuf {
        images_dir(ctx).join(sha1_hex(url.as_bytes()))
    }

    #[test]
    fn sha1_hex_matches_reference_vectors() {
        // FIPS 180-4 / `sha1sum` 标准向量。
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            sha1_hex(b"The quick brown fox jumps over the lazy dog"),
            "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"
        );
    }

    #[test]
    fn downloads_then_serves_from_memory_without_second_request() {
        let h = Harness::new();
        h.http.enqueue(200, "PNGDATA");
        let cache = MediaCache::new();

        let first = cache.get(h.ctx(), "https://img.example.com/a.png").unwrap();
        assert_eq!(&*first, b"PNGDATA");
        assert_eq!(h.requests().len(), 1, "首次应真的下载一次");

        // 落盘：图片 + .meta。
        let file = image_path(h.ctx(), "https://img.example.com/a.png");
        let snapshot = h.files.snapshot();
        assert_eq!(
            snapshot.get(&file).map(Vec::as_slice),
            Some(&b"PNGDATA"[..])
        );
        assert!(snapshot.contains_key(&meta_path(&file)), "应写入 .meta");

        let second = cache.get(h.ctx(), "https://img.example.com/a.png").unwrap();
        assert_eq!(&*second, b"PNGDATA");
        assert_eq!(h.requests().len(), 1, "内存命中不应再下载");
        let stats = cache.stats();
        assert_eq!(stats.downloads, 1);
        assert_eq!(stats.memory_hits, 1);
        assert_eq!(stats.memory_bytes, b"PNGDATA".len());
    }

    #[test]
    fn disk_hit_skips_download_and_restores_content_type() {
        let h = Harness::new();
        let url = "https://img.example.com/b.png";
        let file = image_path(h.ctx(), url);
        h.files.write(&file, b"IMGDISK").unwrap();
        h.files
            .write(&meta_path(&file), meta_json("image/png").as_bytes())
            .unwrap();

        let cache = MediaCache::new();
        assert_eq!(&*cache.get(h.ctx(), url).unwrap(), b"IMGDISK");
        assert!(h.requests().is_empty(), "磁盘命中不应发请求");
        assert_eq!(cache.stats().disk_hits, 1);
        assert_eq!(
            cache.get_with_content_type(h.ctx(), url).unwrap().1,
            "image/png",
            "内存命中也要带回 .meta 里的 Content-Type"
        );
    }

    #[test]
    fn rejects_images_over_ten_megabytes() {
        let h = Harness::new();
        let big = String::from_utf8(vec![b'a'; MAX_IMAGE_BYTES + 1]).unwrap();
        h.http.enqueue(200, big);
        let cache = MediaCache::new();

        let err = cache
            .get(h.ctx(), "https://img.example.com/huge.png")
            .unwrap_err();
        assert_eq!(err.to_string(), "image too large");
        assert_eq!(cache.stats().downloads, 0, "超限不计下载成功");
        let snapshot = h.files.snapshot();
        assert!(
            !snapshot
                .keys()
                .any(|path| path.starts_with(images_dir(h.ctx()))),
            "超限图片不应落盘"
        );
    }

    #[test]
    fn propagates_download_error_text_from_net_layer() {
        let h = Harness::new();
        h.http.enqueue(404, "nope");
        let cache = MediaCache::new();
        let err = cache
            .get(h.ctx(), "https://img.example.com/missing.png")
            .unwrap_err();
        // 有意偏差：1.x 是 `fetch failed: 404`；内核唯一下载入口自带这句文案。
        assert_eq!(err.to_string(), "图片下载失败（HTTP 404）");
    }

    #[test]
    fn memory_lru_evicts_oldest_entry() {
        let h = Harness::new();
        let cache = MediaCache::new();
        // 每条 3MB，插 3 条 → 9MB > 8MB，最旧的一条被淘汰。
        for i in 0..3 {
            h.http.enqueue(200, "x".repeat(3 * 1024 * 1024));
            let url = format!("https://img.example.com/{i}.png");
            cache.get(h.ctx(), &url).unwrap();
        }
        let stats = cache.stats();
        assert_eq!(stats.memory_entries, 2, "超 8MB 应淘汰最久未用的条目");
        assert!(stats.memory_bytes <= MEM_MAX_BYTES);
    }

    #[test]
    fn clear_all_removes_disk_and_memory_and_returns_freed_bytes() {
        let h = Harness::new();
        h.http.enqueue(200, "PNGDATA");
        let cache = MediaCache::new();
        cache.get(h.ctx(), "https://img.example.com/a.png").unwrap();
        let file = image_path(h.ctx(), "https://img.example.com/a.png");
        let disk_bytes = b"PNGDATA".len() as u64 + meta_json(DEFAULT_CONTENT_TYPE).len() as u64;
        assert_eq!(cache.stats().memory_entries, 1);

        let freed = cache.clear_all(h.ctx());
        assert_eq!(freed, disk_bytes, "freed 统计图片 + .meta 的磁盘占用");
        assert!(!h.files.exists(&file));
        assert_eq!(cache.stats().memory_entries, 0);
        assert_eq!(cache.stats().memory_bytes, 0);
        assert_eq!(cache.clear_all(h.ctx()), 0, "目录已删，第二次释放 0 字节");
    }

    #[test]
    fn clear_only_drops_memory_cache() {
        let h = Harness::new();
        h.http.enqueue(200, "PNGDATA");
        let cache = MediaCache::new();
        cache.get(h.ctx(), "https://img.example.com/a.png").unwrap();
        assert_eq!(cache.clear(), b"PNGDATA".len() as u64);
        assert_eq!(cache.stats().memory_entries, 0);
        // 磁盘仍在：再取会走磁盘命中。
        cache.get(h.ctx(), "https://img.example.com/a.png").unwrap();
        assert_eq!(cache.stats().disk_hits, 1);
    }

    #[test]
    fn sweep_removes_oldest_files_until_under_target() {
        let h = Harness::new();
        let cache = MediaCache::new();
        let dir = images_dir(h.ctx());
        h.files.create_dir_all(&dir).unwrap();
        // 13 个 1.5MB 文件 = ~19.5MB，超过 16MB 上限；mock 的 modified_ms 都是 0，
        // 排序用 touch 表（先 touch 的先被删）。
        for i in 0..13 {
            let path = dir.join(format!("{i:02}.png"));
            h.files
                .write(&path, &vec![b'x'; 3 * 1024 * 1024 / 2])
                .unwrap();
            lock(&cache.touch).insert(format!("{i:02}.png"), 1_000 + i);
        }
        cache.sweep(h.ctx());
        let total: u64 = h.files.list(&dir).unwrap().iter().map(|e| e.size).sum();
        assert!(total <= CACHE_TARGET_BYTES, "清扫后应降到目标水位：{total}");
        assert!(
            !h.files.exists(&dir.join("00.png")),
            "最后使用时间最早的文件应先被删"
        );
    }

    /// 下载会阻塞的传输层：用来把 leader 卡在下载中，制造真实的并发窗口。
    struct BlockingHttp {
        calls: AtomicUsize,
        released: Mutex<bool>,
        ready: Condvar,
    }

    impl HttpTransport for BlockingHttp {
        fn send(&self, _req: HttpRequest) -> CoreResult<HttpResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut released = lock(&self.released);
            while !*released {
                released = self.ready.wait(released).unwrap_or_else(|e| e.into_inner());
            }
            Ok(HttpResponse {
                status: 200,
                headers: BTreeMap::new(),
                body: b"CONCURRENT".to_vec(),
            })
        }
    }

    #[test]
    fn shared_cache_is_a_process_singleton() {
        let h = Harness::new();
        h.http.enqueue(200, "SHARED");
        let url = "https://img.example.com/shared.png";
        let first = shared().get(h.ctx(), url).unwrap();
        let second = shared().get(h.ctx(), url).unwrap();
        assert!(Arc::ptr_eq(&first, &second), "共享缓存应返回同一份内存数据");
        let disk_bytes = b"SHARED".len() as u64 + meta_json(DEFAULT_CONTENT_TYPE).len() as u64;
        assert_eq!(
            clear_image_cache(h.ctx()),
            disk_bytes,
            "freed 只统计磁盘字节"
        );
        assert_eq!(shared().stats().memory_entries, 0);
    }

    #[test]
    fn concurrent_requests_share_one_download() {
        let h = Harness::new();
        let http = Arc::new(BlockingHttp {
            calls: AtomicUsize::new(0),
            released: Mutex::new(false),
            ready: Condvar::new(),
        });
        let ctx = CoreCtx {
            http: http.clone(),
            ..(*h.ctx).clone()
        };
        let cache = Arc::new(MediaCache::new());
        let url = "https://img.example.com/same.png";

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let ctx = ctx.clone();
                std::thread::spawn(move || cache.get(&ctx, url).map(|bytes| bytes.to_vec()))
            })
            .collect();

        // 等 follower 进入等待（leader 已卡在下载里）。
        let deadline = Instant::now() + Duration::from_secs(5);
        while cache.stats().inflight_waits == 0 {
            assert!(
                Instant::now() < deadline,
                "follower 没有进入 in-flight 等待"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        *lock(&http.released) = true;
        http.ready.notify_all();

        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("线程不应 panic"))
            .collect();
        for result in &results {
            assert_eq!(result.as_deref().unwrap(), b"CONCURRENT");
        }
        assert_eq!(
            http.calls.load(Ordering::SeqCst),
            1,
            "同一 URL 并发只下载一次"
        );
        assert_eq!(cache.stats().downloads, 1);
    }
}
