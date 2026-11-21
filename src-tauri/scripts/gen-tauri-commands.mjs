#!/usr/bin/env node
// 生成器（脚本入库，生成物 gitignored）：
//   读 `src-tauri/testdata/contracts/commands.json`（85 条冻结通道）
//   + 扫 `crates/hqsf-core/src/commands/<module>.rs` 的 `pub fn` 签名与 `*Args` 结构体字段
//   → 输出 `src-tauri/src/commands_generated.rs` 的 85 个 `#[tauri::command] async fn`
//     （`dispatch.rs` 保留 HqsfError/HqsfResult/WholePayload/内部命令这些手写部分，
//      生成物单独成文件，这样重跑生成器不会覆盖手写代码）。
//
// 迁移来源：`src/main/ipc/index.ts`（85 个 ipcMain.handle 注册）+ `src/preload/index.ts`
// （85 个 invoke 白名单）。1.x 每个 handler 手写「take ctx → parse args → call service」，
// v2 里这一层退化成「反序列化入参 → 调 core 函数 → map_err(HqsfError)」，可以生成。
//
// 与 Electron 的差异：
//   - 通道名 `hqsf:x`（1.x）→ Tauri command 名 `x` 的 snake_case（`rustCommand` 字段已给）。
//   - 失败从「返回值里的信封」变成「Promise reject + {ok:false,error}」；本脚本只生成
//     命令函数，信封与 `hqsf:*` → 命令名的映射表由 `src/bridge/`（已落地）使用。
//
// 用法：
//   node src-tauri/scripts/gen-tauri-commands.mjs            # 只打印统计 + 未解析清单（dry run）
//   node src-tauri/scripts/gen-tauri-commands.mjs --report   # 列出「能生成」的通道与每条 MANUAL 原因
//   node src-tauri/scripts/gen-tauri-commands.mjs --emit     # 把生成的 rust 打到 stdout（不落盘）
//   node src-tauri/scripts/gen-tauri-commands.mjs --write    # 写 src-tauri/src/commands_generated.rs
//   node src-tauri/scripts/gen-tauri-commands.mjs --map      # 额外打印 channel→command 映射
//   node src-tauri/scripts/gen-tauri-commands.mjs --verify   # 静态门禁（CI 用；不需要 cargo 编译）
//
// `--verify` 断言的内容（本机无 WebKitGTK，cargo 编译只能交给 CI 的 shell job）：
//   1. 契约 85 条 invoke 通道，每条**恰好**生成一次（无遗漏、无重复、无多余）；
//   2. 生成的每个函数名 === 契约 `rustCommand`，且带 `#[tauri::command]` + `pub async fn`；
//   3. 每个通道的 wire 参数名与 `src/bridge/index.ts` 的 `ARG_NAMES` 语义一致：
//      - 平铺形态：契约 `params[i].name` === core 形参名的 lowerCamelCase（tauri 命令默认
//        `rename_all = "camelCase"`，见 tauri-macros `WrapperAttributes::argument_case`）；
//      - 整包形态：契约 `params` 的每个名字都能在 core `*Args` 结构体的 wire 字段里找到
//        （`#[serde(rename_all="camelCase")]` + `#[serde(rename="…")]` 都算）；
//   4. 无 MANUAL 残留 —— 例外必须显式列在下面的 `MANUAL_WHITELIST` 里并写明理由。
//
// 入参形状（与 `src/bridge/index.ts` 的 `argsFor()` 对齐）：渲染层按契约 `params` 的名字
// 把位置参数装成对象（`readLocalFile(path)` → `{path}`），因此命令的形参名必须对应契约
// `params[i].name`。tauri 命令的形参名默认按 lowerCamelCase 匹配（`dir_rel` → `dirRel`），
// 所以 `dirRel` / `oldRel` / `isDraft` / `filePath` / `reviewId` 这些契约名**不需要**额外的
// `rename_all` 属性，生成 `dir_rel: Option<String>` 即可。
//
// 两类 core 签名：
//   A. 平铺形参：`create_local_draft(ctx, title, content, dir_rel)` → 命令形参同名平铺；
//   B. `*Args` 整包：`add_comment(ctx, args: AddCommentArgs)` → 命令收
//      `args: WholePayload<AddCommentArgs>`（见 `dispatch.rs` 的 CommandArg 实现：忽略
//      tauri 的命名键，直接把整个 invoke 载荷反序列化成该结构体）。这样 1.x 的
//      `{type: …}` / `{payload: …}` / `{reviewId, type}` 等**带 Rust 关键字键**的载荷
//      也能逐字对上 core 结构体的 serde 字段名，不需要给命令参数起非法标识符。
//
// 壳层注入参数（不进渲染层入参）：`host: &HostInfo`（`crate::build_host_info(&app)`）、
// `docs_root`（内核 `infra::fs::docs_root(paths, db)`）、`exe_path: &Path`（`std::env::current_exe()`）、
// `store: &UpdateStateStore`（`AppState.updater`，进程内单例，跨 update-* 命令共享状态），
// 见 `shellInject()`。`hqsf:uninstall` 成功后额外 `app.exit(0)`（1.x `setImmediate(app.quit)`）。
//
// 设计约束（刻意保守）：
//   - 只解析「单行或多行的简单签名」，任何拿不准的形状都记为 MANUAL 并**不生成**该命令；
//   - 生成器**不允许**生成「通用转发命令」（通道名 + serde_json::Value 动态路由）：那会把 85 条
//     白名单塌缩成一个动态入口，违反迁移计划 §6.4 的安全不变式；
//   - 一律 `pub async fn`：async 命令由 tauri 用 `async_runtime::spawn` 派发到 tokio worker，
//     而同步命令在 IPC 回调里就地执行（Linux/GTK + macOS/WKWebView 的 URI scheme 回调就在
//     主线程），遇到阻塞式 dialog / 阻塞式 HTTP 会死锁或冻结 UI。见 dispatch.rs 顶部说明。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const contractPath = join(here, '..', 'testdata', 'contracts', 'commands.json');
const coreSrcDir = join(repoRoot, 'crates', 'hqsf-core', 'src');
const coreCommandsDir = join(coreSrcDir, 'commands');
const outPath = join(here, '..', 'src', 'commands_generated.rs');

/**
 * 允许残留的 MANUAL 白名单：channel → 理由。
 * 目标恒为空；任何新增都必须在这里显式登记，否则 `--verify` 失败（防止「生成器悄悄少生成」）。
 */
const MANUAL_WHITELIST = Object.freeze({});

const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const printMap = args.has('--map');
const report = args.has('--report');
const emit = args.has('--emit');
const verify = args.has('--verify');

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

/**
 * 解析 `pub struct <Name> { ... }` 的字段与 wire 字段名（serde rename / rename_all / skip）。
 * 只用于 `--verify` 与「整包反序列化」的可生成性判断，不生成字段访问代码。
 */
function parseStructFields(source, structName) {
  const needle = new RegExp(`pub\\s+struct\\s+${structName}\\s*\\{`, 'm');
  const match = needle.exec(source);
  if (!match) return null;

  // 结构体自身的 `#[serde(rename_all = "…")]`（在 derive 行之间的属性里找）。
  const headerStart = Math.max(0, match.index - 400);
  const header = source.slice(headerStart, match.index);
  const structRenameAll = /#\[serde\([^\]]*rename_all\s*=\s*"([^"]+)"/.exec(header);

  let index = match.index + match[0].length;
  let depth = 1;
  let body = '';
  while (index < source.length && depth > 0) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) break;
    body += ch;
    index += 1;
  }
  if (depth !== 0) return null;

  const fields = [];
  let pendingRename = null;
  let pendingSkip = false;
  let pendingCamelAll = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('#[serde(')) {
      const rename = /rename\s*=\s*"([^"]+)"/.exec(line);
      if (rename) pendingRename = rename[1];
      const camel = /rename_all\s*=\s*"([^"]+)"/.exec(line);
      if (camel) pendingCamelAll = camel[1];
      if (/skip\b/.test(line)) pendingSkip = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    const field = /^pub\s+([a-z_][A-Za-z0-9_]*)\s*:\s*(.+),?$/.exec(line);
    if (!field) continue;
    const [, name, type] = field;
    if (pendingSkip) {
      pendingRename = null;
      pendingSkip = false;
      continue;
    }
    const renameAll = pendingCamelAll ?? structRenameAll?.[1] ?? null;
    let wire = name;
    if (renameAll === 'camelCase') wire = toLowerCamel(name);
    else if (renameAll === 'snake_case') wire = toSnake(name);
    if (pendingRename) wire = pendingRename;
    pendingRename = null;
    fields.push({ name, wire, type: type.trim().replace(/,$/, '') });
  }
  return { fields };
}

/** `dir_rel` → `dirRel`（tauri 命令默认的形参名匹配规则）。 */
function toLowerCamel(ident) {
  const clean = ident.replace(/^r#/, '');
  return clean.replace(/_([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** `dirRel` → `dir_rel`（只用于核对，不生成）。 */
function toSnake(ident) {
  return ident.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

/** `-> CoreResult<T>` 解出 T；其它返回类型返回 null。 */
function coreResultInner(returns) {
  const match = /^CoreResult\s*<\s*(.+)\s*>$/.exec(returns.trim());
  return match ? match[1].trim() : null;
}

/**
 * 壳层注入参数：这些形参**不能**来自渲染层（契约里 `params` 为空或只覆盖其余参数），
 * 由壳层造好后传给 core。每条 = { prelude, value, extraArgs, needsState }。
 */
function shellInject(param) {
  const type = param.type.replace(/\s+/g, ' ');
  if (type === '&HostInfo') {
    return {
      prelude: 'let host = crate::build_host_info(&app);',
      value: '&host',
      extraArgs: ['app: tauri::AppHandle'],
      needsState: false,
    };
  }
  if (type === '&UpdateStateStore') {
    // 进程内单例：update-state / check / download / install 共享同一份状态（1.x 是模块级变量）。
    return { prelude: '', value: 'state.updater.as_ref()', extraArgs: [], needsState: true };
  }
  if (/^impl Into<.+>$/.test(type) && /docs/i.test(param.name)) {
    return {
      prelude:
        'let docs_root = hqsf_core::infra::fs::docs_root(&state.core.paths, &state.core.db)?.to_string_lossy().to_string();',
      value: 'docs_root',
      extraArgs: [],
      needsState: true,
    };
  }
  if (type === '&Path' && /exe/i.test(param.name)) {
    return {
      prelude:
        'let exe_path = std::env::current_exe()\n        .map_err(|e| CoreError::app(format!("无法定位当前可执行文件：{e}")))?;',
      value: '&exe_path',
      extraArgs: [],
      needsState: false,
    };
  }
  return null;
}

/**
 * 单个**平铺**入参映射：core 形参类型 → (命令入参类型, 调用实参)。
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
  // 引用到具体业务类型（`&ShowMessageBoxOptions` / `&HostInfo`）：命令收 owned，调用传引用。
  if (/^&[A-Z][A-Za-z0-9_]*$/.test(type)) return { argType: type.slice(1), value: `&${param.name}` };
  if (type === 'PathBuf') return { argType: 'PathBuf', value: param.name };
  if (type === '&PathBuf') return { argType: 'PathBuf', value: `&${param.name}` };
  if (/^impl Into<.+>$/.test(type)) return { argType: 'String', value: param.name };
  // 原始标量：直接作为命令入参（tauri 支持 serde 反序列化的任意类型）。
  if (/^(bool|u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64)$/.test(type)) {
    return { argType: type, value: param.name };
  }
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
  if (
    /^Option<.+>$/.test(type) ||
    /^(Vec|BTreeMap|HashMap|Value)<.+>$/.test(type) ||
    type === 'serde_json::Value'
  ) {
    return { argType: type, value: param.name };
  }
  // 具体业务类型（struct/enum/type 别名，首字母大写、无引用/泛型）：直接透传。
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
 * 类型名 → {module, kind, fields?} 索引。生成命令时返回/入参的业务类型必须 `use` 进来；
 * 「整包反序列化」还需要知道该类型是不是 struct 以及它的 wire 字段名。
 */
function collectCoreTypes() {
  const index = new Map();
  const duplicates = [];
  for (const file of collectCoreFiles(coreSrcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^pub\s+(struct|enum|type)\s+([A-Z][A-Za-z0-9_]*)/gm)) {
      const [, kind, name] = match;
      if (index.has(name)) {
        // 同名类型会让「按名字找 core 类型」的推断静默选错模块（曾发生：适配器层的
        // ArticleMeta 被当成 sync 命令入参的 domain::sync::ArticleMeta，编译期才报 E0308）。
        duplicates.push({ name, first: index.get(name).module, second: modulePathOf(file) });
        continue;
      }
      const entry = { module: modulePathOf(file), kind };
      if (kind === 'struct') {
        const parsed = parseStructFields(source, name);
        if (parsed) entry.fields = parsed.fields;
      }
      index.set(name, entry);
    }
  }
  index.duplicates = duplicates;
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
if (coreTypes.duplicates.length > 0) {
  console.error('[gen-tauri-commands] 内核存在同名公开类型，无法按名字推断参数类型：');
  for (const dup of coreTypes.duplicates) {
    console.error(`  - ${dup.name}：${dup.first} / ${dup.second}`);
  }
  console.error('请改名消除歧义（生成器按类型名匹配，重名会静默选错模块）。');
  process.exit(1);
}
const generated = [];
const manual = [];

function manualEntry(channel, fn, reason) {
  manual.push({ channel: channel.channel, fn, reason });
}

for (const channel of channels) {
  const module = channel.rustModule;
  const fnName = channel.rustCommand;
  const fnRef = `${module}::${fnName}`;
  const source = modules.get(module);
  if (!source) {
    manualEntry(channel, fnRef, `模块文件 commands/${module}.rs 不存在`);
    continue;
  }
  const parsed = parseFn(source, fnName);
  if (!parsed) {
    manualEntry(channel, fnRef, '在模块里找不到该 pub fn');
    continue;
  }

  const contractNames = Array.isArray(channel.params)
    ? channel.params.map((x) => (x && x.name) || String(x))
    : [];
  const contractCount = Array.isArray(channel.params) ? channel.params.length : -1;

  // 允许三种签名：`fn(ctx: &CoreCtx, ...)`（绝大多数）、`fn()`（ping）、
  // `fn(host: &HostInfo, ...)`（get_app_info —— 无 ctx，参数全部由壳层注入）。
  const hasCtx = parsed.params.length > 0 && parsed.params[0].type === '&CoreCtx';
  const rest = hasCtx ? parsed.params.slice(1) : parsed.params;

  // ---- 形态 B：单个 owned 的 `*Args` 结构体参数 → 整包反序列化 ----
  const usesWholePayload =
    rest.length === 1 &&
    /^[A-Z][A-Za-z0-9_]*$/.test(rest[0].type) &&
    coreTypes.get(rest[0].type)?.kind === 'struct' &&
    (coreTypes.get(rest[0].type)?.fields?.length ?? 0) > 0;

  if (usesWholePayload) {
    const structType = rest[0].type;
    const entry = coreTypes.get(structType);
    const wireFields = new Set((entry.fields ?? []).map((f) => f.wire));
    const missing = contractNames.filter((name) => !wireFields.has(name));
    if (missing.length > 0) {
      manualEntry(
        channel,
        fnRef,
        `整包结构体 ${structType} 的 wire 字段缺契约参数 ${JSON.stringify(missing)}（契约 ${JSON.stringify(
          contractNames,
        )}，结构体 ${JSON.stringify([...wireFields])}）`,
      );
      continue;
    }
    // 整包形态下，契约参数个数由结构体字段决定，不额外比个数（例如 AddCommentArgs 只有一个
    // `payload` 字段，而 `hqsf:add-comment` 的契约也只有 `payload`；多字段结构体则一一对应）。
    const usedTypes = new Set([structType]);
    const preludes = [];
    const extraArgs = [];
    let needsState = hasCtx;
    for (const param of rest) void param;
    // 整包形态没有逐个形参，壳层注入只可能来自「无 ctx 且要求 host/docs」的情形——那不属于 B，
    // 这里只需保证 ctx 注入。
    const callArgs = [...(hasCtx ? ['&state.core'] : []), 'args.0'].join(', ');
    const call = `hqsf_core::commands::${module}::${fnName}(${callArgs})`;
    const inner = coreResultInner(parsed.returns);
    const body = inner ? `${call}.map_err(HqsfError::from)` : `Ok(${call})`;
    const returnType = inner ? `HqsfResult<${inner}>` : `HqsfResult<${parsed.returns}>`;
    collectTypesInto(usedTypes, inner ?? parsed.returns);
    const finalBody = applyUninstallExit(channel, body);
    generated.push({
      channel: channel.channel,
      fnName,
      usedTypes: [...usedTypes],
      usesWholePayload: true,
      wholePayloadType: structType,
      wholePayloadWireFields: [...wireFields],
      contractParams: contractNames,
      rust: buildRust({
        channel,
        fnName,
        args: [
          ...(needsState ? ["state: State<'_, AppState>"] : []),
          ...extraArgs,
          `args: WholePayload<${structType}>`,
        ],
        returnType,
        preludes,
        body: finalBody,
      }),
    });
    continue;
  }

  // ---- 形态 A：平铺形参 ----
  const mapped = [];
  const preludes = [];
  const extraArgs = [];
  let needsState = hasCtx;
  let failed = null;
  for (const param of rest) {
    const injected = shellInject(param);
    if (injected) {
      if (injected.prelude) preludes.push(injected.prelude);
      extraArgs.push(...injected.extraArgs);
      needsState = needsState || injected.needsState;
      mapped.push({ name: param.name, argType: null, value: injected.value, injected: true });
      continue;
    }
    const result = mapParam(param);
    if (!result) {
      failed = `参数 ${param.name}: ${param.type} 无自动映射`;
      break;
    }
    mapped.push({ name: param.name, ...result, injected: false });
  }
  if (failed) {
    manualEntry(channel, fnRef, failed);
    continue;
  }

  const rendererParams = mapped.filter((m) => !m.injected);
  if (contractCount !== rendererParams.length) {
    manualEntry(
      channel,
      fnRef,
      `契约 params(${contractCount}) 与 core 非注入参数(${rendererParams.length}: ${rendererParams
        .map((m) => m.name)
        .join(',')}) 不一致`,
    );
    continue;
  }
  // 形参名必须对应契约参数名：tauri 命令默认把 Rust 形参名转 lowerCamelCase 后匹配 JSON 键，
  // 名字对不上就是「渲染层发 {dirRel}、命令等 {dir_rel} 之外的键」→ 运行时 missing key。
  const nameMismatch = rendererParams.find((m, i) => contractNames[i] !== toLowerCamel(m.name));
  if (nameMismatch) {
    manualEntry(
      channel,
      fnRef,
      `core 形参 ${nameMismatch.name} → wire ${toLowerCamel(nameMismatch.name)}，与契约参数名 ${JSON.stringify(
        contractNames,
      )} 不一致`,
    );
    continue;
  }

  const inner = coreResultInner(parsed.returns);
  const callArgs = [...(hasCtx ? ['&state.core'] : []), ...mapped.map((m) => m.value)].join(', ');
  const call = `hqsf_core::commands::${module}::${fnName}(${callArgs})`;
  const body = inner ? `${call}.map_err(HqsfError::from)` : `Ok(${call})`;
  const returnType = inner ? `HqsfResult<${inner}>` : `HqsfResult<${parsed.returns}>`;

  const usedTypes = new Set();
  collectTypesInto(usedTypes, inner ?? parsed.returns);
  for (const m of rendererParams) collectTypesInto(usedTypes, m.argType);
  const finalBody = applyUninstallExit(channel, body);
  generated.push({
    channel: channel.channel,
    fnName,
    usedTypes: [...usedTypes],
    usesWholePayload: false,
    paramNames: rendererParams.map((m) => m.name),
    contractParams: contractNames,
    rust: buildRust({
      channel,
      fnName,
      args: [
        ...(needsState ? ["state: State<'_, AppState>"] : []),
        ...extraArgs,
        ...rendererParams.map((m) => `${m.name}: ${m.argType}`),
      ],
      returnType,
      preludes,
      body: finalBody,
    }),
  });
}

/** 记录一段类型文本里出现的 core 业务类型（供 banner 生成 `use`）。 */
function collectTypesInto(target, text) {
  const primitives = new Set([
    'String',
    'str',
    'bool',
    'i8',
    'i16',
    'i32',
    'i64',
    'isize',
    'u8',
    'u16',
    'u32',
    'u64',
    'usize',
    'f32',
    'f64',
    'PathBuf',
    'Value',
    'Vec',
    'Option',
    'BTreeMap',
    'HashMap',
    'Result',
    'Cow',
  ]);
  for (const m of String(text).matchAll(/[A-Z][A-Za-z0-9_]*/g)) {
    if (!primitives.has(m[0]) && coreTypes.has(m[0])) target.add(m[0]);
  }
}

/** 1.x `uninstall` 成功后立刻退出（`setImmediate(app.quit)`），普通模板没有这个后处理。 */
function applyUninstallExit(channel, body) {
  if (channel.channel !== 'hqsf:uninstall') return body;
  return [
    `    let result = ${body};`,
    '    // 1.x `setImmediate(app.quit)`：卸载器已在后台接管，主进程退出；失败时保持运行以便展示错误。',
    '    if result.is_ok() {',
    '        app.exit(0);',
    '    }',
    '    result',
  ].join('\n');
}

/** 单个命令的 rust 文本。 */
function buildRust({ channel, fnName, args, returnType, preludes, body }) {
  const lines = [
    `/// \`${channel.channel}\`（lane ${channel.lane}；1.x ${channel.handler}）`,
    // 形参名按 lowerCamelCase 匹配 JS 键：桥接层（`src/bridge/index.ts` 的 `ARG_NAMES`）发的就是
    // 契约里的 camelCase 名（`dirRel`/`oldRel`/`newRel`/`reviewId`/`chatId`…）。tauri-macros 的默认
    // 值本来就是 Camel，这里显式写出，避免默认值变化时静默错位。
    '#[tauri::command(rename_all = "camelCase")]',
    `pub async fn ${fnName}(${args.join(', ')}) -> ${returnType} {`,
    ...preludes.map((line) => `    ${line}`),
  ];
  if (body.startsWith('    ')) lines.push(...body.split('\n'));
  else lines.push(`    ${body}`);
  lines.push('}');
  return lines.join('\n');
}

/** 用 rustfmt 规整生成物（没有 rustfmt 时原样返回，`--verify` 两侧同样处理，保持一致）。 */
function formatRust(source) {
  const tmp = join(dirname(outPath), '.commands_generated.fmt.rs');
  try {
    writeFileSync(tmp, source, 'utf8');
    const result = spawnSync('rustfmt', ['--edition', '2024', tmp], { stdio: 'ignore' });
    if (result.status === 0) return readFileSync(tmp, 'utf8');
  } catch {
    // 忽略：格式化是锦上添花，不能阻断生成。
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没建出来。
    }
  }
  return source;
}

function buildFile() {
  const needsWholePayload = generated.some((g) => g.usesWholePayload);
  const needsState = generated.some((g) => g.rust.includes("state: State<'_, AppState>"));
  const needsAppHandle = generated.some((g) => g.rust.includes('app: tauri::AppHandle'));
  const needsCoreError = generated.some((g) => g.rust.includes('CoreError::app'));
  const needsPathBuf = generated.some((g) => g.rust.includes('PathBuf'));

  const typeImports = [...new Set(generated.flatMap((g) => g.usedTypes))]
    .filter((name) => coreTypes.has(name))
    .map((name) => [name, coreTypes.get(name).module])
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([name, module]) => `use ${module}::${name};`);

  const banner = [
    '//! **自动生成，请勿手改**：`node src-tauri/scripts/gen-tauri-commands.mjs --write`。',
    '//!',
    '//! 契约：`crates/hqsf-core/src/commands/registry.rs`（COMMANDS，85 条）+',
    '//! `src-tauri/testdata/contracts/commands.json`；参数整形见 `src/bridge/index.ts`。',
    '',
    '#![allow(clippy::unused_async)]',
    '',
    ...(needsPathBuf ? ['use std::path::PathBuf;', ''] : []),
    ...(needsCoreError ? ['use hqsf_core::error::CoreError;'] : []),
    ...(needsState ? ['use tauri::State;'] : []),
    '',
    ...(needsState || needsWholePayload ? ['use crate::AppState;'] : []),
    ...(needsWholePayload ? ['use crate::dispatch::WholePayload;'] : []),
    ...(needsState || needsWholePayload ? [''] : []),
    'pub use crate::dispatch::{HqsfError, HqsfResult};',
    '',
    ...typeImports,
    '',
    '',
  ].join('\n');
  const handlerNames = [
    ...generated.map((g) => g.fnName),
    // 页面内 Ctrl+F12 的接收端（手写在 dispatch.rs，不是契约通道）。
    'crate::dispatch::__hqsf_toggle_devtools',
  ];
  const register = [
    '',
    '/// 把 85 条命令 + 壳层内部命令注册到 `Builder`（`lib.rs::run` 调用）。',
    '///',
    '/// `tauri::generate_handler!` 是编译期静态展开：85 个命令名全部确定，不存在',
    '/// 「按通道名动态路由」的入口（迁移计划 §6.4 禁止通用代理命令）。',
    'pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {',
    '    builder.invoke_handler(tauri::generate_handler![',
    ...handlerNames.map((name) => `        ${name},`),
    '    ])',
    '}',
    '',
  ].join('\n');
  return formatRust(`${banner}${generated.map((g) => g.rust).join('\n\n')}\n${register}`);
}

// ---------------------------------------------------------------------------
// --verify：不编译也能查的静态门禁
// ---------------------------------------------------------------------------
if (verify) {
  const problems = [];
  // 注意：`file` 必须在下面用到之前定义（此前写法是引用后才 const，会抛 TDZ）。
  const file = buildFile();
  const seen = new Set();
  const fnSeen = new Set();

  if (channels.length !== 85) problems.push(`契约 invoke 通道应为 85 条，实际 ${channels.length} 条`);

  for (const item of generated) {
    if (seen.has(item.channel)) problems.push(`通道重复生成：${item.channel}`);
    seen.add(item.channel);
    if (fnSeen.has(item.fnName)) problems.push(`命令名重复：${item.fnName}`);
    fnSeen.add(item.fnName);
    const channel = channels.find((c) => c.channel === item.channel);
    if (!channel) problems.push(`生成了契约里没有的通道：${item.channel}`);
    else if (channel.rustCommand !== item.fnName) {
      problems.push(`${item.channel} 命令名 ${item.fnName} ≠ 契约 ${channel.rustCommand}`);
    }
    if (!item.rust.includes('#[tauri::command(')) problems.push(`${item.channel} 缺 #[tauri::command(...)]`);
    if (!item.rust.includes('pub async fn')) problems.push(`${item.channel} 不是 pub async fn`);
  }

  for (const item of manual) {
    if (seen.has(item.channel)) problems.push(`通道既生成又 MANUAL：${item.channel}`);
    if (!(item.channel in MANUAL_WHITELIST)) {
      problems.push(`MANUAL 未登记白名单：${item.channel}（${item.reason}）`);
    }
  }

  if (!file.includes('pub fn register(builder: tauri::Builder<tauri::Wry>)')) {
    problems.push('生成文件缺 register()（lib.rs 用它注册 invoke_handler）');
  }
  for (const item of generated) {
    if (!file.includes(`        ${item.fnName},`)) {
      problems.push(`${item.channel} 未出现在 register() 的命令列表里`);
    }
  }
  if (!file.includes('        crate::dispatch::__hqsf_toggle_devtools,')) {
    problems.push('register() 缺内部命令 __hqsf_toggle_devtools');
  }

  for (const channel of channels) {
    if (!seen.has(channel.channel) && !manual.some((m) => m.channel === channel.channel)) {
      problems.push(`通道既未生成也未记 MANUAL：${channel.channel}`);
    }
  }

  // ---- 契约仿真校验（纯 Node，不编译 Rust）：JS 发来的 camelCase 键必须能命中形参 ----
  // 仿真规则来自 tauri-macros 2.5 的 `CommandArg::from_command`：形参名会经
  // `to_lower_camel_case()` 变成 JSON 键。所以「契约参数名」必须等于「形参名 lowerCamel」。
  for (const item of generated) {
    const channel = channels.find((c) => c.channel === item.channel);
    if (!channel) continue;
    const contractNames = (channel.params || []).map((x) => (x && x.name) || String(x));
    if (!item.rust.includes('#[tauri::command(rename_all = "camelCase")]')) {
      problems.push(`${item.channel} 缺 rename_all = "camelCase"（形参会按 snake_case 找键）`);
    }
    if (item.usesWholePayload) {
      // 整包：整个载荷交给 serde，能接收的键 = 结构体的 wire 字段集合，必须 ⊇ 契约参数名。
      const wire = new Set(item.wholePayloadWireFields || []);
      const missing = contractNames.filter((name) => !wire.has(name));
      if (missing.length > 0) {
        problems.push(
          `${item.channel} 的 WholePayload<${item.wholePayloadType}> 缺契约参数 ${JSON.stringify(
            missing,
          )}（结构体 wire 字段 ${JSON.stringify([...wire])}）`,
        );
      }
    } else {
      const wire = (item.paramNames || []).map(toLowerCamel);
      if (wire.length !== contractNames.length || wire.some((name, i) => name !== contractNames[i])) {
        problems.push(
          `${item.channel} 形参 ${JSON.stringify(item.paramNames)} → wire ${JSON.stringify(
            wire,
          )}，与契约参数 ${JSON.stringify(contractNames)} 不一致`,
        );
      }
    }
  }

  if (existsSync(outPath)) {
    const current = readFileSync(outPath, 'utf8');
    if (current !== file) {
      problems.push(
        `${outPath} 与生成器输出不一致（漂移）——重跑 --write；若产物本不该入库，请从工作区删除`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`[gen] --verify 失败（${problems.length} 项）：`);
    for (const problem of problems) console.error(`[gen]   ✗ ${problem}`);
    process.exit(1);
  }
  console.error(
    `[gen] --verify 通过：${generated.length}/${channels.length} 条通道各生成一次，` +
      `MANUAL ${manual.length} 条（白名单 ${Object.keys(MANUAL_WHITELIST).length} 条）`,
  );
  process.exit(0);
}

if (emit) {
  // 调试用：把生成的文件打到 stdout（即使还有 MANUAL 也能看形态，不落盘）。
  console.log(buildFile());
}

if (report) {
  console.error(`[gen] 可自动生成 ${generated.length} 条：`);
  for (const g of generated) {
    console.error(`[gen] OK ${g.channel} → ${g.fnName}${g.usesWholePayload ? '（整包）' : ''}`);
  }
}

if (printMap) {
  const map = channels.map((c) => ({ channel: c.channel, command: c.rustCommand, module: c.rustModule }));
  console.log(JSON.stringify(map, null, 2));
}

console.error(`[gen] 契约通道 ${channels.length} 条；可生成 ${generated.length} 条；需人工 ${manual.length} 条`);
for (const item of manual) {
  console.error(`[gen] MANUAL ${item.channel} → ${item.fn}：${item.reason}`);
}

if (write) {
  if (manual.length > 0) {
    console.error('[gen] 仍有未解析通道，拒绝写入（避免提交半成品 commands_generated.rs）');
    process.exit(1);
  }
  writeFileSync(outPath, buildFile(), 'utf8');
  console.error(`[gen] 已写入 ${outPath}（${generated.length} 条命令）`);
} else {
  console.error('[gen] dry run：未写文件（加 --write 才写）');
}