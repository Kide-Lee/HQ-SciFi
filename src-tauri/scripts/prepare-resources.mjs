#!/usr/bin/env node
// 把 1.x 打包时用 electron-builder `extraResources` 拷进资源目录的三个文件，
// 预先拷到 `src-tauri/resources/`，供 tauri.conf.json 的 `bundle.resources` 映射。
//
// 迁移来源：`electron-builder.yml`
//   extraResources:
//     - from: api.config.json   to: api.config.json
//     - from: doc/用户协议.md    to: agreement.md
//     - from: doc/CHANGELOG.md  to: changelog.md
//
// 与 Electron 的差异：
//   - electron-builder 在**打包时**才拷贝；Tauri 的 `bundle.resources` 也是打包时映射，
//     但 `tauri.conf.json` 里写的是相对 `src-tauri/` 的源路径，所以需要先把文件放到
//     `src-tauri/resources/`（本脚本负责），否则 `cargo tauri build` 会因源文件缺失失败。
//   - `api.config.json` 含真实接口地址，**不入库**（根 `.gitignore` 已忽略；这里同样忽略
//     `src-tauri/resources/api.config.json`），所以发布机构建前必须跑一次本脚本。
//
// 用法：
//   node src-tauri/scripts/prepare-resources.mjs           # 拷贝（缺失的源文件只警告）
//   node src-tauri/scripts/prepare-resources.mjs --check   # 只检查，不写；缺文件时退出码 1

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const targetDir = join(here, '..', 'resources');
const checkOnly = process.argv.slice(2).includes('--check');

/** 源文件（相对仓库根）→ 目标文件名（`resources/` 下，与 tauri.conf.json 的映射一致）。 */
const mapping = [
  { from: 'api.config.json', to: 'api.config.json', required: true },
  { from: 'doc/用户协议.md', to: 'agreement.md', required: true },
  { from: 'doc/CHANGELOG.md', to: 'changelog.md', required: true },
];

if (!checkOnly) mkdirSync(targetDir, { recursive: true });

let missing = 0;
for (const item of mapping) {
  const source = join(repoRoot, item.from);
  const target = join(targetDir, item.to);
  if (!existsSync(source)) {
    missing += 1;
    const level = item.required ? '错误' : '警告';
    console.error(`[resources] ${level}：源文件不存在 ${item.from}（目标 ${item.to} 不会生成）`);
    continue;
  }
  if (checkOnly) {
    console.error(`[resources] OK ${item.from} → resources/${item.to}`);
    continue;
  }
  copyFileSync(source, target);
  console.error(`[resources] 已拷贝 ${item.from} → resources/${item.to}`);
}

if (missing > 0) {
  console.error(`[resources] 共 ${missing} 个源文件缺失；打包前补齐（api.config.json 本地持有、不入库）`);
  process.exit(checkOnly ? 1 : 0);
}
console.error('[resources] 资源就绪');
