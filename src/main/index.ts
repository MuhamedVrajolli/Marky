import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ConfirmOptions,
  LinkInfo,
  OpenedFile,
  RestoredTab,
  SessionTab,
  Settings,
  Startup,
  TabBackup,
  TabsSession
} from '../shared/types'
import { allowPath, isFile, isKnown, pathsFromArgv, readDoc, readDocs, registerFileHandlers } from './files'
import { buildMenu } from './menu'
import {
  deleteBackup,
  getSession,
  getSettings,
  isBackupId,
  pruneBackups,
  readBackup,
  updateSession,
  updateSettings,
  writeBackup,
  type WindowState
} from './store'

// Serves local images referenced by relative paths in a document, e.g. ![](./img/a.png).
// Each tab's Vditor `linkBase` points at mdfile://local/<folder of the document>/.
protocol.registerSchemesAsPrivileged([{ scheme: 'mdfile', privileges: { standard: true, secure: true } }])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => mainWindow

// Lets a separate profile run side by side (e.g. for testing). Must happen before the lock.
if (process.env['MARKY_USER_DATA']) app.setPath('userData', resolve(process.env['MARKY_USER_DATA']))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  start()
}

function start(): void {
  // Files passed on the very first launch (e.g. double-clicking a .md in Explorer).
  let pendingArgvPaths = pathsFromArgv(process.argv, process.cwd())

  app.on('second-instance', async (_e, argv, workingDirectory) => {
    const win = mainWindow
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const files = await readDocs(pathsFromArgv(argv, workingDirectory))
    if (files.length) win.webContents.send('files:open', files)
  })

  app.on('window-all-closed', () => app.quit())

  registerFileHandlers(getWindow)

  ipcMain.handle('app:startup', async (): Promise<Startup> => {
    const settings = getSettings()
    const tabs: RestoredTab[] = []
    let active = 0
    if (settings.hotExit || settings.restoreTabs) {
      const sess = getSession()
      for (const [i, t] of sess.tabs.entries()) {
        // Unsaved changes are only kept with "hot exit" on.
        const backup = settings.hotExit && t.backupId ? readBackup(t.backupId) : null
        let file: OpenedFile | null = null
        if (t.path) {
          if (isFile(t.path)) file = await readDoc(t.path).catch(() => null)
          if (!file && !backup) continue // file is gone and there's nothing unsaved: drop the tab
          if (!file) allowPath(t.path) // deleted on disk but has unsaved changes: saving recreates it
        } else if (!backup) {
          continue // untitled tab with nothing in it
        }
        if (i === sess.active) active = tabs.length
        tabs.push({ path: file?.path ?? t.path, file, backup, backupId: t.backupId, untitledIndex: t.untitledIndex })
      }
    }
    // Backups no restored tab refers to are stale (or hot exit was turned off).
    pruneBackups(new Set(tabs.filter((t) => t.backup).map((t) => t.backupId)))

    const fromArgv = await readDocs(pendingArgvPaths)
    pendingArgvPaths = []
    for (const f of fromArgv) {
      const existing = tabs.findIndex((o) => o.path?.toLowerCase() === f.path.toLowerCase())
      if (existing >= 0) {
        active = existing
      } else {
        tabs.push({ path: f.path, file: f, backup: null, backupId: '', untitledIndex: 0 })
        active = tabs.length - 1
      }
    }
    return { settings, dark: nativeTheme.shouldUseDarkColors, tabs, active }
  })

  // Fires when the Theme setting changes and when Windows switches light/dark (for "system").
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors)
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff')
  })

  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = updateSettings(patch)
    applySettings(s)
    return s
  })

  ipcMain.on('session:save', (_e, s: TabsSession) => {
    if (!s || !Array.isArray(s.tabs)) return
    // Only remember files the user actually opened in this session.
    const tabs: SessionTab[] = s.tabs.flatMap((t) =>
      t && (t.path === null || isKnown(t.path))
        ? [{ path: t.path, backupId: isBackupId(t.backupId) ? t.backupId : '', untitledIndex: Number(t.untitledIndex) || 0 }]
        : []
    )
    updateSession({ tabs, active: Math.min(Math.max(0, Number(s.active) || 0), Math.max(0, tabs.length - 1)) })
  })

  // Unsaved changes kept between runs ("hot exit"), in <userData>/backups.
  ipcMain.handle('backup:write', (_e, id: string, backup: TabBackup) => writeBackup(id, backup))
  ipcMain.handle('backup:delete', (_e, id: string) => deleteBackup(id))

  ipcMain.handle('dialog:confirm', async (_e, o: ConfirmOptions) => {
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      message: String(o.message),
      detail: o.detail ? String(o.detail) : undefined,
      buttons: o.buttons.map(String),
      defaultId: o.defaultId ?? 0,
      cancelId: o.cancelId ?? o.buttons.length - 1,
      noLink: true
    }
    const res = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts)
    return res.response
  })

  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })

  // Right-click on a link: the renderer asks for this menu instead of the default one.
  ipcMain.on('menu:link', (e, link: LinkInfo, hasSelection: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || typeof link?.href !== 'string' || !link.href) return
    const href = link.href
    const text = String(link.text ?? '') || href
    const markdown = String(link.markdown ?? '') || `[${text}](${href})`
    Menu.buildFromTemplate([
      // Same as Ctrl+click. Links to headings (#...) aren't supported.
      { label: 'Open Link', enabled: !href.startsWith('#'), click: () => e.sender.send('link:open', href) },
      { label: 'Copy Link', click: () => void clipboard.writeText(href) },
      {
        // Markdown for plain-text apps, and a clickable link for apps that paste formatted text.
        label: 'Copy Link with Formatting',
        click: () =>
          void clipboard.write([
            new ClipboardItem({
              'text/plain': markdown,
              'text/html': `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`
            })
          ])
      },
      { type: 'separator' },
      ...editItems(!!hasSelection, !!hasSelection, true)
    ]).popup({ window: win })
  })

  app.whenReady().then(() => {
    protocol.handle('mdfile', (req) => {
      let p: string
      try {
        p = decodeURIComponent(new URL(req.url).pathname)
      } catch {
        return new Response('Bad request', { status: 400 })
      }
      if (process.platform === 'win32') p = p.replace(/^\/+(?=[a-zA-Z]:)/, '')
      if (!isAbsolute(p) || !IMAGE_EXTENSIONS.has(extname(p).slice(1).toLowerCase())) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(resolve(p)).toString())
    })

    applySettings(getSettings())
    Menu.setApplicationMenu(buildMenu(getWindow))
    mainWindow = createWindow()
  })
}

/** Cut, Copy, Paste and Select All, for context menus in editable text. */
function editItems(canCut: boolean, canCopy: boolean, canPaste: boolean): MenuItemConstructorOptions[] {
  return [
    { role: 'cut', enabled: canCut },
    { role: 'copy', enabled: canCopy },
    { role: 'paste', enabled: canPaste },
    { type: 'separator' },
    { role: 'selectAll' }
  ]
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function applySettings(s: Settings): void {
  nativeTheme.themeSource = s.theme
  session.defaultSession.setSpellCheckerEnabled(s.spellcheck)
}

function initialBounds(saved: WindowState | undefined): Electron.Rectangle | { width: number; height: number } {
  const fallback = { width: 1100, height: 780 }
  if (!saved || saved.x === undefined || saved.y === undefined) return saved ? { width: saved.width, height: saved.height } : fallback
  const rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  // Only reuse the position if the window would still be visible on a connected display.
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x)
    const overlapY = Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y)
    return overlapX > 100 && overlapY > 50
  })
  return visible ? rect : { width: rect.width, height: rect.height }
}

function createWindow(): BrowserWindow {
  const settings = getSettings()
  const saved = getSession().window
  const win = new BrowserWindow({
    ...initialBounds(saved),
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'Marky',
    // The installed app takes its icon from Marky.exe; when running from source, set it explicitly.
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build/icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: settings.spellcheck
    }
  })
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  const wc = win.webContents

  // Never navigate the app window away; open web links in the default browser instead.
  wc.on('will-navigate', (e, url) => {
    if (url === wc.getURL()) return
    e.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  wc.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions.slice(0, 6)) {
        items.push({ label: s, click: () => wc.replaceMisspelling(s) })
      }
      if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false })
      items.push({
        label: 'Add to Dictionary',
        click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
      items.push({ type: 'separator' })
    }
    if (params.isEditable) {
      items.push(...editItems(params.editFlags.canCut, params.editFlags.canCopy, params.editFlags.canPaste))
    } else if (params.selectionText) {
      items.push({ role: 'copy' })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })

  // Closing: ask the renderer to deal with unsaved tabs first. If the renderer doesn't
  // acknowledge quickly (crashed or still loading), close anyway.
  let allowClose = false
  let ackTimer: NodeJS.Timeout | undefined
  win.on('close', (e) => {
    if (allowClose) {
      updateSession({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
      return
    }
    e.preventDefault()
    wc.send('window:requestClose')
    clearTimeout(ackTimer)
    ackTimer = setTimeout(() => {
      allowClose = true
      win.close()
    }, 3000)
  })
  const onAck = (e: Electron.IpcMainEvent): void => {
    if (e.sender === wc) clearTimeout(ackTimer)
  }
  const onConfirmed = (e: Electron.IpcMainEvent): void => {
    if (e.sender !== wc) return
    allowClose = true
    win.close()
  }
  ipcMain.on('window:closeAck', onAck)
  ipcMain.on('window:closeConfirmed', onConfirmed)
  wc.on('render-process-gone', () => {
    allowClose = true
  })
  win.on('closed', () => {
    ipcMain.off('window:closeAck', onAck)
    ipcMain.off('window:closeConfirmed', onConfirmed)
    mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}
