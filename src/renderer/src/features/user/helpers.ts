import { useReaderStore } from '../../stores/reader'
import { useUiStore } from '../../stores/ui'
import type { RemoteArticle, ReviewItem, CommentItem, FollowFeedItem, UserMarkItem } from '../../../../shared/types'

export function useOpenFromUser(): (
  cid: string,
  opts?: { reviewId?: string; commentId?: string }
) => void {
  const openArticle = useReaderStore((s) => s.openArticle)
  return (cid, opts) => {
    const ui = useUiStore.getState()
    const reader = useReaderStore.getState()
    ui.closeUserPage()
    if (opts?.reviewId || opts?.commentId) {
      reader.setTarget({
        cid,
        ...(opts.reviewId ? { reviewId: opts.reviewId } : {}),
        ...(opts.commentId ? { commentId: opts.commentId } : {})
      })
    }
    void openArticle(cid)
    if (opts?.reviewId) ui.openPanelTab('review')
    else if (opts?.commentId) ui.openPanelTab('comments')
  }
}

export function feedToArticle(item: FollowFeedItem): RemoteArticle {
  return {
    cid: item.cid,
    title: item.articleTitle ?? item.cid,
    type: 'post',
    status: 'publish',
    score: item.score ?? '-.-',
    text: item.text ?? '',
    authorId: item.uid,
    authorInfo: {
      uid: item.uid,
      name: item.userName ?? '',
      avatar: item.avatar ?? '',
      experience: item.experience
    },
    views: item.views ?? 0,
    likes: item.likes ?? 0,
    commentsNum: item.commentsNum ?? 0,
    created: item.created,
    modified: 0,
    isAnonymous: false,
    active: null,
    size: item.size,
    hideScore: item.hideScore === true
  }
}

export function feedToReview(item: FollowFeedItem): ReviewItem {
  return {
    id: item.reviewId ?? '',
    cid: item.cid,
    uid: item.uid,
    actualscore: item.score,
    zonghe: item.text,
    replyNum: item.replyNum,
    userJson: {
      uid: item.uid,
      name: item.userName ?? '',
      avatar: item.avatar ?? '',
      experience: item.experience
    },
    articleInfo: { title: item.articleTitle ?? '' },
    created: item.created,
    hideScore: item.hideScore === true
  }
}

export function feedToComment(item: FollowFeedItem): CommentItem {
  return {
    coid: item.commentId ?? '',
    cid: item.cid,
    parent: 0,
    text: item.text ?? '',
    articleTitle: item.articleTitle,
    author: item.userName ?? '',
    authorId: item.uid,
    avatar: item.avatar,
    created: item.created,
    reviewid: item.reviewid,
    reviewAuthor: item.reviewAuthor,
    experience: item.experience
  }
}

export function markToArticle(m: UserMarkItem): RemoteArticle {
  return {
    cid: m.cid,
    title: m.title,
    type: m.type ?? 'post',
    status: 'publish',
    score: m.score ?? '-.-',
    text: m.text ?? '',
    authorId: m.authorId ?? '',
    authorInfo: m.authorInfo,
    cover: m.cover,
    introduction: undefined,
    views: m.views ?? 0,
    likes: m.likes ?? 0,
    commentsNum: m.commentsNum ?? 0,
    created: m.created ?? 0,
    modified: 0,
    isAnonymous: false,
    active: m.active ?? null,
    size: m.size,
    images: m.images,
    hideScore: m.hideScore === true
  }
}
