/**
 * 渲染层纯函数回归：活动阶段判定、分类禁用评分、评分颜色、源码模式链接定位与评审引用格式。
 */
import assert from 'node:assert/strict'
import { activityPhase, isActiveReviewing, cnNumToInt, sortActivities } from '../src/renderer/src/lib/activity.ts'
import { isReviewDisabledCategoryName, isReviewDisabledCategoryTitle, isReviewDisabledArticle } from '../src/renderer/src/lib/category.ts'
import { scoreColor } from '../src/renderer/src/lib/sanitize.ts'
import { findLinkInLine } from '../src/renderer/src/lib/mdLink.ts'
import { toQuoteLine } from '../src/renderer/src/lib/selection.ts'
import { h5ArticleUrl } from '../src/renderer/src/lib/articleUrl.ts'

assert.equal(activityPhase({ activeStatus: 1 }), 'ongoing')
assert.equal(activityPhase({ activeStatus: -1 }), 'reviewing')
assert.equal(activityPhase({ activeStatus: 0 }), 'ended')
assert.equal(isActiveReviewing({ activeStatus: 1 }), true)
assert.equal(isActiveReviewing({ activeStatus: 0 }), false)
assert.equal(cnNumToInt('二十'), 20)
assert.equal(cnNumToInt('二十三'), 23)
assert.deepEqual(sortActivities([{ name: '第二十三期' }, { name: '第二十四期' }, { name: '其他' }]).map((m) => m.name), ['第二十四期', '第二十三期', '其他'])

assert.equal(isReviewDisabledCategoryName('科幻杂谈'), true)
assert.equal(isReviewDisabledCategoryName('连载'), false)
assert.equal(isReviewDisabledCategoryTitle('作品库 · 官方公告'), true)
assert.equal(isReviewDisabledArticle({ category: [{ name: '外文翻译' }] }), true)
assert.equal(scoreColor('10'), 'hsl(300, 62%, 42%)')
assert.equal(scoreColor('-.-'), null)
assert.equal(scoreColor('0'), 'hsl(0, 62%, 42%)')

// v1.1.12：源码模式右键菜单的链接定位（markdown 链接优先于裸 URL；offset 落在范围内才算命中）
const mdLine = '见 [荒启](https://www.huangqisf.com/) 与 https://example.com/x 两处'
const mdHit = findLinkInLine(mdLine, mdLine.indexOf('荒启'))
assert.deepEqual(mdHit, { href: 'https://www.huangqisf.com/', start: 2, end: mdLine.indexOf(' 与'), label: '荒启' })
assert.deepEqual(findLinkInLine(mdLine, mdLine.indexOf('荒启') + 2), mdHit)
// markdown 链接内部的 URL 不能被裸 URL 规则抢先命中
assert.deepEqual(findLinkInLine(mdLine, mdLine.indexOf('huangqisf')), mdHit)
const bareHit = findLinkInLine(mdLine, mdLine.indexOf('example.com'))
assert.equal(bareHit?.href, 'https://example.com/x')
assert.equal(bareHit?.label, null)
assert.equal(findLinkInLine(mdLine, 0), null)
assert.equal(findLinkInLine('没有链接的一行', 3), null)

// v1.1.12：引用到评审/回复的单行引用格式（多行/多余空白压成一行，超长截断）
assert.equal(toQuoteLine('  第一段\n第二段  '), '「第一段 第二段」')
const longQuote = toQuoteLine('字'.repeat(200))
assert.equal(longQuote.length, 163) // 「 + 160 字 + … + 」
assert.ok(longQuote.endsWith('…」'))

// v1.1.12：文章公开链接（「复制链接」与悬浮分享按钮共用同一来源）
assert.equal(h5ArticleUrl('abc123'), 'https://www.huangqisf.com/h5/#/pages/contents/info?cid=abc123')
assert.equal(h5ArticleUrl('a b'), 'https://www.huangqisf.com/h5/#/pages/contents/info?cid=a%20b')

console.log('lib-rules tests passed')
