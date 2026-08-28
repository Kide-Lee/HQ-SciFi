/**
 * 校验共享 IPC 契约、preload 调用与主进程 handler 的一致性。
 * 运行：node --experimental-strip-types scripts/test-ipc-contracts.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

const contractsSrc = readFileSync('src/shared/contracts/ipc.ts', 'utf8')
const preloadSrc = readFileSync('src/preload/index.ts', 'utf8')
const handlersSrc = []
for (const p of globSync('src/main/ipc/*.handlers.ts')) handlersSrc.push(readFileSync(p, 'utf8'))

function extractChannels(src, regex) {
  return [...new Set([...src.matchAll(regex)].map((m) => m[1]))]
}

const contractChannels = extractChannels(contractsSrc, /: '([^']+)'/g)
const invokeChannels = extractChannels(preloadSrc, /ipcRenderer\.invoke\('([^']+)'/g)
const onChannels = extractChannels(preloadSrc, /ipcRenderer\.on\('([^']+)'/g)
const handlerChannels = extractChannels(handlersSrc.join('\n'), /ipcMain\.handle\(\s*'([^']+)'/g)

// 契约应覆盖所有 invoke + 事件通道
assert.deepEqual(
  [...contractChannels].sort(),
  [...new Set([...invokeChannels, ...onChannels])].sort(),
  'shared contract channels should cover preload invoke + on'
)
// preload invoke 应与 handler 一一对应
assert.deepEqual([...invokeChannels].sort(), [...handlerChannels].sort(), 'preload invoke should match main handlers')
// handler 不能有未在 preload 暴露的 invoke 通道
assert.deepEqual([...handlerChannels].sort(), [...invokeChannels].sort(), 'main handlers should match preload invoke')

console.log(`ipc contracts passed: ${handlerChannels.length} handlers, ${invokeChannels.length} invoke, ${onChannels.length} events`)
