/**
 * 测试模式（本地 RuleApi 对接/联调）：`--test` 启动参数 或 环境变量 `HQSF_TEST=1`。
 *
 * 测试模式与正式使用完全隔离，避免本地测试数据污染线上环境：
 * - userData → `~/.config/hqsf-test`（数据库/session/设置独立，不再混入正式库）
 * - API 配置 → 优先 `api.config.test.json`（baseUrl 指向本地 RuleApi）
 * - 默认存档根 → `~/文档/荒启科幻/草稿-test`（本地测试文件不混入正式存档）
 */
export function isTestMode(): boolean {
  return process.argv.includes('--test') || process.env.HQSF_TEST === '1'
}
