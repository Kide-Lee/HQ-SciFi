#!/usr/bin/env node
/**
 * scripts/win-prebuild.mjs
 *
 * Linux 交叉打包 Windows 包（npm run build:win）专用：
 * electron-builder 在 Linux 上打 --win 时，会把本机 node_modules 里
 * better-sqlite3 的原生二进制（Linux ELF）原样打进 Windows 包，
 * 导致 Windows 上加载 .node 失败（"not a valid Win32 application"）、
 * initDb 抛错、永不创建窗口（界面打不开）。
 *
 * 本脚本在打包前（apply）把 node_modules 里 better-sqlite3 的 .node
 * 临时替换为官方 prebuild（Windows x64，匹配当前 Electron 的 ABI），
 * 打包后（restore）恢复 Linux 版，不影响本机与 build:linux。
 *
 * 用法：
 *   node scripts/win-prebuild.mjs apply    # 打包前：替换为 Windows 版
 *   node scripts/win-prebuild.mjs restore  # 打包后：恢复 Linux 版
 *
 * 由 package.json 的 build:win 编排调用（apply 失败则不打、restore 必执行）。
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync
} from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const bsqDir = join(repoRoot, 'node_modules', 'better-sqlite3')
const electronDir = join(repoRoot, 'node_modules', 'electron')
const bsqRelease = join(bsqDir, 'build', 'Release')
const bsqNode = join(bsqRelease, 'better_sqlite3.node')
// 备份放仓库根下（electron-builder files 只收 out/**，不会进包）；放 node_modules 内会被 asarUnpack 打进安装包
const bsqBackup = join(repoRoot, '.win-prebuild-bak', 'better_sqlite3.node')

function fail(msg) {
  console.error(`[win-prebuild] ${msg}`)
  process.exit(1)
}

/** 下载 URL 内容到本地文件（跟随 redirect，校验 status 200，180s 超时，失败重试 3 次） */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`))
      }
      const out = createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(resolve))
      out.on('error', reject)
    })
    req.setTimeout(180000, () => req.destroy(new Error('下载超时（180s）')))
    req.on('error', reject)
  })
}

async function downloadWithRetry(url, dest, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await download(url, dest)
      return
    } catch (e) {
      if (i === tries) throw e
      console.log(`[win-prebuild] 下载失败（${e.message}），重试 ${i}/${tries - 1}…`)
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
}

/** PE 可执行文件（Windows）魔数 MZ */
function isPe(file) {
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(2)
    readSync(fd, buf, 0, 2, 0)
    closeSync(fd)
    return buf[0] === 0x4d && buf[1] === 0x5a
  } catch {
    return false
  }
}

/** Linux ELF 魔数 */
function isElf(file) {
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(4)
    readSync(fd, buf, 0, 4, 0)
    closeSync(fd)
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46
  } catch {
    return false
  }
}

/** 取当前 Electron 的 ABI（process.versions.modules）——ELECTRON_RUN_AS_NODE 模式无需 GUI */
function electronAbi() {
  if (!existsSync(join(electronDir, 'dist', 'electron'))) {
    fail('未找到 node_modules/electron（先 npm install）')
  }
  const bin = join(electronDir, 'dist', 'electron')
  const abi = execFileSync(bin, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
    .toString()
    .trim()
  if (!/^\d+$/.test(abi)) fail(`无法解析 Electron ABI：${abi}`)
  return abi
}

/** 解压 prebuild 并校验产物，返回 Windows 版 .node 路径；不合法抛错 */
function extractWinNode(tarball, tmp) {
  execFileSync('tar', ['-xzf', tarball, '-C', tmp], { stdio: 'pipe' })
  const winNode = join(tmp, 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(winNode)) throw new Error('prebuild 解压后未找到 build/Release/better_sqlite3.node')
  if (!isPe(winNode)) throw new Error('prebuild 不是 Windows PE 二进制，已中止（避免打出坏包）')
  return winNode
}

/**
 * 准备 Windows 版 .node：优先用 /tmp/bsq-prebuild-cache 缓存；
 * 缓存缺失则下载（存缓存），缓存损坏则删除缓存重新下载。
 */
async function prepareWinNode(url, tarball, cached, tmp) {
  const fromCache = existsSync(cached)
  if (fromCache) {
    console.log('[win-prebuild] 命中本地缓存（/tmp/bsq-prebuild-cache），跳过下载')
    copyFileSync(cached, tarball)
  } else {
    await downloadWithRetry(url, tarball).catch((e) => {
      throw new Error(`prebuild 下载失败：${e.message}`)
    })
    try {
      mkdirSync(dirname(cached), { recursive: true })
      copyFileSync(tarball, cached)
    } catch {
      /* 缓存写入失败不影响本次使用 */
    }
  }
  try {
    return extractWinNode(tarball, tmp)
  } catch (e) {
    if (!fromCache) throw e
    console.log(`[win-prebuild] 缓存文件损坏（${e.message}），删除并重新下载`)
    rmSync(cached, { force: true })
    await downloadWithRetry(url, tarball).catch((err) => {
      throw new Error(`prebuild 下载失败：${err.message}`)
    })
    try {
      mkdirSync(dirname(cached), { recursive: true })
      copyFileSync(tarball, cached)
    } catch {
      /* ignore */
    }
    return extractWinNode(tarball, tmp)
  }
}

async function apply() {
  if (!existsSync(bsqNode)) fail(`未找到 ${bsqNode}（先 npm install）`)
  if (!isElf(bsqNode)) {
    fail('当前 better_sqlite3.node 不是 Linux ELF（疑似上次 restore 未完成、残留 Windows 版）。先执行 node scripts/win-prebuild.mjs restore 或手动恢复，再打包')
  }
  if (existsSync(bsqBackup)) {
    fail('检测到上次打包的备份未恢复（.win-prebuild-bak/ 已存在）。先执行 node scripts/win-prebuild.mjs restore')
  }
  const pkgFile = join(bsqDir, 'package.json')
  if (!existsSync(pkgFile)) fail(`未找到 ${pkgFile}（先 npm install）`)

  const bsqVer = JSON.parse(readFileSync(pkgFile, 'utf8')).version
  const abi = electronAbi()
  // v0.0.10：升级 Electron 时的 ABI 前置检查——better-sqlite3 官方 prebuild
  // 只覆盖到某个 electron-v ABI（当前锁 v12.11.1 覆盖到 electron-v146）。
  // 超出时直接失败并给出明确指引，而不是让后面的下载 404 报错。
  // 若已升级 better-sqlite3 且官方覆盖更高 ABI，请同步更新此阈值。
  const MAX_BSQ_ABI = 146
  if (Number(abi) > MAX_BSQ_ABI) {
    fail(
      `当前 Electron ABI=${abi} 超出 better-sqlite3 v${bsqVer} 官方 prebuild 已知覆盖（≤ electron-v${MAX_BSQ_ABI}）。` +
        '请升级 better-sqlite3（并同步更新 scripts/win-prebuild.mjs 的 MAX_BSQ_ABI），或改用其 prebuild 覆盖范围内的 Electron 版本。'
    )
  }
  const asset = `better-sqlite3-v${bsqVer}-electron-v${abi}-win32-x64.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqVer}/${asset}`
  console.log(`[win-prebuild] Electron ABI=${abi}, better-sqlite3 v${bsqVer}`)
  console.log(`[win-prebuild] 下载 Windows prebuild: ${asset}`)

  const tmp = mkdtempSync(join(tmpdir(), 'bsq-win-'))
  const tarball = join(tmp, asset)
  const cached = join(tmpdir(), 'bsq-prebuild-cache', asset)
  try {
    const winNode = await prepareWinNode(url, tarball, cached, tmp)

    // 备份走临时文件 + rename（同目录原子写），避免半写备份
    mkdirSync(dirname(bsqBackup), { recursive: true })
    const bakTmp = `${bsqBackup}.tmp`
    copyFileSync(bsqNode, bakTmp)
    renameSync(bakTmp, bsqBackup)
    copyFileSync(winNode, bsqNode)
    console.log('[win-prebuild] 已替换为 Windows 版（原文件备份到 .win-prebuild-bak/），可以执行 electron-builder --win')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function restore() {
  if (!existsSync(bsqBackup)) {
    console.log('[win-prebuild] 无备份可恢复（无需处理）')
    return
  }
  if (!isElf(bsqBackup)) {
    fail(`备份文件异常（非 Linux ELF），已中止恢复以免覆盖现有 .node：${bsqBackup}`)
  }
  try {
    copyFileSync(bsqBackup, bsqNode)
    rmSync(dirname(bsqBackup), { recursive: true, force: true })
    console.log('[win-prebuild] 已恢复 Linux 版 better_sqlite3.node')
  } catch (e) {
    fail(`恢复失败：${e.message}（本机 .node 可能仍是 Windows 版，打包 Linux 前请手动检查）`)
  }
}

const mode = process.argv[2]
if (!mode) {
  console.error('用法：node scripts/win-prebuild.mjs apply|restore')
  process.exit(1)
}
if (mode === 'apply') apply().catch((e) => fail(e.message))
else if (mode === 'restore') restore()
else fail(`未知模式：${mode}（支持 apply / restore）`)
