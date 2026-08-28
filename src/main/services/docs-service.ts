/** 本地文档服务：为文件树、重命名/移动、索引、清理提供统一入口 */
export {
  assertInside,
  chooseDocsDir,
  createLocalDir,
  createLocalDraft,
  deleteLocalFile,
  ensureDocsRoot,
  getDocsRoot,
  listLocalDocs,
  readLocalFile,
  renameLocalNode,
  writeLocalFile
} from '../infra/fs'
export { clearArticles, clearReadCache, listArticles } from '../infra/db'
