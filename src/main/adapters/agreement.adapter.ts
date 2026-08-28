import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mdToHtml } from '../infra/media/md2html'
import type { AgreementData } from '../../shared/types'

/**
 * 用户协议加载层：
 * 读取本应用协议（doc/用户协议.md，打包后为 resources/agreement.md），
 * 解析版本号并用 markdown-it 渲染为 HTML，经 IPC 下发渲染层展示。
 * 版本号用于渲染层比对本地「已同意版本」，协议更新后强制用户重新阅读并同意。
 *
 * 荒启平台协议已取消：不再从荒启官网抓取，也不再参与登录/设置流程。
 */

const VERSION_RE = /版本：\s*(v?\d[\d.]*)/

/** 协议文件候选路径：dev 读仓库 doc/；打包后读 resources/agreement.md（electron-builder extraResources 拷入） */
function agreementPaths(): string[] {
  const paths: string[] = [join(process.cwd(), 'doc', '用户协议.md')]
  if (process.resourcesPath) paths.push(join(process.resourcesPath, 'agreement.md'))
  return paths
}

/** 读取并渲染用户协议；文件缺失/版本号缺失时抛错（由 IPC 层包装为 ApiResult 失败） */
export function loadAgreement(): AgreementData {
  let file: string | null = null
  for (const p of agreementPaths()) {
    try {
      if (existsSync(p)) {
        file = p
        break
      }
    } catch {
      /* 尝试下一候选路径 */
    }
  }
  if (!file) {
    throw new Error(`未找到用户协议文件（已尝试: ${agreementPaths().join(', ')}）`)
  }
  const md = readFileSync(file, 'utf8')
  const versionMatch = md.match(VERSION_RE)
  if (!versionMatch) {
    throw new Error(`用户协议中未找到版本号（${file}，需在首部标注「版本：vX.Y」）`)
  }
  return { version: versionMatch[1], html: mdToHtml(md) }
}
