/**
 * v0.0.6：楷体 mark 的 md 序列化标签（三端共用：milkdown 编辑器 / 渲染层预览 / 主进程上传转换）。
 * markdown-it 对这两个标签白名单放行，其余 HTML 一律转义（防注入）。
 */
export const KAITI_OPEN = '<span class="kaiti">'
export const KAITI_CLOSE = '</span>'
