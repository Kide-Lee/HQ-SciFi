//! 内嵌媒体播放页识别。
//!
//! 阅读正文里的音乐/视频来自三个站点提供的「嵌入播放器」页面，用 `<iframe>` 呈现：
//!
//! - `https://music.163.com/outchain/player?type=2&id=…`
//! - `https://i.y.qq.com/n2/m/outchain/player/index.html?songid=…`
//! - `https://player.bilibili.com/player.html?bvid=…`
//!
//! 壳层的导航策略（`src-tauri/src/lib.rs` 的 `on_navigation`）对「应用自身 origin 之外
//! 一律拒绝并交系统浏览器」，而 wry 的 `decide-policy` 回调**不区分主框架与子框架**，
//! 所以 `iframe` 的首次导航也会被问一次；不放行就是「一块透明空白」。
//!
//! 因此这里给出一个**极窄**的白名单：只有这三个站点的播放器路径算内嵌媒体，别的
//! `http(s)` 仍然走外部浏览器。判定放在内核（纯函数 + 单元测试），壳层只调用。

/// 允许内嵌的播放器端点：`(host, path 前缀)`。host 精确匹配（忽略大小写）。
const EMBED_PLAYERS: [(&str, &str); 3] = [
    ("music.163.com", "/outchain/player"),
    ("i.y.qq.com", "/n2/m/outchain/player"),
    ("player.bilibili.com", "/player.html"),
];

/// 该 URL 是否是三个站点的嵌入播放器页面。
///
/// 只认 `http` / `https`、host 精确匹配、path 前缀匹配；`music.163.com/song?id=…`
/// 这类普通页面**不算**（它们应该继续走外部浏览器）。
pub fn is_embedded_media_url(url: &str) -> bool {
    let trimmed = url.trim();
    let rest = match trimmed.split_once("://") {
        Some((scheme, rest)) => {
            let scheme = scheme.to_ascii_lowercase();
            if scheme != "http" && scheme != "https" {
                return false;
            }
            rest
        }
        None => return false,
    };

    // 去掉 fragment 与 query，只留 authority + path。
    let rest = rest.split(['#', '?']).next().unwrap_or("");
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    // 去 userinfo 与端口：`user@host:443`。
    let host = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let host = host.split(':').next().unwrap_or("");

    EMBED_PLAYERS.iter().any(|(expected_host, path_prefix)| {
        // 前缀必须落在路径边界上：`/outchain/player` 与 `/outchain/player/index.html`
        // 算，`/outchain/playerground` 不算。
        let path_matches = path == *path_prefix
            || path
                .strip_prefix(path_prefix)
                .is_some_and(|rest| rest.starts_with('/'));
        host.eq_ignore_ascii_case(expected_host) && path_matches
    })
}

#[cfg(test)]
mod tests {
    use super::is_embedded_media_url;

    #[test]
    fn recognizes_the_three_players() {
        assert!(is_embedded_media_url(
            "https://music.163.com/outchain/player?type=2&id=509720124&auto=0&height=66"
        ));
        assert!(is_embedded_media_url(
            "https://i.y.qq.com/n2/m/outchain/player/index.html?songid=744453029&songtype=0"
        ));
        assert!(is_embedded_media_url(
            "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0"
        ));
        // 协议大小写、host 大小写、带端口都不影响。
        assert!(is_embedded_media_url(
            "HTTPS://Music.163.com/outchain/player?type=2&id=1"
        ));
        assert!(is_embedded_media_url(
            "https://music.163.com:443/outchain/player?type=2&id=1"
        ));
        assert!(is_embedded_media_url(
            "https://music.163.com/outchain/player#frag"
        ));
    }

    #[test]
    fn rejects_ordinary_pages_and_lookalikes() {
        // 同一站点的普通页面：应当继续走系统浏览器。
        assert!(!is_embedded_media_url("https://music.163.com/song?id=1"));
        assert!(!is_embedded_media_url("https://music.163.com/"));
        // path 只是前缀相同但不在白名单里。
        assert!(!is_embedded_media_url(
            "https://music.163.com/outchain/playerground?type=2&id=1"
        ));
        // 其它 host 上的同形路径。
        assert!(!is_embedded_media_url(
            "https://evil.example.com/outchain/player?type=2&id=1"
        ));
        // 子域名不算（白名单是精确 host）。
        assert!(!is_embedded_media_url(
            "https://cdn.music.163.com/outchain/player?type=2&id=1"
        ));
        // 非 http(s) 协议。
        assert!(!is_embedded_media_url("tauri://localhost/outchain/player"));
        assert!(!is_embedded_media_url("file:///outchain/player"));
        assert!(!is_embedded_media_url(""));
    }
}
