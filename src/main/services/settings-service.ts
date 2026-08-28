import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

export { getAppSettings, updateAppSettings } from '../infra/settings'
export { clearReadCache } from '../infra/db'

/** 读取更新日志（按候选路径查找） */
export function getChangelogData(): { version: string; markdown: string } {
  const candidates = [
    join(process.resourcesPath ?? '', 'changelog.md'),
    join(app.getAppPath(), 'doc', 'CHANGELOG.md'),
    join(process.cwd(), 'doc', 'CHANGELOG.md')
  ]
  const file = candidates.find((f) => f && existsSync(f))
  if (!file) throw new Error('找不到更新日志文件')
  return { version: app.getVersion(), markdown: readFileSync(file, 'utf8') }
}

/** 应用内卸载（仅 Windows）；成功返回后调用方应退出应用 */
export function uninstallApplication(): void {
  if (process.platform !== 'win32') {
    throw new Error('当前平台不支持应用内卸载；请使用系统包管理器或删除应用目录')
  }
  const uninstaller = join(dirname(process.execPath), 'Uninstall huangqi-scifi.exe')
  if (!existsSync(uninstaller)) {
    throw new Error('未找到卸载程序，请打开系统设置中的应用列表手动卸载')
  }
  const child = spawn(uninstaller, [], { detached: true, stdio: 'ignore' })
  child.unref()
  setImmediate(() => app.quit())
}
