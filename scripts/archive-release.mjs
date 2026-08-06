#!/usr/bin/env node
/**
 * scripts/archive-release.mjs
 *
 * 把 electron-builder 产出的安装包按版本归档到 dist/releases/<version>/，
 * 统一使用发布文件名（Windows exe 用点号格式 hq-scifi.Setup.<v>.exe，
 * 与 README 下载链接一致）。
 *
 * 用法：
 *   node scripts/archive-release.mjs            # 归档当前 package.json 版本
 *   node scripts/archive-release.mjs 0.0.1      # 归档指定版本（历史产物）
 *
 * 幂等：只复制（copyFileSync 覆盖已存在目标）；某平台产物缺失时仅提示、不报错
 * （支持单跑 build:win 或 build:linux 的场景）。由 build:win / build:linux
 * 编排调用，归档失败会置失败退出码。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'dist')
const version =
  process.argv[2] ?? JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const targetDir = join(distDir, 'releases', version)

/** [源文件, 归档文件名]；源文件在 dist/ 顶层，两种 exe 命名（空格/点号）都兼容 */
const artifacts = [
  [`hq-scifi Setup ${version}.exe`, `hq-scifi.Setup.${version}.exe`],
  [`hq-scifi.Setup.${version}.exe`, `hq-scifi.Setup.${version}.exe`],
  [`hq-scifi-${version}.AppImage`, `hq-scifi-${version}.AppImage`],
  [`hq-scifi_${version}_amd64.deb`, `hq-scifi_${version}_amd64.deb`]
]

mkdirSync(targetDir, { recursive: true })

let archived = 0
for (const [src, name] of artifacts) {
  const from = join(distDir, src)
  if (!existsSync(from)) continue
  copyFileSync(from, join(targetDir, name))
  console.log(`[archive-release] ${src} -> releases/${version}/${name}`)
  archived++
}

console.log(`[archive-release] v${version} 归档完成：${archived} 个产物 -> dist/releases/${version}/`)
