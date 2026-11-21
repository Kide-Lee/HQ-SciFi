#!/usr/bin/env node
// 生成器（脚本本身入库，**生成物先不提交**）：
//   读 `src-tauri/testdata/contracts/commands.json`（85 条冻结通道）
//   + 扫 `crates/hqsf-core/src/commands/<module>.rs` 的 `pub fn` 签名
//   → 输出 `src-tauri/src/commands_generated.rs` 的 85 个 `#[tauri::command] async fn`
//     （`dispatch.rs` 保留 HqsfError/HqsfResult/i内部命令这些手写部分，生成物单独成文件，
//      这样重跑生成器不会覆盖手写代码）。
//
// 迁移来源：`src/main/ipc/index.ts`（85 个 ipcMain.handle 注册）+ `src/preload/index.ts`
// （85 个 invoke 白名单）。1.x 每个 handler 手写「take ctx → parse args → call service」，
// v2 里这一层退化成「反序列化入参 → 调 core 函数 → map_err(HqsfError)」，可以生成。
//
// 与 Electron 的差异：
//   - 通道名 `hqsf:x`（1.x）→ Tauri command 名 `x` 的 snake_case（`rustCommand` 字段已给）。
//   - 失败从「返回值里的信封」变成「Promise reject + {ok:false,error}」；本脚本只生成
//     命令函数，信封与 `hqsf:*` → 命令名的映射表由 preload 等价层（下一张卡）使用。
//
// 用法：
//   node src-tauri/scripts/gen-tauri-commands.mjs            # 只打印统计 + 未解析清单（dry run）
//   node src-tauri/scripts/gen-tauri-commands.mjs --report   # 列出「能生成」的通道
//   node src-tauri/scripts/gen-tauri-commands.mjs --emit     # 把生成的 rust 打到 stdout（不落盘）
//   node src-tauri/scripts/gen-tauri-commands.mjs --write    # 写 src-tauri/src/commands_generated.rs
//   node src-tauri/scripts/gen-tauri-commands.mjs --map      # 额外打印 channel→command 映射
//
// 入参形状（与 `src/bridge/index.ts` 的 `argsFor()` 对齐）：渲染层按契约 `params` 的名字
// 把位置参数装成对象（`readLocalFile(path)` → `{path}`、`showMessageBox(options)` → `{options}`），
// 因此命令的形参名必须等于契约 `params[i].name`（camelCase 的形参名在 Rust 里非法 → 下一张卡用
// `#[tauri::command(rename_all = "camelCase")]`，本脚本对这类参数直接记 MANUAL）。
//
// 壳层注入参数（不进渲染层入参）：`host: &HostInfo`（`crate::build_host_info(&app)`）、
// `docs_root`（内核 `infra::fs::docs_root(paths, db)`）、`exe_path: &Path`（`std::env::current_exe()`），
// 见 `shellInject()`。`hqsf:uninstall` 成功后额外 `app.exit(0)`（1.x `setImmediate(app.quit)`）。
//
// 设计约束（刻意保守）：
//   - 只解析「单行或多行的简单签名」，任何拿不准的形状（`impl Into<T>` 之外的泛型、`&Option<&Path>`、
//     多个 ctx 参数、core 用参数结构体 `*Args`/`*Options` 吃掉多个渲染层参数）都记为 MANUAL 并
//     **不生成**该命令，让下一张卡人工补；
//   - 生成器**不允许**生成「通用转发命令」（通道名 + serde_json::Value 动态路由）：那会把 85 条
//     白名单塌缩成一个动态入口，违反迁移计划 §6.4 的安全不变式。

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const contractPath = join(here, '..', 'testdata', 'contracts', 'commands.json');
const coreSrcDir = join(repoRoot, 'crates', 'hqsf-core', 'src');
const coreCommandsDir = join(coreSrcDir, 'commands');
const outPath = join(here, '..', 'src', 'commands_generated.rs');

const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const printMap = args.has('--map');
const report = args.has('--report');
const emit = args.has('--emit');

/** 契约里的 params 是 [{name,type}]，用于交叉校验 core 签名。 */
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const channels = (contract.channels ?? []).filter((c) => c.kind === 'invoke');

/** 把 `a: X, b: Y` 按顶层逗号切开（忽略 <> () [] {} 与字符串内的逗号）。 */
function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (const ch of input) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ('<([{'.includes(ch)) depth += 1;
    if ('>)]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** 在模块源码里找 `pub fn <name>(`，返回 { params: [{name,type}], returns } 或 null。 */
function parseFn(source, fnName) {
  const needle = new RegExp(`pub\\s+fn\\s+${fnName}\\s*\\(`, 'm');
  const match = needle.exec(source);
  if (!match) return null;

  let index = match.index + match[0].length;
  let depth = 1;
  let raw = '';
  while (index < source.length && depth > 0) {
    const ch = source[index];
    if ('<([{'.includes(ch)) depth += 1;
    if ('>)]}'.includes(ch)) depth -= 1;
    if (depth === 0) break;
    raw += ch;
    index += 1;
  }
  if (depth !== 0) return null;

  const rest = source.slice(index + 1);
  const returnsMatch = /^\s*->\s*([^{]+)\{/.exec(rest);
  const returns = returnsMatch ? returnsMatch[1].trim() : '()';

  const params = splitTopLevel(raw)
    .filter(Boolean)
    .map((param) => {
      const colon = param.indexOf(':');
      if (colon < 0) return { name: param.trim(), type: '', malformed: true };
      return {
        name: param.slice(0, colon).trim().replace(/^mut\s+/, ''),
        type: param.slice(colon + 1).trim(),
      };
    });

  return { params, returns };
}

/** `-> CoreResult<T>` 解出 T；其它返回类型返回 null。 */
function coreResultInner(returns) {
  const match = /^CoreResult\s*<\s*(.+)\s*>$/.exec(returns.trim());
  return match ? match[1].trim() : null;
}

/**
 * 壳层注入参数：这些形参**不能**来自渲染层（契约里 `params` 为空），由壳层造好后传给 core。
 * 每条 = { prelude: 生成的准备语句, value: 调用时传的表达式, extraArgs: 额外注入的命令参数 }。
 *
 * - `host: &HostInfo`：宿主事实（platform/arch/app_version/packaged/isAppImage），
 *   由 `crate::build_host_info(&app)` 现算；`app: tauri::AppHandle` 由 tauri 注入。
 * - `docs_root`：文档根由内核 `infra::fs::docs_root(paths, db)` 决定（含 meta 覆盖），
 *   壳层只负责把它算成 String 传进去 —— 壳层不自己拼 `documents/荒启科幻/草稿`。
 * - `exe_path: &Path`：卸载要重启的卸载器路径，来自 `std::env::current_exe()`。
 */
function shellInject(param) {
  const type = param.type.replace(/\s+/g, ' ');
  if (type === '&HostInfo') {
    return {
      prelude: 'let host = crate::build_host_info(&app);',
      value: '&host',
      extraArgs: ['app: tauri::AppHandle'],
    };
  }
  if (/^impl Into<.+>$/.test(type) && /docs/i.test(param.name)) {
    return {
      prelude:
        'let docs_root = hqsf_core::infra::fs::docs_root(&state.core.paths, &state.core.db)?.to_string_lossy().to_string();',
      value: 'docs_root',
      extraArgs: [],
    };
  }
  if (type === '&Path' && /exe/i.test(param.name)) {
    return {
      prelude:
        'let exe_path = std::env::current_exe()\n        .map_err(|e| CoreError::app(format!("无法定位当前可执行文件：{e}")))?;',
      value: '&exe_path',
      extraArgs: [],
    };
  }
  return null;
}

/**
 * 单个入参映射：core 形参类型 → (命令入参类型, 调用实参)。
 * 返回 null 表示「拿不准，交给人工」。
 */
function mapParam(param) {
  const type = param.type.replace(/\s+/g, ' ');
  if (type === '&CoreCtx') return null; // ctx 单独处理
  if (type === '&str') return { argType: 'String', value: `&${param.name}` };
  if (type === 'String') return { argType: 'String', value: param.name };
  if (type === '&String') return { argType: 'String', value: `&${param.name}` };
  if (type === '&Path') return { argType: 'PathBuf', value: `&${param.name}` };
  // 切片：`&[T]` → `Vec<T>`（Tauri 反序列化数组到 Vec，再传切片）。
  const slice = /^&\[\s*(.+?)\s*\]$/.exec(type);
  if (slice) return { argType: `Vec<${slice[1]}>`, value: `&${param.name}` };
  // 引用到具体业务类型（`&HostInfo` / `&ShowMessageBoxOptions`）：命令收 owned，调用传引用。
  if (/^&[A-Z][A-Za-z0-9_]*$/.test(type)) return { argType: type.slice(1), value: `&${param.name}` };
  if (type === 'PathBuf') return { argType: 'PathBuf', value: param.name };
  if (type === '&PathBuf') return { argType: 'PathBuf', value: `&${param.name}` };
  if (/^impl Into<.+>$/.test(type)) return { argType: 'String', value: param.name };
  if (/^Option<&str>$/.test(type)) return { argType: 'Option<String>', value: `${param.name}.as_deref()` };
  if (/^Option<String>$/.test(type)) return { argType: 'Option<String>', value: param.name };
  if (/^Option<&Path>$/.test(type)) {
    return { argType: 'Option<PathBuf>', value: `${param.name}.as_deref()` };
  }
  if (/^Option<PathBuf>$/.test(type)) return { argType: 'Option<PathBuf>', value: param.name };
  if (type === '&serde_json::Value') {
    // `update_settings(ctx, patch: &Value)`：命令收 owned 的 Value 透传给 core（不反序列化成结构体，
    // 否则 1.x 的运行时校验语义会丢）。渲染层字段名仍是 `patch`。
    return { argType: 'serde_json::Value', value: `&${param.name}` };
  }
  if (/^Option<.+>$/.test(type) || /^(Vec|BTreeMap|HashMap|Value)<.+>$/.test(type) || type === 'serde_json::Value') {
    return { argType: type, value: param.name };
  }
  // 具体业务类型（struct/enum 名，首字母大写、无引用/泛型）：直接透传。
  if (/^[A-Z][A-Za-z0-9_]*$/.test(type)) return { argType: type, value: param.name };
  return null;
}

/** 递归列出 `crates/hqsf-core/src` 下的 .rs 文件。 */
function collectCoreFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCoreFiles(full));
    else if (entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

/** 由文件路径推出 `hqsf_core::…` 模块路径（`lib.rs`→根，`mod.rs`→目录，其余→文件名）。 */
function modulePathOf(file) {
  const rel = file.slice(coreSrcDir.length + 1).replace(/\.rs$/, '');
  const parts = rel.split(/[\\/]/);
  const last = parts[parts.length - 1];
  if (last === 'lib') return 'hqsf_core';
  if (last === 'mod') parts.pop();
  return ['hqsf_core', ...parts].join('::');
}

/**
 * 类型名 → 模块路径索引。生成命令时返回/入参的业务类型必须 `use` 进来，否则
 * `commands_generated.rs` 缺 `use`（`--write` 后直接编译失败）。
 * 只认 `pub struct|enum|type <Name>` 的声明所在文件；同名类型取第一个（core 无重名约定）。
 */
function collectCoreTypes() {
  const index = new Map();
  for (const file of collectCoreFiles(coreSrcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^pub\s+(?:struct|enum|type)\s+([A-Z][A-Za-z0-9_]*)/gm)) {
      if (!index.has(match[1])) index.set(match[1], modulePathOf(file));
    }
  }
  return index;
}

function collectModules() {
  if (!existsSync(coreCommandsDir)) return new Map();
  const map = new Map();
  for (const file of readdirSync(coreCommandsDir)) {
    if (!file.endsWith('.rs')) continue;
    map.set(file.slice(0, -3), readFileSync(join(coreCommandsDir, file), 'utf8'));
  }
  return map;
}

const modules = collectModules();
const coreTypes = collectCoreTypes();
const generated = [];
const manual = [];

for (const channel of channels) {
  const module = channel.rustModule;
  const fnName = channel.rustCommand;
  const source = modules.get(module);
  if (!source) {
    manual.push({ channel: channel.channel, fn: `${module}::${fnName}`, reason: `模块文件 commands/${module}.rs 不存在` });
    continue;
  }
  const parsed = parseFn(source, fnName);
  if (!parsed) {
    manual.push({ channel: channel.channel, fn: `${module}::${fnName}`, reason: '在模块里找不到该 pub fn（lane 未实现）' });
    continue;
  }
  // 允许三种签名：`fn(ctx: &CoreCtx, ...)`（绝大多数）、`fn()`（ping）、
  // `fn(host: &HostInfo, ...)`（get_app_info —— 无 ctx，参数全部由壳层注入）。
  const hasCtx = parsed.params.length > 0 && parsed.params[0].type === '&CoreCtx';
  const rest = hasCtx ? parsed.params.slice(1) : parsed.params;
  const mapped = [];
  const preludes = [];
  const extraArgs = [];
  let failed = null;
  for (const param of rest) {
    const injected = shellInject(param);
    if (injected) {
      preludes.push(injected.prelude);
      extraArgs.push(...injected.extraArgs);
      mapped.push({ name: param.name, argType: null, value: injected.value, injected: true });
      continue;
    }
    const result = mapParam(param);
    if (!result) {
      // core 用「一个结构体吃掉所有渲染层参数」的写法（`LoginPasswordArgs` / `WriteLocalFileArgs`…）：
      // 命令层必须按契约 `params` 展开成平铺入参再构造结构体，生成器拿不到字段表 → 交给人工，
      // 原因里写清楚（下一卡可用 `commands.json` 的 params 名 + core 结构体字段对照生成）。
      if (/^(LoginPasswordArgs|.*Args|.*Options)$/.test(param.type)) {
        failed = `core 用参数结构体 ${param.type}（契约 ${JSON.stringify((channel.params || []).map((x) => (x && x.name) || x))}），需按契约展开后构造`;
      } else {
        failed = `参数 ${param.name}: ${param.type} 无自动映射`;
      }
      break;
    }
    mapped.push({ name: param.name, ...result });
  }
  if (failed) {
    manual.push({ channel: channel.channel, fn: `${module}::${fnName}`, reason: failed });
    continue;
  }

  // 交叉校验：契约声明的渲染层入参个数必须等于「非注入」参数个数，否则说明契约与 core 签名脱节
  // （典型：契约 params:[] 但 core 要 host，说明该参数应由壳层注入而生成器没认出来）。
  const rendererParams = mapped.filter((m) => !m.injected);
  const contractParamCount = Array.isArray(channel.params) ? channel.params.length : -1;
  if (contractParamCount !== rendererParams.length) {
    const structParam = rendererParams.find((m) => /^(.*Args|.*Options)$/.test(m.argType || ''));
    manual.push({
      channel: channel.channel,
      fn: `${module}::${fnName}`,
      reason: structParam
        ? `core 用参数结构体 ${structParam.argType}（契约 ${JSON.stringify(
            (channel.params || []).map((x) => (x && x.name) || x),
          )}），需按契约展开成平铺入参再构造结构体`
        : `契约 params(${contractParamCount}) 与 core 非注入参数(${rendererParams.length}: ${rendererParams
            .map((m) => m.name)
            .join(',')}) 不一致`,
    });
    continue;
  }

  // 形参名必须与契约参数名逐一对应：渲染层按 `params[i].name` 装对象键（`argsFor()`），
  // 名字对不上就等于「渲染层发 {path}、命令等 {args}」——运行时才报 missing key，静默且难查。
  // 典型冲突：core 用 `PathArgs`/`LoginPasswordArgs` 这类「一个结构体吃掉多个渲染层参数」的写法。
  const contractNames = Array.isArray(channel.params) ? channel.params.map((x) => (x && x.name) || String(x)) : [];
  const nameMismatch = rendererParams.find((m, i) => contractNames[i] !== undefined && contractNames[i] !== m.name);
  if (nameMismatch) {
    manual.push({
      channel: channel.channel,
      fn: `${module}::${fnName}`,
      reason: `core 形参名 ${nameMismatch.name} 与契约参数名 ${JSON.stringify(
        contractNames,
      )} 不一致（core 用 ${nameMismatch.argType} 结构体吃掉多个参数，需按契约展开后构造）`,
    });
    continue;
  }

  const inner = coreResultInner(parsed.returns);
  // 只有真正用到 ctx 的命令才注入 `state`（`ping` 这类无状态命令否则会报 unused_variables）。
  const needsState = hasCtx || preludes.some((line) => line.includes('state'));
  const args = [
    ...(needsState ? ["state: State<'_, AppState>"] : []),
    ...extraArgs,
    ...rendererParams.map((m) => `${m.name}: ${m.argType}`),
  ].join(', ');
  const callArgs = [...(hasCtx ? ['&state.core'] : []), ...mapped.map((m) => m.value)].join(', ');
  const call = `hqsf_core::commands::${module}::${fnName}(${callArgs})`;
  const body = inner ? `${call}.map_err(HqsfError::from)` : `Ok(${call})`;
  const returnType = inner ? `HqsfResult<${inner}>` : `HqsfResult<${parsed.returns}>`;

  // 记录本命令用到的业务类型（返回类型 + 非注入入参类型里的裸类型名），供 banner 生成 use。
  const usedTypes = new Set();
  const collectTypes = (text) => {
    const primitives = new Set(['String', 'str', 'bool', 'i32', 'i64', 'u16', 'u32', 'u64', 'f64', 'PathBuf', 'Value']);
    for (const m of String(text).matchAll(/[A-Z][A-Za-z0-9_]*/g)) {
      if (!primitives.has(m[0]) && coreTypes.has(m[0])) usedTypes.add(m[0]);
    }
  };
  collectTypes(inner ?? parsed.returns);
  for (const m of rendererParams) collectTypes(m.argType);

  generated.push({
    channel: channel.channel,
    fnName,
    usedTypes: [...usedTypes],
    rust: [
      `/// \`${channel.channel}\`（lane ${channel.lane}；1.x ${channel.handler}）`,
      `#[tauri::command]`,
      // 一律 async：async 命令由 tauri 用 `async_runtime::spawn` 派发到 tokio worker，
      // 而同步命令是在 IPC 回调里就地执行（Linux/GTK + macOS/WKWebView 的 URI scheme 回调
      // 就在主线程上），遇到阻塞式 dialog / 阻塞式 HTTP 会死锁或冻结 UI。见 dispatch.rs 顶部说明。
      `pub async fn ${fnName}(${args}) -> ${returnType} {`,
      ...preludes.map((line) => `    ${line}`),
      // `uninstall` 的 1.x 语义是「启动卸载器后立刻退出」（`setImmediate(app.quit)`），
      // 普通模板没有这个后处理，单独展开（下一卡生成时保留这段特例）。
      ...(channel.channel === 'hqsf:uninstall'
        ? [
            `    let result = ${body};`,
            `    // 1.x \`setImmediate(app.quit)\`：卸载器已在后台接管，主进程退出。`,
            `    app.exit(0);`,
            `    result`,
          ]
        : [`    ${body}`]),
      `}`,
    ].join('\n'),
  });
}

if (emit) {
  // 调试用：把生成的 rust 打到 stdout（即使还有 MANUAL 也能看形态，不落盘）。
  console.log(generated.map((g) => g.rust).join('\n\n'));
}

if (report) {
  console.error(`[gen] 可自动生成 ${generated.length} 条：`);
  for (const g of generated) console.error(`[gen] OK ${g.channel} → ${g.fnName}`);
}

if (printMap) {
  const map = channels.map((c) => ({ channel: c.channel, command: c.rustCommand, module: c.rustModule }));
  console.log(JSON.stringify(map, null, 2));
}

console.error(`[gen] 契约通道 ${channels.length} 条；可生成 ${generated.length} 条；需人工 ${manual.length} 条`);
for (const item of manual.slice(0, 20)) {
  console.error(`[gen] MANUAL ${item.channel} → ${item.fn}：${item.reason}`);
}
if (manual.length > 20) console.error(`[gen] ……其余 ${manual.length - 20} 条省略`);

if (write) {
  if (manual.length > 0) {
    console.error('[gen] 仍有未解析通道，拒绝写入（避免提交半成品 commands_generated.rs）');
    process.exit(1);
  }
  const typeImports = [...new Set(generated.flatMap((g) => g.usedTypes))]
    .map((name) => [name, coreTypes.get(name)])
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([name, module]) => `use ${module}::${name};`);

  const banner = [
    '//! **自动生成，请勿手改**：`node src-tauri/scripts/gen-tauri-commands.mjs --write`。',
    '//!',
    '//! 契约：`crates/hqsf-core/src/commands/registry.rs`（COMMANDS，85 条）+',
    '//! `src-tauri/testdata/contracts/commands.json`。',
    '',
    '#![allow(clippy::unused_async)]',
    '',
    'use std::path::PathBuf;',
    '',
    'use hqsf_core::error::CoreError;',
    'use tauri::State;',
    '',
    'use crate::AppState;',
    '',
    'pub use crate::dispatch::{HqsfError, HqsfResult};',
    '',
    ...typeImports,
    '',
  ].join('\n');
  writeFileSync(outPath, `${banner}${generated.map((g) => g.rust).join('\n\n')}\n`, 'utf8');
  console.error(`[gen] 已写入 ${outPath}（${generated.length} 条命令）`);
} else {
  console.error('[gen] dry run：未写文件（加 --write 才写）');
}