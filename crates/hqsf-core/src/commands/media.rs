//! 媒体命令层（1.x `src/main/ipc/media.handlers.ts`，1 条通道）。
//!
//! `media:pick-upload-image` 是 1.x 唯一没有 `hqsf:` 前缀的历史通道（见
//! `src/main/ipc/media.handlers.ts:7`），契约快照里也按原样冻结，不要改通道名。
//!
//! 1.x 的 `media-service.ts` 里 `pickUploadImage` 与 `pickUploadUserImage` 共用同一个
//! `pickUpload`：弹文件框 → 读字节 → multipart 上传 `uploadFile` → `{ url }`（取消 `null`）。
//! 内核把这段行为收敛在 [`crate::adapters::user::pick_upload_user_image`]，本命令与
//! `hqsf:pick-upload-user-image` 走同一条路径，避免两份复制品漂移。
//!
//! 与 1.x 的差异（均为壳层职责，已在迁移报告登记）：
//! - `trusted(event)` 的 Electron sender 校验在 Tauri 下等价于「只有本应用窗口能调」，
//!   内核拿不到调用方信息，不重复实现；
//! - 1.x `dialog.showOpenDialog` 的 `filters`（png/jpg/jpeg/gif/webp/bmp）在
//!   [`crate::ports::Dialog::pick_image`] 端口的壳层实现里过滤（内核端口没有 filters 参数）。

use crate::adapters::user::{self, UploadedImage};
use crate::{CoreCtx, CoreResult};

/// `media:pick-upload-image`：弹系统文件框选图并上传荒启，取消返回 `null`。
///
/// 失败文案与 1.x 逐字一致（`media-service.ts:22` 的未登录分支在上游 handler 里抛
/// 「未登录，无法上传图片」，`adapters::user::pick_upload_user_image` 用同一句）。
pub fn pick_upload_image(ctx: &CoreCtx) -> CoreResult<Option<UploadedImage>> {
    user::pick_upload_user_image(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FileStore as _;
    use crate::testkit::Harness;

    #[test]
    fn pick_upload_image_returns_none_when_dialog_cancelled() {
        let h = Harness::new().with_api_config().with_token("tok");
        assert_eq!(pick_upload_image(h.ctx()).unwrap(), None);
        assert!(h.requests().is_empty(), "取消时不应发出上传请求");
    }

    #[test]
    fn pick_upload_image_requires_login() {
        let h = Harness::new().with_api_config();
        let err = pick_upload_image(h.ctx()).unwrap_err();
        assert_eq!(err.to_string(), "未登录，无法上传图片");
    }

    #[test]
    fn pick_upload_image_uploads_picked_file() {
        let h = Harness::new().with_api_config().with_token("tok");
        h.files
            .write(std::path::Path::new("/pics/a.png"), b"PNGDATA")
            .unwrap();
        *h.dialog.picked_image.lock().unwrap() = Some("/pics/a.png".into());
        h.http
            .enqueue(200, r#"{"code":1,"data":{"url":"https://cdn.x/a.png"}}"#);

        let picked = pick_upload_image(h.ctx()).unwrap().unwrap();
        assert_eq!(picked.url, "https://cdn.x/a.png");
        let reqs = h.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].method, "POST");
        let body = reqs[0].body.clone().unwrap_or_default();
        let body = String::from_utf8_lossy(&body);
        assert!(
            body.contains("filename=\"a.png\""),
            "文件名应取 basename：{body}"
        );
        assert!(body.contains("PNGDATA"), "上传的应是文件字节");
        assert!(body.contains("tok"), "token 应在 multipart 表单里");
    }
}
