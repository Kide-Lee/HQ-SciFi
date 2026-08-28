/**
 * 历史入口：IPC handler 已按领域拆到 `src/main/ipc/`。
 * 本文件保留 `registerIpcHandlers` 名称，供现有启动流程调用。
 * 新代码请直接 import `registerAllIpcHandlers` from './ipc/index'。
 */
export { registerAllIpcHandlers as registerIpcHandlers } from './ipc/index'
