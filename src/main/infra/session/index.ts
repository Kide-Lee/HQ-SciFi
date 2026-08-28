import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 会话持久化：token 经 safeStorage 加密落盘（绝不明文，design.md 安全章节）。
 * Linux 无 keyring 时 safeStorage 可能不可用，此时降级 base64 并标记 insecure，UI 提示风险。
 */

export interface SessionData {
  token: string
  /** 非敏感用户信息（uid/nickname/avatar/introduce 等），明文存储即可 */
  userinfo: Record<string, unknown>
}

interface SessionFile {
  tokenCipher: string
  /** 加密算法标记：'safeStorage' | 'base64' */
  cipher: 'safeStorage' | 'base64'
  userinfo: Record<string, unknown>
  savedAt: number
}

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.json')
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 是否使用强加密存储。
 * Linux 下 safeStorage 可能落到 basic_text 后端（硬编码 key 的可逆混淆），
 * 强度与 base64 降级相当，统一标记 insecure 提示风险。
 */
export function isStrongEncryption(): boolean {
  if (!encryptionAvailable()) return false
  try {
    const backend = safeStorage.getSelectedStorageBackend?.()
    return backend === undefined || backend !== 'basic_text'
  } catch {
    return true
  }
}

export function saveSession(session: SessionData): void {
  const file = sessionFile()
  mkdirSync(dirname(file), { recursive: true })
  const strong = isStrongEncryption()
  const payload: SessionFile = {
    tokenCipher: strong
      ? safeStorage.encryptString(session.token).toString('base64')
      : Buffer.from(session.token, 'utf8').toString('base64'),
    cipher: strong ? 'safeStorage' : 'base64',
    userinfo: session.userinfo,
    savedAt: Date.now()
  }
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
}

export function loadSession(): (SessionData & { insecure: boolean }) | null {
  const file = sessionFile()
  if (!existsSync(file)) return null
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8')) as SessionFile
    let token: string
    if (payload.cipher === 'safeStorage') {
      if (!encryptionAvailable()) return null // 换环境/无 keyring 时无法解密，视为未登录
      token = safeStorage.decryptString(Buffer.from(payload.tokenCipher, 'base64'))
    } else {
      token = Buffer.from(payload.tokenCipher, 'base64').toString('utf8')
    }
    if (!token) return null
    return { token, userinfo: payload.userinfo ?? {}, insecure: payload.cipher !== 'safeStorage' }
  } catch {
    // 损坏的会话文件：清理并视为未登录
    try {
      rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
    return null
  }
}

export function clearSession(): void {
  const file = sessionFile()
  try {
    rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
}
