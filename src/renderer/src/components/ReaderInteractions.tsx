import { useEffect, useState } from 'react'
import { useAuthStore } from '../stores/auth'
import type { ArticleDetail } from '../../../shared/types'

/** H5 文章页公开链接（分享用；H5 前端包实测路由 pages/contents/info?cid=） */
const H5_ARTICLE_URL = (cid: string): string =>
  `https://www.huangqisf.com/h5/#/pages/contents/info?cid=${encodeURIComponent(cid)}`

const DAY_MS = 24 * 3600 * 1000

/** 点赞本地记忆 key（24h 内不重复调用服务端；官方接口也是每日每 IP+UA+cid 一次） */
function likeKey(cid: string): string {
  return `hqsf-liked-${cid}`
}

function lastLikedAt(cid: string): number {
  return Number(localStorage.getItem(likeKey(cid)) ?? 0)
}

/**
 * 互动操作条（投币 / 点赞 / 收藏 / 分享）。
 * 全部走 hqUserlog/*（addLog：likes 每日一次 / mark 收藏 / reward 投币扣积分；isMark 查询、removeLog 取消）。
 * token 只在主进程；按钮操作均真实作用于平台账号，投币有确认弹层。
 */
export function ReaderInteractions({ detail }: { detail: ArticleDetail }): React.JSX.Element {
  const session = useAuthStore((s) => s.session)
  const loggedIn = !!session

  const cid = detail.cid
  const myUid = String(session?.userinfo?.uid ?? session?.userinfo?.id ?? '')
  const isMine = myUid !== '' && String(detail.authorId) === myUid

  // 收藏状态（进入文章时查询；toggle 用 addLog mark / removeLog logid）
  const [marked, setMarked] = useState(false)
  const [markLogid, setMarkLogid] = useState<string | undefined>(undefined)

  // 点赞：服务端 isLikes 为权威初始态（实测 contentsInfo 返回 0/1），本地 24h 记忆兜底；
  // 按钮显示 likes = detail.likes + (本次会话已赞 ? 1 : 0)
  const [likedNow, setLikedNow] = useState(() => detail.isLikes === 1 || Date.now() - lastLikedAt(cid) < DAY_MS)
  const [notice, setNotice] = useState<string | null>(null)

  // 投币弹层
  const [rewardOpen, setRewardOpen] = useState(false)
  const [rewardAmount, setRewardAmount] = useState(1)

  useEffect(() => {
    setMarked(false)
    setMarkLogid(undefined)
    setLikedNow(detail.isLikes === 1 || Date.now() - lastLikedAt(cid) < DAY_MS)
    setNotice(null)
    setRewardOpen(false)
    if (!loggedIn) return
    void window.hqsf.isMark(cid).then((res) => {
      if (!res.ok) return
      setMarked(res.data.marked)
      setMarkLogid(res.data.logid != null ? String(res.data.logid) : undefined)
    })
  }, [cid, loggedIn])

  function requireLogin(): boolean {
    if (loggedIn) return true
    setNotice('请先登录后再操作')
    return false
  }

  async function toggleMark(): Promise<void> {
    if (!requireLogin()) return
    if (marked) {
      if (!markLogid) return
      const res = await window.hqsf.removeLog(markLogid)
      if (res.ok && res.data.ok) {
        setMarked(false)
        setMarkLogid(undefined)
        setNotice('已取消收藏')
      } else {
        setNotice(res.ok ? (res.data.error ?? '操作失败') : res.error)
      }
    } else {
      const res = await window.hqsf.addLog('mark', { cid })
      if (res.ok && res.data.ok) {
        setMarked(true)
        setNotice('收藏成功')
      } else {
        setNotice(res.ok ? (res.data.error ?? '操作失败') : res.error)
      }
    }
  }

  async function doLike(): Promise<void> {
    if (!requireLogin()) return
    if (Date.now() - lastLikedAt(cid) < DAY_MS) {
      setNotice('今天已经点过赞啦')
      return
    }
    const res = await window.hqsf.addLog('likes', { cid })
    if (res.ok && res.data.ok) {
      localStorage.setItem(likeKey(cid), String(Date.now()))
      setLikedNow(true)
      setNotice('点赞成功')
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

  const likeCount = detail.likes + (likedNow ? 1 : 0)

  return (
    <div className="reader-actions">
      {notice && (
        <div className="reader-actions-notice">
          {notice}
          <button className="dismiss" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}
      <div className="reader-actions-row">
        {!isMine && (
          <button className={`reader-action-btn ${rewardOpen ? 'active' : ''}`} onClick={() => setRewardOpen((v) => !v)} title="投币给作者（消耗你的积分）">
            🪙 投币
          </button>
        )}
        <button
          className={`reader-action-btn ${likedNow ? 'active' : ''}`}
          onClick={() => void doLike()}
          title="点赞（每天一次）"
        >
          👍 赞 {likeCount > 0 ? likeCount : ''}
        </button>
        <button
          className={`reader-action-btn ${marked ? 'active' : ''}`}
          onClick={() => void toggleMark()}
          title={marked ? '取消收藏' : '收藏'}
        >
          {marked ? '★ 已收藏' : '☆ 收藏'}
        </button>
        <button className="reader-action-btn" onClick={() => void doShare()} title="复制文章链接">
          ↗ 分享
        </button>
      </div>

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
