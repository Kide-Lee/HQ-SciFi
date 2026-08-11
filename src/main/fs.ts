import { app, dialog, shell, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { getMeta, setMeta } from './db'
import { isTestMode } from './testmode'
import type { LocalNode } from '../shared/types'

/**
 * 本地存档文件系统（design.md 本地存储布局）。
 * 默认根目录 ~/文档/荒启科幻/草稿，用户可经设置修改（存 SQLite meta）。
 * 所有文件读写都限定在存档根目录内（路径穿越防护）。
 */

const DOCS_ROOT_KEY = 'docs_root'

export function defaultDocsRoot(): string {
  const base = join(app.getPath('documents'), '荒启科幻', '草稿')
  // 测试模式用独立存档根，本地测试文件不混入正式存档
  return isTestMode() ? `${base}-test` : base
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

/** 摘要与字数：读 md 内容，去首部标题行后取前 100 字摘要；字数去空白统计 */
function summarize(content: string): { summary: string; words: number } {
  const text = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ')
    .trim()
  return {
    summary: text.slice(0, 100) + (text.length > 100 ? '…' : ''),
    words: content.replace(/\s/g, '').length
  }
}

/** 图片目录名（隐藏目录，存放文章配图；列表树中过滤） */
export const IMAGE_DIR = '.image'

/** 图片目录相对根：.image/<cid 或文件名>/
 *  带 cid 的文章用 cid（拉取时稳定），纯本地草稿用文件名 */
export function imageDirName(cidOrName: string): string {
  return join(IMAGE_DIR, sanitizeFileName(cidOrName))
}

export function imageDirFor(root: string, cidOrName: string): string {
  return join(root, imageDirName(cidOrName))
}

function readTree(dir: string, depth: number, root: string): LocalNode[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.name.toLowerCase().endsWith('.md'))
    // 隐藏 .image 图片目录（及其它点开头隐藏项）不进入文档树
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      const abs = join(dir, d.name)
      const node: LocalNode = {
        name: d.name,
        path: abs,
        rel: relative(root, abs).split(sep).join('/'),
        isDir: d.isDirectory()
      }
      if (d.isDirectory() && depth > 0) {
        try {
          node.children = readTree(node.path, depth - 1, root)
        } catch {
          node.children = []
        }
      } else if (!d.isDirectory()) {
        // v0.0.6：写作首页卡片信息（mtime/字数/摘要）
        try {
          const st = statSync(node.path)
          node.mtime = st.mtimeMs
          const { summary, words } = summarize(readFileSync(node.path, 'utf8'))
          node.words = words
          node.summary = summary
        } catch {
          // 读不到信息时保持缺省
        }
      }
      return node
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1))
}

/** 列出本地存档目录树（md 文件 + 子目录，任意层级；隐藏 .image 等点开头目录） */
export function listLocalDocs(): LocalNode[] {
  const root = ensureDocsRoot()
  return readTree(root, Number.POSITIVE_INFINITY, root)
}

/** 新建文件夹（相对存档根，路径穿越防护）；已存在时返回其路径（幂等） */
export function createLocalDir(root: string, rel: string): string {
  const abs = assertInside(root, join(root, rel))
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) throw new Error('同名文件已存在')
    return abs
  }
  mkdirSync(abs, { recursive: true })
  return abs
}

/** 删除本地 md 文件（移入系统回收站，可恢复；文件不存在视为成功） */
export async function deleteLocalFile(root: string, p: string): Promise<void> {
  const abs = assertInside(root, p)
  if (!existsSync(abs)) return
  const st = statSync(abs)
  if (st.isDirectory()) throw new Error('不能删除目录，仅支持删除文章文件')
  await shell.trashItem(abs)
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

/** 生成不重名的文件路径：纯标题；已存在同名时追加 (1)/(2)… 后缀（不覆盖、不带日期） */
export function uniqueFilePath(root: string, title: string, ext = '.md'): string {
  const safe = sanitizeFileName(title)
  let candidate = join(root, `${safe}${ext}`)
  let i = 1
  while (existsSync(candidate)) {
    candidate = join(root, `${safe} (${i})${ext}`)
    i++
  }
  return candidate
}

/** 新建本地草稿文件，返回绝对路径 */
/** 在（可选的）相对子目录中新建草稿；重名自动追加序号 */
export function createLocalDraft(root: string, title: string, content: string, dirRel = ''): string {
  const abs = uniqueFilePath(dirRel ? join(root, dirRel) : root, title)
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
