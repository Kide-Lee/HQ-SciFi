import { app, BrowserWindow, net } from 'electron'
import { getAppSettings } from './settings'
import type { UpdateState } from '../shared/types'

/**
 * v0.1.10：轻量 GitHub Release 检查。
 * 不使用 electron-updater 依赖（当前环境无 npm 安装条件），通过 GitHub API 检查最新版，
 * 有新版时渲染层横幅提供「前往下载」。deb 包不自动更新，仍可手动检查并跳转 Releases。
 */

const GITHUB_OWNER = 'Kide-Lee'
const GITHUB_REPO = 'HQ-SciFi'

interface ReleaseInfo {
  tag_name: string
  html_url: string
  body?: string
}

let lastState: UpdateState = { status: 'idle' }

function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '')
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

export function getUpdateState(): UpdateState {
  return lastState
}

function setState(state: UpdateState): void {
  lastState = state
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('hqsf:update-state', state)
  }
}

/** 检查 GitHub 最新 Release；返回最终状态并广播 */
export async function checkForGitHubUpdate(): Promise<UpdateState> {
  setState({ status: 'checking' })
  try {
    const res = await net.fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'hqsf-client'
      }
    })
    if (!res.ok) throw new Error(`GitHub 请求失败（HTTP ${res.status}）`)
    const release = (await res.json()) as ReleaseInfo
    const latest = normalizeVersion(release.tag_name)
    const current = normalizeVersion(app.getVersion())
    if (compareVersions(latest, current) > 0) {
      const state: UpdateState = {
        status: 'available',
        version: latest,
        notes: release.body?.slice(0, 500) || '',
        url: release.html_url
      }
      setState(state)
      return state
    }
    setState({ status: 'not-available' })
    return lastState
  } catch (err) {
    const message = err instanceof Error ? err.message : '检查更新失败'
    setState({ status: 'error', message })
    return lastState
  }
}

/** 启动后按设置延迟自动检查一次（失败静默，不打断用户） */
export function scheduleAutoUpdateCheck(): void {
  if (!getAppSettings().autoUpdate) return
  // Linux deb 包不支持自动更新（AppImage/NSIS 可自动检查）
  if (process.platform === 'linux' && !process.env.APPIMAGE) return
  const timer = setTimeout(() => {
    void checkForGitHubUpdate().catch(() => undefined)
  }, 10_000)
  timer.unref?.()
}
