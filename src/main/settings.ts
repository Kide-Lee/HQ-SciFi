import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'

/**
 * v0.1.10：主进程设置持久化。
 * 存储 userData/settings.json——硬件加速需要在 app ready 前读取，
 * 缩放比例/自定义 CSS/JS 需要主进程介入，因此不能只放渲染层 localStorage。
 */

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoUpdate: false,
  hardwareAccel: true,
  zoomFactor: 1,
  customCss: '',
  customJs: ''
}

let cached: AppSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function normalize(raw: unknown): AppSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const zoom = Number(r.zoomFactor)
  return {
    autoUpdate: !!r.autoUpdate,
    hardwareAccel: r.hardwareAccel !== false,
    zoomFactor: Number.isFinite(zoom) ? Math.min(1.5, Math.max(0.8, zoom)) : 1,
    customCss: typeof r.customCss === 'string' ? r.customCss : '',
    customJs: typeof r.customJs === 'string' ? r.customJs : ''
  }
}

/** 启动时同步读取设置；文件缺失/损坏时回退默认值 */
export function loadAppSettings(): AppSettings {
  if (cached) return cached
  try {
    const file = settingsFile()
    if (existsSync(file)) {
      cached = normalize(JSON.parse(readFileSync(file, 'utf8')))
    } else {
      cached = { ...DEFAULT_APP_SETTINGS }
    }
  } catch {
    cached = { ...DEFAULT_APP_SETTINGS }
  }
  return cached
}

export function getAppSettings(): AppSettings {
  return loadAppSettings()
}

/** 主进程唯一写入口：直接写 settings.json（设置文件小且低并发，无需额外原子 rename） */
export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadAppSettings(), ...patch }
  cached = normalize(next)
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cached, null, 2), { mode: 0o600 })
  return cached
}

/** 启动早期判断硬件加速（必须在 app ready 前调用） */
export function isHardwareAccelerationEnabled(): boolean {
  return loadAppSettings().hardwareAccel
}

