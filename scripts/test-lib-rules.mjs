/**
 * 渲染层纯函数回归：活动阶段判定、分类禁用评分、评分颜色。
 */
import assert from 'node:assert/strict'
import { activityPhase, isActiveReviewing, cnNumToInt, sortActivities } from '../src/renderer/src/lib/activity.ts'
import { isReviewDisabledCategoryName, isReviewDisabledCategoryTitle, isReviewDisabledArticle } from '../src/renderer/src/lib/category.ts'
import { scoreColor } from '../src/renderer/src/lib/sanitize.ts'

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

console.log('lib-rules tests passed')
