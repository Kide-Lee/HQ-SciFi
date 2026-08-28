import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, FileDown, MessageCircle, PenLine, X } from 'lucide-react'
import { anonymousAuthorDisplayName, cachedImageUrl, formatSize, formatTs, scoreColor, userAvatarUrl, userDisplayName } from '../../lib/sanitize'
import { REVIEW_ORDERS, useReaderStore } from '../../stores/reader'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { ErrorBanner } from '../../components/ErrorBanner'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import type { CommentItem, ReviewItem, ReviewPayload } from '../../../../shared/types'

import { activityPhase, type ActivityPhase } from '../../lib/activity'
import { getActivePhaseCache, setActivePhaseCache } from './activityCache'
import { ReviewForm } from './ReviewForm'
import { ReviewItemCard } from './ReviewItemCard'
import { ReviewInlineComments } from './ReviewInlineComments'

export function ReviewPanel(): React.JSX.Element {
  const reviews = useReaderStore((s) => s.reviews)
  const reviewsLoading = useReaderStore((s) => s.reviewsLoading)
  const submitting = useReaderStore((s) => s.submitting)
  const submitMessage = useReaderStore((s) => s.submitMessage)
  const clearSubmitMessage = useReaderStore((s) => s.clearSubmitMessage)
  const submit = useReaderStore((s) => s.submit)
  const reviewOrder = useReaderStore((s) => s.reviewOrder)
  const reviewOrderAsc = useReaderStore((s) => s.reviewOrderAsc)
  const setReviewOrder = useReaderStore((s) => s.setReviewOrder)
  const toggleReviewOrderAsc = useReaderStore((s) => s.toggleReviewOrderAsc)
  const detail = useReaderStore((s) => s.detail)
  const loadReviews = useReaderStore((s) => s.loadReviews)
  const session = useAuthStore((s) => s.session)
  // v0.0.8：深链目标（首页「最新评审/最新讨论」跳转定位）+ 评论分页加载（目标评论可能在第 2+ 页）
  const target = useReaderStore((s) => s.target)
  const clearTarget = useReaderStore((s) => s.clearTarget)
  const commentsLoading = useReaderStore((s) => s.commentsLoading)
  const commentsHasMore = useReaderStore((s) => s.commentsHasMore)
  const reviewsHasMore = useReaderStore((s) => s.reviewsHasMore)
  const loadComments = useReaderStore((s) => s.loadComments)

  const [tab, setTab] = useState<'mine' | 'all'>('all')
  const [editing, setEditing] = useState(false)
  const loggedIn = !!session

  // v0.0.8：进行中/评审中活动的文章，其评审列表不提供「按评分」排序
  const actMid = detail?.active?.[0]?.mid
  const [actPhase, setActPhase] = useState<ActivityPhase | null>(null)
  // v0.0.8.6：活动状态查询失败 → 保守隐藏「按评分」（与文章列表的 hideScoreboard 兜底一致）
  const [phaseUnknown, setPhaseUnknown] = useState(false)
  useEffect(() => {
    let alive = true
    setActPhase(null)
    setPhaseUnknown(false)
    if (actMid == null) return
    const midKey = String(actMid)
    if (getActivePhaseCache()) {
      setActPhase(getActivePhaseCache()?.[midKey] ?? null)
      return
    }
    void window.hqsf.listMetas('active').then((res) => {
      if (!alive) return
      if (!res.ok) {
        setPhaseUnknown(true)
        return
      }
      const cache: Record<string, ActivityPhase> = {}
      for (const m of res.data) cache[String(m.mid)] = activityPhase(m)
      setActivePhaseCache(cache)
      setActPhase(cache[midKey] ?? null)
    })
    return () => {
      alive = false
    }
  }, [actMid])

  const noScoreSort = (actPhase === 'ongoing' || actPhase === 'reviewing') || phaseUnknown
  const reviewOrders = noScoreSort ? REVIEW_ORDERS.filter((o) => o.key !== 'score') : REVIEW_ORDERS
  // 进入此类文章时，若残留「按评分」排序则切回「按时间」（setReviewOrder 会重拉列表）
  useEffect(() => {
    if (noScoreSort && reviewOrder === 'score') setReviewOrder('created')
  }, [noScoreSort, reviewOrder, setReviewOrder])

  // v0.0.6：未登录时只显示「所有评审」（不提供「我的评审」/评审表单）
  useEffect(() => {
    if (!loggedIn) setTab('all')
  }, [loggedIn])

  useEffect(() => {
    clearSubmitMessage()
    setEditing(false)
    if (detail?.cid) void loadReviews(detail.cid)
  }, [detail?.cid, loadReviews, clearSubmitMessage])

  const myUid = String(session?.userinfo?.uid ?? '')
  const mine = reviews.filter((r) => myUid !== '' && String(r.uid ?? (r.userJson as Record<string, unknown> | undefined)?.uid ?? '') === myUid)
  const myReview = mine[0]
  const others = reviews.filter((r) => !mine.includes(r))

  // v0.0.8：深链目标带 reviewId 时切到包含目标评审的 tab——
  // 自己的评审在「我的评审」tab，他人的评审在「所有评审」tab。
  // 之前固定切「所有评审」导致点自己评审的讨论无法定位（自己的评审不在 others 列表）。
  useEffect(() => {
    if (!target?.reviewId || target.cid !== detail?.cid) return
    if (reviewsLoading || reviews.length === 0) return
    const targetReview = reviews.find((r) => String(r.id) === String(target.reviewId))
    if (!targetReview) return // 目标评审可能在第 2+ 页，由深链分页追加后再切
    const targetUid = String(targetReview.uid ?? (targetReview.userJson as Record<string, unknown> | undefined)?.uid ?? '')
    const isMine = myUid !== '' && targetUid === myUid
    const wantedTab = isMine ? 'mine' : 'all'
    if (tab !== wantedTab) setTab(wantedTab)
  }, [target, detail?.cid, tab, reviews, reviewsLoading, myUid])

  // v0.0.8：消费深链目标——目标文章不符则丢弃；评审评论需等评论区展开渲染后再定位。
  // 评论按 coid 升序分页加载，目标评论可能是最新一条（第 2+ 页）：未命中且还有下一页时继续追加加载。
  // 不带 deps：评审卡片展开评论区（子组件局部 state）后本 effect 随重渲染再次尝试。
  useEffect(() => {
    if (!target) return
    if (target.cid !== detail?.cid) {
      clearTarget()
      return
    }
    const panel = document.querySelector('.review-panel')
    if (!panel) return
    let found = false
    if (target.reviewId) {
      const card = panel.querySelector(`[data-review-id="${CSS.escape(target.reviewId)}"]`)
      if (card) {
        if (target.commentId) {
          const el = card.querySelector(`[data-coid="${CSS.escape(target.commentId)}"]`)
          if (el) {
            el.scrollIntoView({ block: 'center' })
            // 回复跳转时由回复框消费后再 clear，确保子组件能拿到 replyCommentId
            if (!target.replyCommentId) clearTarget()
            found = true
          }
        } else {
          card.scrollIntoView({ block: 'center' })
          clearTarget()
          found = true
        }
      }
    } else if (target.commentId) {
      const el = panel.querySelector(`[data-coid="${CSS.escape(target.commentId)}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        clearTarget()
        found = true
      }
    }
    // v0.0.8.6：目标评审不在已加载列表（评审可能在第 2+ 页）→ 追加加载；加载完仍无 → 放弃
    if (!found && target.reviewId) {
      const cardFound = !!panel.querySelector(`[data-review-id="${CSS.escape(target.reviewId)}"]`)
      if (!cardFound && !reviewsLoading && reviewsHasMore && detail?.cid) {
        void loadReviews(detail.cid, { append: true })
      } else if (!cardFound && !reviewsLoading && !reviewsHasMore) {
        clearTarget()
      }
    }
    if (!found && target.commentId) {
      // 目标评审卡片已渲染但目标评论不在已加载页 → 追加加载评论；
      // 评论区尚未展开（深链自动展开在下一渲染）→ 先等待，不放弃
      const card = target.reviewId ? panel.querySelector(`[data-review-id="${CSS.escape(target.reviewId)}"]`) : null
      const cardReady = !target.reviewId || !!card
      if (cardReady && !commentsLoading && commentsHasMore && detail?.cid) {
        void loadComments(detail.cid, { append: true, limit: 100 })
      } else if (cardReady && !commentsLoading && !commentsHasMore) {
        const inlineEl = card ? (card.querySelector('.review-inline-comments') as HTMLElement | null) : null
        const expanded = !!inlineEl && inlineEl.offsetParent != null
        if (expanded || !target.reviewId) clearTarget() // 已展开仍找不到（罕见）→ 放弃定位
      }
    }
  })

  return (
    <aside className="review-panel">
      {/* v0.0.2：「我的评审」/「所有评审」tab；v0.0.6：未登录不显示 tab 条，直接展示所有评审列表 */}
      {loggedIn && (
        <div className="review-tabs">
          <button className={`review-tab ${tab === 'mine' ? 'active' : ''}`} onClick={() => setTab('mine')}>
            我的评审
          </button>
          <button className={`review-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
            所有评审
          </button>
        </div>
      )}

      {submitMessage && !submitMessage.startsWith('提交失败') && (
        <div className="review-msg">
          {submitMessage}
          <button className="dismiss" onClick={clearSubmitMessage}>
            <X size={12} />
          </button>
        </div>
      )}
      {submitMessage && submitMessage.startsWith('提交失败') && (
        <ErrorBanner
          title="评审提交失败"
          message={submitMessage.replace(/^提交失败:\s*/, '')}
          onDismiss={clearSubmitMessage}
        />
      )}

      {tab === 'mine' && loggedIn ? (
        /* v0.0.2：已评审 → 展示与编辑二选一（不再同时显示表单）；
           未评审 → 显示新评审表单 */
        myReview ? (
          editing ? (
            <ReviewForm
              key={String(myReview.id)}
              cid={detail?.cid ?? ''}
              initial={myReview}
              submitting={submitting}
              onSubmit={async (payload) => {
                const activeid = detail?.active && detail.active.length > 0 ? detail.active[0].mid : 0
                const ok = await submit({ ...payload, activeid })
                if (ok) setEditing(false)
                return ok
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="review-list">
              <ReviewItemCard
                review={myReview}
                isMine
                onEdit={() => {
                  setEditing(true)
                  clearSubmitMessage()
                }}
              />
            </div>
          )
        ) : (
          <ReviewForm
            key="new"
            cid={detail?.cid ?? ''}
            submitting={submitting}
            onSubmit={async (payload) => {
              const activeid = detail?.active && detail.active.length > 0 ? detail.active[0].mid : 0
              return submit({ ...payload, activeid })
            }}
          />
        )
      ) : (
        <>
          {/* 所有评审：排序控件 + 其他用户评审 */}
          <div className="review-toolbar">
            <div className="review-orders">
              {reviewOrders.map((o) => (
                <button
                  key={o.key}
                  className={`review-order-btn ${reviewOrder === o.key ? 'active' : ''}`}
                  onClick={() => setReviewOrder(o.key)}
                >
                  {o.label}
                </button>
              ))}
              <button
                className={`review-order-btn review-dir-btn ${reviewOrderAsc ? 'asc' : ''}`}
                onClick={toggleReviewOrderAsc}
                title={reviewOrderAsc ? '当前升序（小→大），点击切回降序' : '当前降序（大→小），点击切换为升序'}
              >
                {reviewOrderAsc ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
              </button>
            </div>
          </div>
          <div className="review-list">
            {reviewsLoading && <div className="muted review-loading">加载评审中 …</div>}
            {!reviewsLoading && others.length === 0 && (
              <div className="muted review-empty">{reviews.length === 0 ? '还没有人评审，来抢沙发吧' : '（暂无其他用户评审）'}</div>
            )}
            {others.map((r) => (
              <ReviewItemCard key={String(r.id)} review={r} isMine={false} />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
