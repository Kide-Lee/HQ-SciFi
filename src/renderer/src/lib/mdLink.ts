/**
 * v1.1.12：源码模式（Markdown 纯文本）里定位光标/右键位置下的链接。
 * 抽成纯函数便于回归测试（见 scripts/test-lib-rules.mjs）。
 */

export interface LineLinkHit {
  /** 链接地址 */
  href: string
  /** 行内起始偏移（含） */
  start: number
  /** 行内结束偏移（不含） */
  end: number
  /** 链接文字；裸 URL 为 null（用于「移除链接」时保留文字） */
  label: string | null
}

/** markdown 行内链接 `[文字](地址 "标题")` */
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
/** 裸 URL（自动链接/纯文本粘贴） */
const BARE_URL = /(https?:\/\/[^\s)>\]]+)/g

/** 在 text 中扫描 re 的所有命中，返回覆盖 offset 的那一个（offset 落在末尾也算命中） */
function scan(
  re: RegExp,
  text: string,
  offset: number,
  build: (m: RegExpExecArray) => { href: string; label: string | null }
): LineLinkHit | null {
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index
    const end = start + m[0].length
    if (offset < start || offset > end) continue
    return { ...build(m), start, end }
  }
  return null
}

/**
 * 查找一行文本中覆盖 offset 的链接。
 * markdown 链接优先——`[文字](地址)` 内部含 URL，不能被裸 URL 规则抢先命中。
 */
export function findLinkInLine(text: string, offset: number): LineLinkHit | null {
  const md = scan(MD_LINK, text, offset, (m) => ({ href: m[2], label: m[1] }))
  if (md) return md
  return scan(BARE_URL, text, offset, (m) => ({ href: m[1], label: null }))
}
