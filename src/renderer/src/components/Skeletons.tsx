/**
 * v0.0.7：预填充骨架（skeleton）组件集。
 * 形状与各页面加载完成后的真实结构同构——封面/头像/文本行/统计行按真实卡片
 * 的尺寸与排版占位，加载期间渲染，避免布局跳动（占位与真实内容等高宽）。
 * 覆盖：文章列表卡 / meta 卡（连载、作品分类）/ 活动卡 / AI 模型卡 / 阅读页 / 评论行。
 * 纯展示元素（aria-hidden），加载提示以 .sr-only 文本由页面提供。
 */

/** 文章卡片骨架（.article-card：封面 140×120 + 标题/摘要三行 + 底部 meta 行） */
export function SkeletonArticleCard(): React.JSX.Element {
  return (
    <div className="sk sk-card sk-article-card" aria-hidden="true">
      <div className="sk sk-article-cover" />
      <div className="sk-article-body">
        <div className="sk sk-line sk-w62" />
        <div className="sk sk-line sk-w100" />
        <div className="sk sk-line sk-w92" />
        <div className="sk sk-line sk-w68" />
        <div className="sk-article-meta">
          <div className="sk sk-avatar" />
          <div className="sk sk-line sk-px160" />
        </div>
      </div>
    </div>
  )
}

/** meta 卡片骨架（.meta-card：64×64 封面 + 名称 + 描述两行） */
export function SkeletonMetaCard(): React.JSX.Element {
  return (
    <div className="sk sk-card sk-meta-card" aria-hidden="true">
      <div className="sk sk-meta-cover" />
      <div className="sk-meta-body">
        <div className="sk sk-line sk-w70" />
        <div className="sk sk-line sk-w100" />
        <div className="sk sk-line sk-w55" />
      </div>
    </div>
  )
}

/** 活动卡片骨架（.activity-card：72×72 封面 + 名称/徽章 + 描述左/统计右；≤1150px 统计列隐藏） */
export function SkeletonActivityCard(): React.JSX.Element {
  return (
    <div className="sk sk-card sk-activity-card" aria-hidden="true">
      <div className="sk sk-activity-cover" />
      <div className="sk-activity-body">
        <div className="sk-activity-head">
          <div className="sk sk-line sk-w46" />
          <div className="sk sk-activity-badge" />
        </div>
        {/* v0.0.8：与真实卡同构——描述（左）与统计（右）并排，窄屏统计列隐藏 */}
        <div className="sk-activity-content">
          <div className="sk-activity-desc">
            <div className="sk sk-line sk-w100" />
            <div className="sk sk-line sk-w88" />
          </div>
          <div className="sk-activity-stats-col">
            <div className="sk-activity-stats-table">
              <div className="sk-activity-stats-row">
                <div className="sk sk-line sk-px72" />
                <div className="sk sk-line sk-px72" />
              </div>
              <div className="sk-activity-stats-row">
                <div className="sk sk-line sk-px72" />
                <div className="sk sk-line sk-px72" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** AI 模型卡片骨架（.gpt-card：42×42 头像 + 名称/标签 + 简介两行 + meta 行） */
export function SkeletonGptCard(): React.JSX.Element {
  return (
    <div className="sk sk-card sk-gpt-card" aria-hidden="true">
      <div className="sk-gpt-head">
        <div className="sk sk-gpt-avatar" />
        <div className="sk-gpt-titles">
          <div className="sk sk-line sk-w46" />
          <div className="sk sk-gpt-tag" />
        </div>
      </div>
      <div className="sk sk-line sk-w100" />
      <div className="sk sk-line sk-w82" />
      <div className="sk sk-line sk-w38" />
    </div>
  )
}

/** 阅读页骨架（.reader-main：标题 + meta + 正文段落） */
export function SkeletonReader(): React.JSX.Element {
  return (
    <div className="sk-reader" aria-hidden="true">
      <div className="sk sk-reader-title" />
      <div className="sk sk-line sk-reader-meta sk-w34" />
      <div className="sk-reader-para">
        <div className="sk sk-line sk-w100" />
        <div className="sk sk-line sk-w100" />
        <div className="sk sk-line sk-w96" />
        <div className="sk sk-line sk-w62" />
      </div>
      <div className="sk-reader-para">
        <div className="sk sk-line sk-w100" />
        <div className="sk sk-line sk-w88" />
        <div className="sk sk-line sk-w70" />
      </div>
    </div>
  )
}

/** 评论行骨架（.comment-item：32×32 头像 + 昵称/时间 + 内容两行） */
export function SkeletonComment(): React.JSX.Element {
  return (
    <div className="sk-comment" aria-hidden="true">
      <div className="sk-comment-head">
        <div className="sk sk-comment-avatar" />
        <div className="sk-comment-meta">
          <div className="sk sk-line sk-px96" />
          <div className="sk sk-line sk-px64" />
        </div>
      </div>
      <div className="sk sk-line sk-w100" />
      <div className="sk sk-line sk-w78" />
    </div>
  )
}

/** 首页信息流卡片骨架（.home-feed-card：32×32 头像 + 昵称/时间 + 3 行内容 + 文章归属/按钮行）。
 *  v0.0.9：对齐 3 行内容与 143px 卡片高度的最新改动，加载时占位避免布局跳动 */
export function SkeletonFeedCard(): React.JSX.Element {
  return (
    <div className="sk sk-card sk-feed-card" aria-hidden="true">
      <div className="sk-feed-head">
        <div className="sk sk-feed-avatar" />
        <div className="sk-feed-meta">
          <div className="sk sk-line sk-feed-name" />
          <div className="sk sk-line sk-feed-time" />
        </div>
        <div className="sk sk-feed-badge" />
      </div>
      <div className="sk-feed-content">
        <div className="sk sk-line sk-w100" />
        <div className="sk sk-line sk-w92" />
        <div className="sk sk-line sk-w68" />
      </div>
      <div className="sk-feed-foot">
        <div className="sk sk-line sk-feed-article" />
        <div className="sk sk-feed-btn" />
      </div>
    </div>
  )
}
