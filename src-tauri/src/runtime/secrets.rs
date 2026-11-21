//! `SecretStore` 的系统钥匙串实现（1.x `src/main/infra/session/index.ts` 的 safeStorage 加密）。
//!
//! 迁移来源：`src/main/infra/session/index.ts:1-140`：
//!   1.x 把 token 用 `safeStorage.encryptString` 加密后存进 `userData/session.json`
//!   （`cipher: 'safeStorage' | 'base64'`，Linux 在 `basic_text` 弱加密时降级 base64 并标记 insecure）。
//!   迁移计划 §1.5 明确：v2 改为系统钥匙串，**safeStorage 密文无法跨实现解密 → 首次启动强制重新登录**。
//!
//! 与 Electron 的差异：
//!   - **存储位置**：userData 文件 → 系统凭据库（Linux Secret Service/KWallet、macOS Keychain、
//!     Windows Credential Manager）；不再有 session.json 密文文件。
//!   - **键名**：1.x 没有 keyring，不存在「沿用」的键名。这里约定 service = `com.huangqisf.client`
//!     （= tauri identifier），account = 内核传入的 key（约定形如 `hqsf:token` / `hqsf:refresh-token`，
//!     由 L4 会话 lane 的 services/session 决定）。常量集中在 [`KEY_SERVICE`]，改一处即可。
//!   - **降级策略**：1.x 在没有 safeStorage 时降级 base64（不安全但能跑）；v2 **不降级**：
//!     拿不到钥匙串就返回 `CoreError::App`，让上层提示「无法保存登录状态」，绝不把明文写盘。
//!     （Linux 无 Secret Service 守护进程是最常见的失败场景。）
//!   - **不 panic**：keyring 的所有错误都翻译成 CoreError；`unwrap()` 在本文件不存在。

use hqsf_core::error::{CoreError, CoreResult};
use hqsf_core::ports::SecretStore;

/// 钥匙串 service 名 = tauri identifier，避免与其他应用冲突。
pub const KEY_SERVICE: &str = "com.huangqisf.client";

/// 基于系统钥匙串的凭据端口。
#[derive(Debug, Clone)]
pub struct KeyringSecrets {
    service: String,
}

impl KeyringSecrets {
    pub fn new() -> Self {
        Self {
            service: KEY_SERVICE.to_string(),
        }
    }

    /// 把 keyring 的错误翻译成用户可读的 CoreError。
    ///
    /// 注意：这里**不复用** `CoreError::Io`——钥匙串错误不是文件 IO，`code()` 会被前端当成 io 分类。
    /// 统一走 `App`（用户可读文案），并在文案里点明「钥匙串」便于排查。
    fn map_err(action: &str, key: &str, err: keyring::Error) -> CoreError {
        // Linux 无 Secret Service 时是 PlatformFailure / NoStorageAccess；macOS 用户拒绝访问同理。
        CoreError::app(format!(
            "系统钥匙串不可用（{action} {key} 失败）：{err}。请确认系统凭据服务已启用后再试。"
        ))
    }
}

impl Default for KeyringSecrets {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeyringSecrets {
    fn get(&self, key: &str) -> CoreResult<Option<String>> {
        // keyring 3.x 是同步 API（内部阻塞在 DBus/Keychain 上）。
        // 调用方都在 #[tauri::command] 的 worker 线程里，不能在主线程直接调用（见 runtime/mod.rs）。
        let entry = keyring::Entry::new(&self.service, key)
            .map_err(|e| Self::map_err("打开凭据项", key, e))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            // 没有记录 = 未登录，不是错误（1.x：session.json 不存在同样按未登录处理）。
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Self::map_err("读取凭据", key, e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> CoreResult<()> {
        let entry = keyring::Entry::new(&self.service, key)
            .map_err(|e| Self::map_err("打开凭据项", key, e))?;
        entry
            .set_password(value)
            .map_err(|e| Self::map_err("写入凭据", key, e))
    }

    fn delete(&self, key: &str) -> CoreResult<()> {
        let entry = keyring::Entry::new(&self.service, key)
            .map_err(|e| Self::map_err("打开凭据项", key, e))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // 幂等：本来就没有就当作删除成功。
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Self::map_err("删除凭据", key, e)),
        }
    }
}
