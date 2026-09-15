import { ipcMain, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { assertInside, chooseDocsDir, createLocalDir, createLocalDraft, deleteLocalFile, ensureDocsRoot, getDocsRoot, listLocalDocs, readLocalFile, renameLocalNode, revealLocalFile, writeLocalFile, listArticles } from '../services/docs-service'
import { ok, fail, trusted, sessionUid, windowOf, checkedUid } from './shared'

export function registerDocsHandlers(): void {
ipcMain.handle('hqsf:get-docs-root', () => ok(getDocsRoot()))
ipcMain.handle('hqsf:open-docs-dir', async () => {
    try {
      const root = ensureDocsRoot()
      const err = await shell.openPath(root)
      return err ? fail(new Error(err)) : ok(null)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-local-docs', () => {
    try {
      return ok(listLocalDocs())
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:read-local-file', (_e, path: string) => {
    try {
      return ok(readLocalFile(getDocsRoot(), path))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:file-exists', (event, path: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      return ok(existsSync(assertInside(getDocsRoot(), path)))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:write-local-file', (_e, path: string, content: string) => {
    try {
      writeLocalFile(getDocsRoot(), path, content)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:create-local-draft', (_e, title: string, content: string, dirRel?: string) => {
    try {
      return ok(createLocalDraft(getDocsRoot(), title, content, dirRel ?? ''))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:delete-local-file', async (_e, path: string) => {
    try {
      await deleteLocalFile(getDocsRoot(), path)
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:rename-local-node', (event, oldRel: string, newRel: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      const result = renameLocalNode(getDocsRoot(), String(oldRel ?? ''), String(newRel ?? ''))
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:reveal-in-folder', (event, path: string) => {
    const blocked = trusted(event)
    if (blocked) return fail(blocked)
    try {
      // 只允许显示存档根目录内的条目（showItemInFolder 会把文件管理器窗口拉到前台）
      revealLocalFile(getDocsRoot(), String(path ?? ''))
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:create-local-dir', (_e, rel: string) => {
    try {
      return ok(createLocalDir(getDocsRoot(), rel))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:choose-docs-dir', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return ok(await chooseDocsDir(win))
    } catch (err) {
      return fail(err)
    }
  })
ipcMain.handle('hqsf:list-articles', () => {
    try {
      return ok(
        listArticles().map((a) => (a.filePath && !existsSync(a.filePath) ? { ...a, filePath: '' } : a))
      )
    } catch (err) {
      return fail(err)
    }
  })
}

