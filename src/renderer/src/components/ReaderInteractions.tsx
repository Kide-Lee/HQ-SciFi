import { useEffect, useRef, useState } from 'react'
import { ArrowUp, HandCoins, Plus, Share2, Star, ThumbsUp, X } from 'lucide-react'
import { useAuthStore } from '../stores/auth'
import type { ArticleDetail } from '../../../shared/types'

/** H5 文章页公开链接（分享用；H5 前端包实测路由 pages/contents/info?cid=） */
const H5_ARTICLE_URL = (cid: string): string =>
  `https://www.huangqisf.com/h5/#/pages/contents/info?cid=${encodeURIComponent(cid)}`

const DAY_MS = 24 * 3600 * 1000

/** 点赞本地记忆 key（24h 内记住已赞，覆盖「详情缓存导致 isLikes 滞后」的情况；取消点赞即清除） */
function likeKey(cid: string): string {
  return `hqsf-liked-${cid}`
}

function lastLikedAt(cid: string): number {
  return Number(localStorage.getItem(likeKey(cid)) ?? 0)
}

/**
 * v0.0.3：文章页互动悬浮按钮组（投币 / 点赞 / 收藏 / 分享 + 置顶）。
 * 悬浮在正文右下角，圆形图标按钮垂直分布；「+/-」展开收起（默认收起只显示一个 +/- 按钮），
 * 底部常驻「置顶」按钮（平滑滚回正文顶部）。
 * 全部走 hqUserlog/*（addLog：likes 点赞/取消点赞 / mark 收藏 / reward 投币扣积分；isMark 查询、removeLog 取消）。
 * v0.0.7：点赞支持取消（addLog likes num:1 / num:-1，官方 H5「推荐/不推荐」）；收藏成功后重新
 * 查询 isMark 捕获 logid，保证本会话内可直接取消收藏。
 * token 只在主进程；按钮操作均真实作用于平台账号，投币有确认弹层。
 */
export function ReaderInteractions({ detail }: { detail: ArticleDetail }): React.JSX.Element {
  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const cid = detail.cid
  const myUid = String(session?.userinfo?.uid ?? session?.userinfo?.id ?? '')
  const isMine = myUid !== '' && String(detail.authorId) === myUid

  // v0.0.3：悬浮组展开状态（默认收起）
  const [expanded, setExpanded] = useState(false)
  const groupRef = useRef<HTMLDivElement | null>(null)

  // 收藏状态（进入文章时查询；toggle 用 addLog mark / removeLog logid）
  const [marked, setMarked] = useState(false)
  const [markLogid, setMarkLogid] = useState<string | undefined>(undefined)

  // 点赞：服务端 isLikes 为权威初始态（实测 contentsInfo 返回 0/1/-1），本地 24h 记忆兜底
  // （覆盖「详情被缓存导致 isLikes 滞后」的情况）；v0.0.7 起可取消点赞（num:-1）
  const [likedNow, setLikedNow] = useState(() => detail.isLikes === 1 || Date.now() - lastLikedAt(cid) < DAY_MS)
  // v0.0.7：进入文章时的点赞基线（进入时已赞 → detail.likes 已含自己那 1 个赞，计数公式据此校正）。
  // 必须用 state 固定：渲染期从 localStorage 推导的话，点赞成功写入记忆后基线会漂移，导致计数不 +1
  const [initLiked, setInitLiked] = useState<boolean>(() => detail.isLikes === 1 || Date.now() - lastLikedAt(cid) < DAY_MS)
  const [notice, setNotice] = useState<string | null>(null)

  // 投币弹层
  const [rewardOpen, setRewardOpen] = useState(false)
  const [rewardAmount, setRewardAmount] = useState(1)

  useEffect(() => {
    setMarked(false)
    setMarkLogid(undefined)
    setLikedNow(detail.isLikes === 1 || Date.now() - lastLikedAt(cid) < DAY_MS)
    setInitLiked(detail.isLikes === 1 || Date.now() - lastLikedAt(cid) < DAY_MS)
    setNotice(null)
    setRewardOpen(false)
    setExpanded(false)
    if (!loggedIn) return
    void refreshMarkStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, loggedIn])

  /** 重新查询服务端收藏状态（进入文章 / 收藏成功后 / 取消失败时同步本地）；查询失败返回 null */
  async function refreshMarkStatus(): Promise<{ marked: boolean; logid?: string } | null> {
    const res = await window.hqsf.isMark(cid)
    if (!res.ok) return null
    const st = {
      marked: res.data.marked,
      logid: res.data.logid != null ? String(res.data.logid) : undefined
    }
    setMarked(st.marked)
    setMarkLogid(st.logid)
    return st
  }

  // 展开时自动滚到可见区域（右下角悬浮组高度超过剩余视口时）
  useEffect(() => {
    if (!expanded || !groupRef.current) return
    groupRef.current.scrollIntoView({ block: 'nearest' })
  }, [expanded])

  function requireLogin(): boolean {
    if (loggedIn) return true
    setNotice('请先登录后再操作')
    return false
  }

  function scrollToTop(): void {
    const scroller = groupRef.current?.closest('.reader-main')
    scroller?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function toggleMark(): Promise<void> {
    if (!requireLogin()) return
    if (marked) {
      // 罕见情况下 isMark 返回已收藏但无 logid（如记录被其他端删除）：先重查同步，再决定是否可取消
      // 注意：await 后闭包里的 markLogid 不会更新，必须用 refreshMarkStatus 的返回值
      let logid = markLogid
      if (!logid) {
        const st = await refreshMarkStatus()
        logid = st?.logid
        if (!logid) {
          setNotice(st == null ? '查询收藏状态失败，请稍后重试' : '收藏状态异常，请稍后重试')
          return
        }
      }
      const res = await window.hqsf.removeLog(logid)
      if (res.ok && res.data.ok) {
        setMarked(false)
        setMarkLogid(undefined)
        setNotice('已取消收藏')
      } else {
        // 记录可能已失效（logid 过期/已在别处删除）：以服务端状态为准重新同步；
        // 若刷新确认已未收藏（如刚才的取消其实已生效），按成功提示，避免展示原始报错
        const st = await refreshMarkStatus()
        setNotice(
          st != null && !st.marked ? '已取消收藏' : res.ok ? (res.data.error ?? '操作失败') : res.error
        )
      }
    } else {
      const res = await window.hqsf.addLog('mark', { cid })
      if (res.ok && res.data.ok) {
        setMarked(true)
        setNotice('收藏成功')
        // v0.0.7：收藏后立即查询 isMark 捕获本次 logid，否则同会话内「取消收藏」无 logid 可删而静默失败
        await refreshMarkStatus()
      } else {
        setNotice(res.ok ? (res.data.error ?? '操作失败') : res.error)
      }
    }
  }

  async function doLike(): Promise<void> {
    if (!requireLogin()) return
    // v0.0.7：点赞/取消点赞切换——已赞 → num:-1 取消，未赞 → num:1 点赞（官方 H5 推荐/不推荐）
    const want = !likedNow
    const res = await window.hqsf.addLog('likes', { cid, num: want ? 1 : -1 })
    if (res.ok && res.data.ok) {
      if (want) {
        localStorage.setItem(likeKey(cid), String(Date.now()))
        setLikedNow(true)
        setNotice('点赞成功')
      } else {
        localStorage.removeItem(likeKey(cid))
        setLikedNow(false)
        setNotice('已取消点赞')
      }
    } else {
      setNotice(res.ok ? (res.data.error ?? '操作失败') : res.error)
    }
  }

  async function doReward(): Promise<void> {
    if (!requireLogin()) return
    const num = Number(rewardAmount)
    if (!Number.isInteger(num) || num <= 0 || num > 10000) {
      setNotice('投币数量需为 1-10000 的整数')
      return
    }
    const res = await window.hqsf.addLog('reward', { cid, num })
    setRewardOpen(false)
    if (res.ok && res.data.ok) {
      setNotice(`投币成功，感谢支持（${num} 币）`)
    } else {
      setNotice(res.ok ? (res.data.error ?? '操作失败') : res.error)
    }
  }

  async function doShare(): Promise<void> {
    const url = H5_ARTICLE_URL(cid)
    const res = await window.hqsf.copyText(url)
    setNotice(res.ok ? '链接已复制，可分享给朋友' : '复制失败，请重试')
  }

  // 展示点赞数：detail.likes 为进入文章时的服务端计数，按本次会话的净变化校正
  // （进入时已赞则基数已含自己那 1 个赞；本次点赞 +1、取消 -1，避免重复计数）
  const likeCount = Math.max(0, detail.likes + (likedNow ? 1 : 0) - (initLiked ? 1 : 0))

  return (
    <div className={`reader-float-actions${expanded ? ' expanded' : ''}`} ref={groupRef}>
      {notice && (
        <div className="reader-float-notice">
          {notice}
          <button className="dismiss" onClick={() => setNotice(null)} title="关闭">
            <X size={12} />
          </button>
        </div>
      )}

      {/* v0.0.6：操作按钮常驻渲染，展开/收起由 expanded class 控制过渡动画（淡入上浮 + 逐项错开） */}
      <div className="reader-float-btns">
        {!isMine && (
          <button
            className={`reader-float-btn ${rewardOpen ? 'active' : ''}`}
            onClick={() => setRewardOpen((v) => !v)}
            title="投币给作者（消耗你的积分）"
          >
            <HandCoins size={17} />
          </button>
        )}
        <button
          className={`reader-float-btn ${likedNow ? 'active' : ''}`}
          onClick={() => void doLike()}
          title={`${likedNow ? '取消点赞' : '点赞'}${likeCount > 0 ? ` · ${likeCount}` : ''}`}
        >
          <ThumbsUp size={17} />
        </button>
        <button
          className={`reader-float-btn ${marked ? 'active' : ''}`}
          onClick={() => void toggleMark()}
          title={marked ? '取消收藏' : '收藏'}
        >
          <Star size={17} fill={marked ? 'currentColor' : 'none'} />
        </button>
        <button className="reader-float-btn" onClick={() => void doShare()} title="复制文章链接分享">
          <Share2 size={17} />
        </button>
      </div>

      {/* v0.0.3：+/- 展开收起（默认收起） */}
      <button
        className={`reader-float-btn reader-float-toggle ${expanded ? 'active' : ''}`}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? '收起操作按钮' : '展开操作按钮'}
      >
        <Plus size={18} className={`float-toggle-icon${expanded ? ' rotated' : ''}`} />
      </button>

      {/* 置顶：常驻 */}
      <button className="reader-float-btn reader-float-top" onClick={scrollToTop} title="回到正文顶部">
        <ArrowUp size={17} />
      </button>

      {rewardOpen && (
        <div className="reward-modal" onClick={() => setRewardOpen(false)}>
          <div className="reward-box" onClick={(e) => e.stopPropagation()}>
            <h4>投币给作者</h4>
            <p className="reward-tip">
              投币将消耗你的积分并计入作者收益；不可撤销，也不能投给自己。
              <br />
              余额可在官方平台「我的」页面查看。
            </p>
            <div className="reward-amounts">
              {[1, 5, 10].map((v) => (
                <button
                  key={v}
                  className={`reward-amount ${rewardAmount === v ? 'active' : ''}`}
                  onClick={() => setRewardAmount(v)}
                >
                  {v}
                </button>
              ))}
              <input
                className="reward-custom"
                type="number"
                min={1}
                max={10000}
                value={rewardAmount}
                onChange={(e) => setRewardAmount(Number(e.target.value))}
                title="自定义数量（1-10000）"
              />
            </div>
            <div className="reward-actions">
              <button className="reward-cancel" onClick={() => setRewardOpen(false)}>
                取消
              </button>
              <button className="reward-confirm" onClick={() => void doReward()}>
                确认投币
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
