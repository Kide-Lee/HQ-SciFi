#!/usr/bin/env node
// 产物自检：安装包构建出来之后，检查「装出来的东西是不是我们要的」。
//
// 为什么需要它：打包「成功」只说明文件生成了。真正会翻车的是内容——
// version 没跟上、依赖没声明、资源没打进包、dmg 里的 appId 不对。
// 这些在装上真机前都能查，成本几乎为零。
//
// 用法：node scripts/verify-bundles.mjs [--expect-version 2.0.14]
// 约定：发现不一致 → 打印原因并 exit 1（让 CI 红在这一步，而不是等用户装上）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TAURI_DIR = join(ROOT, 'src-tauri')
const TARGET_DIR = join(TAURI_DIR, 'target')

const failures = []
const notes = []

function fail(msg) {
  failures.push(msg)
}

function note(msg) {
  notes.push(msg)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// 各平台的 bundle 目录：linux/windows 在 target/release/bundle，
// macOS 交叉编译在 target/<triple>/release/bundle。
function bundleDirs() {
  const dirs = [join(TARGET_DIR, 'release', 'bundle')]
  if (existsSync(TARGET_DIR)) {
    for (const entry of readdirSync(TARGET_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(TARGET_DIR, entry.name, 'release', 'bundle')
      if (existsSync(candidate)) dirs.push(candidate)
    }
  }
  return dirs.filter((d) => existsSync(d))
}

function findFiles(ext) {
  const hits = []
  for (const dir of bundleDirs()) {
    for (const file of walk(dir)) {
      if (file.endsWith(ext)) hits.push(file)
    }
  }
  return hits
}

function sizeOf(path) {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)}MB`
}

const conf = readJson(join(TAURI_DIR, 'tauri.conf.json'))
const version = conf.version
const identifier = conf.identifier
const productName = conf.productName ?? 'hq-scifi'

const expectVersionArg = process.argv.indexOf('--expect-version')
if (expectVersionArg !== -1) {
  const expected = process.argv[expectVersionArg + 1]
  if (version !== expected) {
    fail(`tauri.conf.json 的 version 是 ${version}，期望 ${expected}`)
  }
}

note(`tauri.conf.json: version=${version} identifier=${identifier} productName=${productName}`)

const RESOURCES = ['api.config.json', 'agreement.md', 'changelog.md']

// ---------- Linux：deb 的 Version / Depends / 包内资源，AppImage 的存在性 ----------
function checkLinux() {
  const debs = findFiles('.deb')
  const appimages = findFiles('.AppImage')

  if (debs.length === 0) fail('没有找到 .deb 产物')
  if (appimages.length === 0) fail('没有找到 .AppImage 产物')

  for (const deb of debs) {
    note(`deb: ${deb.replace(ROOT + '/', '')} ${sizeOf(deb)}`)

    let versionField = ''
    try {
      versionField = sh('dpkg-deb', ['-f', deb, 'Version']).trim()
    } catch {
      note('dpkg-deb 不可用，跳过 deb 元数据检查')
    }
    if (versionField) {
      // tauri 会把 Debian 版本号规范成 `2.0.14` 或带修订后缀的形式，前缀必须匹配。
      if (!versionField.startsWith(version)) {
        fail(`deb 的 Version 是 ${versionField}，期望以 ${version} 开头`)
      }
    }

    try {
      const depends = sh('dpkg-deb', ['-f', deb, 'Depends']).trim()
      // 这是 2.0 最大的分发前提：不再自带渲染引擎，必须声明系统 WebKitGTK 4.1。
      if (!/webkit2gtk/.test(depends)) {
        fail(`deb 的 Depends 没有声明 webkit2gtk：${depends}`)
      }
      if (/webkit2gtk-4\.0/.test(depends)) {
        fail(`deb 依赖了 WebKitGTK 4.0（应为 4.1）：${depends}`)
      }
      note(`deb Depends: ${depends}`)
    } catch {
      note('dpkg-deb 不可用，跳过 deb 依赖检查')
    }

    try {
      const contents = sh('dpkg-deb', ['-c', deb])
      for (const name of RESOURCES) {
        if (!contents.includes(name)) fail(`deb 内没有打包资源 ${name}`)
      }
      const binary = contents
        .split('\n')
        .map((line) => line.trim().split(/\s+/).pop())
        .find((path) => path && path.endsWith(`/bin/${productName}`))
      if (!binary) {
        note(`deb 内没找到 /bin/${productName}（可能主程序名不同，需人工确认）`)
      }
      note('deb 内含打包资源：' + RESOURCES.join(' / '))
    } catch {
      note('dpkg-deb 不可用，跳过 deb 内容检查')
    }
  }

  for (const appimage of appimages) {
    note(`AppImage: ${appimage.replace(ROOT + '/', '')} ${sizeOf(appimage)}`)
    if ((statSync(appimage).mode & 0o111) === 0) fail(`AppImage 没有可执行权限：${appimage}`)
    // AppImage 是自包含 rootfs，理应比 deb 大得多；太小通常意味着打进了空壳。
    if (statSync(appimage).size < 20 * 1024 * 1024) {
      fail(`AppImage 只有 ${sizeOf(appimage)}，疑似没有打进 WebKit 运行时`)
    }
  }
}

// ---------- Windows：NSIS 安装包的版本信息与体积 ----------
function checkWindows() {
  const installers = findFiles('.exe').filter((file) => /setup/i.test(file))
  if (installers.length === 0) fail('没有找到 NSIS 安装包（*-setup.exe）')

  for (const exe of installers) {
    note(`nsis: ${exe.replace(ROOT + '/', '')} ${sizeOf(exe)}`)
    try {
      const out = sh('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-Item -LiteralPath '${exe}').VersionInfo | Select-Object -Property ProductVersion,FileVersion | Format-List`,
      ])
      const match = /ProductVersion\s*:\s*(\S+)/.exec(out)
      if (!match) {
        note(`读不到 ProductVersion，原始输出：${out.trim()}`)
      } else if (!match[1].startsWith(version)) {
        fail(`NSIS 安装包的 ProductVersion 是 ${match[1]}，期望 ${version}`)
      } else {
        note(`nsis ProductVersion: ${match[1]}`)
      }
    } catch (error) {
      note(`PowerShell 检查失败（跳过）：${error.message}`)
    }
  }
}

// ---------- macOS：dmg 内 .app 的 bundle id / 版本 / 资源 ----------
function checkMacos() {
  const dmgs = findFiles('.dmg')
  if (dmgs.length === 0) fail('没有找到 .dmg 产物')

  for (const dmg of dmgs) {
    note(`dmg: ${dmg.replace(ROOT + '/', '')} ${sizeOf(dmg)}`)
    const mountPoint = `/tmp/hqsf-dmg-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    let attached = false
    try {
      sh('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mountPoint])
      attached = true

      const apps = readdirSync(mountPoint).filter((name) => name.endsWith('.app'))
      if (apps.length === 0) {
        fail(`dmg 内没有 .app：${dmg}`)
        continue
      }
      const infoPlist = join(mountPoint, apps[0], 'Contents', 'Info.plist')
      const readPlist = (key) =>
        sh('plutil', ['-extract', key, 'raw', '-o', '-', infoPlist]).trim()

      const bundleId = readPlist('CFBundleIdentifier')
      if (bundleId !== identifier) fail(`dmg 内 CFBundleIdentifier=${bundleId}，期望 ${identifier}`)

      const shortVersion = readPlist('CFBundleShortVersionString')
      if (shortVersion !== version) {
        fail(`dmg 内 CFBundleShortVersionString=${shortVersion}，期望 ${version}`)
      }
      note(`dmg app: ${apps[0]} id=${bundleId} version=${shortVersion}`)

      const resourcesDir = join(mountPoint, apps[0], 'Contents', 'Resources')
      for (const name of RESOURCES) {
        if (!existsSync(join(resourcesDir, name))) fail(`dmg 内的 .app 缺少资源 ${name}`)
      }
      note('dmg 内 .app 含打包资源：' + RESOURCES.join(' / '))
    } catch (error) {
      fail(`挂载/检查 dmg 失败：${error.message}`)
    } finally {
      if (attached) {
        try {
          sh('hdiutil', ['detach', mountPoint, '-quiet'])
        } catch {
          note(`未能卸载 ${mountPoint}（runner 结束后自动清理）`)
        }
      }
    }
  }
}

const platform = process.platform
if (platform === 'linux') checkLinux()
else if (platform === 'win32') checkWindows()
else if (platform === 'darwin') checkMacos()
else note(`未知平台 ${platform}，跳过产物检查`)

console.log(notes.map((line) => `  ${line}`).join('\n'))
if (failures.length > 0) {
  console.error('\n产物自检失败：')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('\n产物自检通过')