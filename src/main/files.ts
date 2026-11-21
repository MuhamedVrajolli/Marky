// Reading/writing markdown files and the open/save dialogs.
//
// The renderer can only read or write paths that the user picked (dialogs, command line,
// drag-and-drop, restored session, Ctrl+click on a markdown link). That way a malicious
// document that somehow ran script in the renderer still couldn't touch arbitrary files.
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { statSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { Eol, OpenedFile, SaveAsRequest, SaveRequest, SaveResult } from '../shared/types'

export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdx', 'txt']

const known = new Set<string>()
const keyOf = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

export function allowPath(p: string): void {
  known.add(keyOf(p))
}

export function isKnown(p: unknown): p is string {
  return typeof p === 'string' && known.has(keyOf(p))
}

function assertKnown(p: string): void {
  if (!isKnown(p)) {
    throw new Error(`Access to this path was not granted: ${p}`)
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extname(p).slice(1).toLowerCase())
}

export async function readDoc(p: string): Promise<OpenedFile> {
  const full = resolve(p)
  const buf = await readFile(full)
  let text = buf.toString('utf8')
  const bom = text.charCodeAt(0) === 0xfeff
  if (bom) text = text.slice(1)
  const firstNl = text.indexOf('\n')
  const eol: Eol = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n'
  text = text.replace(/\r\n?/g, '\n')
  const { mtimeMs } = await stat(full)
  allowPath(full)
  return { path: full, content: text, eol, bom, mtimeMs }
}

/** Read several user-chosen paths, skipping ones that fail (missing, unreadable, ...). */
export async function readDocs(paths: string[]): Promise<OpenedFile[]> {
  const out: OpenedFile[] = []
  for (const p of paths) {
    try {
      out.push(await readDoc(p))
    } catch (err) {
      console.warn(`[files] could not open ${p}:`, err)
    }
  }
  return out
}

async function writeDoc(p: string, content: string, eol: Eol, bom: boolean): Promise<SaveResult> {
  let out = content.replace(/\r\n?/g, '\n')
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n')
  if (bom) out = '﻿' + out
  await writeFile(p, out, 'utf8')
  const { mtimeMs } = await stat(p)
  return { path: p, mtimeMs }
}

/** Extracts file paths from a command line (first launch or a second instance). */
export function pathsFromArgv(argv: string[], cwd: string): string[] {
  // Packaged: [exe, ...args]. Dev: [electron, appPath, ...args].
  const args = argv.slice(app.isPackaged ? 1 : 2)
  return args
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => (isAbsolute(a) ? a : resolve(cwd, a)))
    .filter(isFile)
}

function validEol(eol: unknown): Eol {
  return eol === '\r\n' ? '\r\n' : '\n'
}

export function registerFileHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('files:openDialog', async () => {
    const win = getWindow()
    const opts: Electron.OpenDialogOptions = {
      title: 'Open',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown', extensions: MARKDOWN_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : readDocs(res.filePaths)
  })

  // Paths here come from the preload script (webUtils.getPathForFile on dropped File objects),
  // which page scripts cannot call with arbitrary strings.
  ipcMain.handle('files:openDropped', async (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    return readDocs(paths.filter((p): p is string => typeof p === 'string' && isFile(p)))
  })

  ipcMain.handle('files:openLinked', async (_e, fromFile: string, href: string) => {
    assertKnown(fromFile)
    if (typeof href !== 'string') return null
    let rel = href.split('#')[0].split('?')[0]
    try {
      rel = decodeURIComponent(rel)
    } catch {
      /* keep as-is */
    }
    if (!rel) return null
    const target = resolve(dirname(fromFile), rel.replace(/^file:\/\/\/?/i, ''))
    if (!isMarkdownPath(target) || !isFile(target)) return null
    return readDoc(target)
  })

  ipcMain.handle('files:read', async (_e, p: string) => {
    assertKnown(p)
    return readDoc(p)
  })

  ipcMain.handle('files:save', async (_e, req: SaveRequest) => {
    assertKnown(req.path)
    return writeDoc(resolve(req.path), String(req.content), validEol(req.eol), !!req.bom)
  })

  ipcMain.handle('files:saveAs', async (_e, req: SaveAsRequest) => {
    const win = getWindow()
    const name = (req.suggestedName || 'Untitled').replace(/[\\/:*?"<>|]/g, '_')
    const defaultPath = req.suggestedPath
      ? req.suggestedPath
      : join(app.getPath('documents'), /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`)
    const opts: Electron.SaveDialogOptions = {
      title: 'Save As',
      defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    allowPath(res.filePath)
    return writeDoc(resolve(res.filePath), String(req.content), validEol(req.eol), !!req.bom)
  })

  ipcMain.handle('files:stat', async (_e, paths: unknown) => {
    const out: Record<string, number | null> = {}
    if (!Array.isArray(paths)) return out
    for (const p of paths) {
      if (typeof p !== 'string' || !known.has(keyOf(p))) continue
      try {
        out[p] = (await stat(p)).mtimeMs
      } catch {
        out[p] = null
      }
    }
    return out
  })
}
