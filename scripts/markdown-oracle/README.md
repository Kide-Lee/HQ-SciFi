# markdown 金标准 oracle（只用于重生成语料）

`md2html.ts` 是 **1.x（Electron）发布链路 `src/main/infra/media/md2html.ts` 的原实现快照**，逐字保留，用来生成
`crates/hqsf-core/testdata/markdown/corpus.jsonl`——语料必须是「真实现的输出」，不能手写期望值。

- 运行时角色：**无**。Tauri 侧的渲染是 `crates/hqsf-core/src/infra/markdown`（comrak + QuickJS KaTeX/turndown）。
- 唯一使用者：`scripts/gen-markdown-corpus.mjs`（`node scripts/gen-markdown-corpus.mjs`，幂等）。
- 依赖：`src/shared/kaiti.ts`、`src/shared/markdownItMath.ts`、`node_modules/markdown-it`、`node_modules/turndown`。
  这几个在 v2 里仍然存在（渲染层预览也在用同样的规则），所以快照可复跑。
- **不要修改 `md2html.ts`**：改了就对拍失去意义。如果将来必须重做金标准，正确做法是升级 comrak/KaTeX 时
  先用它重跑语料、确认差异清单，再讨论是否接受行为变更。
