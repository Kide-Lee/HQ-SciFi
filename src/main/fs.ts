import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { getMeta, setMeta } from './db'
import type { LocalNode } from '../shared/types'

/**
 * 本地存档文件系统（design.md 本地存储布局）。
 * 默认根目录 ~/文档/荒启科幻/草稿，用户可经设置修改（存 SQLite meta）。
 * 所有文件读写都限定在存档根目录内（路径穿越防护）。
 */

const DOCS_ROOT_KEY = 'docs_root'

export function defaultDocsRoot(): string {
  return join(app.getPath('documents'), '荒启科幻', '草稿')
}

export function getDocsRoot(): string {
  return getMeta(DOCS_ROOT_KEY) || defaultDocsRoot()
}

export function setDocsRoot(dir: string): void {
  setMeta(DOCS_ROOT_KEY, dir)
}

export function ensureDocsRoot(): string {
  const root = getDocsRoot()
  mkdirSync(root, { recursive: true })
  return root
}

/** 校验并返回规范化绝对路径；越界即抛错（渲染层经 IPC 传入的路径必须受控） */
export function assertInside(root: string, p: string): string {
  const r = resolve(root)
  const f = resolve(p)
  if (f !== r && !f.startsWith(r + sep)) {
    throw new Error('路径越界：仅允许访问本地存档目录')
  }
  // symlink 防穿越：基准与目标都解析符号链接后再比较（root 本身可能是 symlink）
  const realRoot = realpathWithin(r, r)
  const real = realpathWithin(realRoot, f)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('路径越界：符号链接指向存档目录之外')
  }
  return f
}

/** 计算 target 的 realpath（对不存在的部分向上回溯到最近存在的祖先再拼接） */
function realpathWithin(root: string, target: string): string {
  const tails: string[] = []
  let cur = target
  for (;;) {
    try {
      return join(realpathSync(cur), ...tails)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return target // 全部不存在，按字符串路径处理
      tails.unshift(basename(cur))
      cur = parent
    }
  }
}

function readTree(dir: string, depth: number): LocalNode[] {  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.name.toLowerCase().endsWith('.md'))
    .map((d) => {
      const node: LocalNode = {
        name: d.name,
        path: join(dir, d.name),
        isDir: d.isDirectory()
      }
      if (d.isDirectory() && depth > 0) {
        try {
          node.children = readTree(node.path, depth - 1)
        } catch {
          node.children = []
        }
      }
      return node
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1))
}

/** 列出本地存档目录树（md 文件 + 子目录，两层） */
export function listLocalDocs(): LocalNode[] {
  return readTree(ensureDocsRoot(), 1)
}

/** 读本地 md 文件（仅限存档根目录内） */
export function readLocalFile(root: string, p: string): string {
  const abs = assertInside(root, p)
  if (!existsSync(abs)) throw new Error('文件不存在')
  return readFileSync(abs, 'utf8')
}

/** 写本地 md 文件（仅限存档根目录内；目录自动创建） */
export function writeLocalFile(root: string, p: string, content: string): void {
  const abs = assertInside(root, p)
  mkdirSync(resolve(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

/** 文件名清理：去掉路径分隔符与非法字符，限制长度 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned || '未命名'
}

/** 生成不重名的文件路径：标题 + 时间戳后缀（design.md 命名建议） */
export function uniqueFilePath(root: string, title: string, ext = '.md'): string {
  const safe = sanitizeFileName(title)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  let candidate = join(root, `${safe} ${stamp}${ext}`)
  let i = 1
  while (existsSync(candidate)) {
    candidate = join(root, `${safe} ${stamp} (${i})${ext}`)
    i++
  }
  return candidate
}

/** 新建本地草稿文件，返回绝对路径 */
export function createLocalDraft(root: string, title: string, content: string): string {
  const abs = uniqueFilePath(root, title)
  writeFileSync(abs, content, 'utf8')
  return abs
}

/** 弹出目录选择对话框（设置中更换存档根目录） */
export async function chooseDocsDir(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择本地存档目录',
    defaultPath: getDocsRoot(),
    properties: ['openDirectory', 'createDirectory']
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const dir = result.filePaths[0]
  setDocsRoot(dir)
  ensureDocsRoot()
  return dir
}

/** 从文件路径取标题（去除 .md 后缀；标题中的时间戳后缀保留原样展示） */
export function titleFromPath(p: string): string {
  return basename(p).replace(/\.md$/i, '')
}
