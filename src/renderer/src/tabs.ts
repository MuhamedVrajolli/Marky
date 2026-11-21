// Tabs: one Vditor instance per tab, kept alive while hidden so undo history,
// scroll position and cursor survive tab switches.
import type Vditor from 'vditor'
import type { Eol, OpenedFile, Settings } from '../../shared/types'
import { createEditor, setSpellcheck, themeArgs, type EditMode } from './editor'
import { mergeEdits, normalize } from './fidelity'

const mark = window.mark

interface Tab {
  id: number
  path: string | null
  untitledIndex: number
  eol: Eol
  bom: boolean
  mtimeMs: number
  mode: EditMode
  editor: Vditor
  host: HTMLElement
  ready: boolean
  darkAtMount: boolean
  /** Text the current editor instance was created with (used until it has loaded). */
  initialValue: string
  /** Exact file text as last loaded/saved ('' for untitled). */
  disk: string
  /**
   * `disk` as the current editor reports it (Lute-normalized in rendered mode, identical in
   * source mode). The tab is dirty when the editor value differs from this.
   */
  base: string | null
  dirty: boolean
  saving: boolean
  pane: HTMLElement
  tabEl: HTMLElement
  scrollTop: number
  range: Range | null
  autoSaveTimer?: number
}

const basename = (p: string): string => p.split(/[\\/]/).pop() || p
const dirname = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export class TabManager {
  private tabs: Tab[] = []
  private active: Tab | null = null
  private nextId = 1
  private sessionTimer = 0
  private checkingExternal = false

  constructor(
    private readonly tabbar: HTMLElement,
    private readonly editors: HTMLElement,
    private settings: Settings,
    private dark: boolean
  ) {}

  // ---------------------------------------------------------------- opening

  newTab(): void {
    this.activate(this.createTab(null))
    this.scheduleSessionSave()
  }

  /** Open documents (focusing any that are already open) and activate one of them. */
  openFiles(files: OpenedFile[], activateIndex = files.length - 1): void {
    if (!files.length) return
    // A lone, untouched "Untitled" tab gets replaced, like in most editors.
    const pristine = this.tabs.length === 1 && this.isPristine(this.tabs[0]) ? this.tabs[0] : null
    let toActivate: Tab | null = null
    files.forEach((f, i) => {
      const tab = this.findByPath(f.path) ?? this.createTab(f)
      if (i === activateIndex) toActivate = tab
    })
    if (toActivate) this.activate(toActivate)
    if (pristine && pristine !== this.active) this.removeTab(pristine)
    this.scheduleSessionSave()
  }

  private findByPath(path: string): Tab | undefined {
    return this.tabs.find((t) => t.path && samePath(t.path, path))
  }

  private isPristine(tab: Tab): boolean {
    return !tab.path && !tab.dirty && this.valueOf(tab).trim() === ''
  }

  private createTab(file: OpenedFile | null): Tab {
    const pane = document.createElement('div')
    pane.className = 'pane'
    pane.hidden = true
    this.editors.append(pane)

    const tabEl = document.createElement('div')
    tabEl.className = 'tab'
    tabEl.setAttribute('role', 'tab')
    tabEl.innerHTML =
      '<span class="tab-title"></span>' +
      '<button class="tab-close" type="button" tabindex="-1" aria-label="Close tab">' +
      '<span class="dot">●</span><span class="x">✕</span></button>'
    this.tabbar.append(tabEl)

    const tab: Tab = {
      id: this.nextId++,
      path: file?.path ?? null,
      untitledIndex: file ? 0 : this.nextUntitledIndex(),
      eol: file?.eol ?? '\n',
      bom: file?.bom ?? false,
      mtimeMs: file?.mtimeMs ?? 0,
      mode: 'ir',
      editor: null as unknown as Vditor,
      host: null as unknown as HTMLElement,
      ready: false,
      darkAtMount: this.dark,
      initialValue: file?.content ?? '',
      disk: file?.content ?? '',
      base: null,
      dirty: false,
      saving: false,
      pane,
      tabEl,
      scrollTop: 0,
      range: null
    }
    this.tabs.push(tab)

    tabEl.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.activate(tab)
    })
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) void this.close(tab)
    })
    tabEl.querySelector('.tab-close')!.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.close(tab)
    })
    tabEl.querySelector('.tab-close')!.addEventListener('mousedown', (e) => e.stopPropagation())

    this.mountEditor(tab, tab.initialValue, 'ir')
    this.renderTab(tab)
    return tab
  }

  private nextUntitledIndex(): number {
    const used = new Set(this.tabs.filter((t) => !t.path).map((t) => t.untitledIndex))
    let i = 1
    while (used.has(i)) i++
    return i
  }

  /** (Re)creates the tab's Vditor instance, e.g. for the first time or when switching modes. */
  private mountEditor(tab: Tab, value: string, mode: EditMode): void {
    if (tab.editor) {
      try {
        tab.editor.destroy()
      } catch {
        /* editor may not have finished loading */
      }
    }
    const host = document.createElement('div')
    host.className = 'editor-host'
    tab.pane.replaceChildren(host)
    tab.pane.classList.toggle('source-mode', mode === 'sv')
    tab.host = host
    tab.mode = mode
    tab.ready = false
    tab.initialValue = value
    tab.darkAtMount = this.dark

    // Show the unsaved dot right away; Vditor's own input callback is debounced.
    host.addEventListener('input', () => {
      if (tab.ready && !tab.dirty) this.setDirty(tab, true)
    })

    const editor = createEditor(
      host,
      { value, mode, filePath: tab.path, dark: this.dark },
      {
        onReady: () => {
          if (tab.editor !== editor) return
          tab.ready = true
          // How the editor represents the file on disk. In rendered mode Lute normalizes the
          // markdown, which must not count as an edit.
          if (mode === 'sv') tab.base = tab.disk
          else if (value === tab.disk) tab.base = editor.getValue()
          else tab.base = normalize(editor, tab.disk) ?? editor.getValue()
          if (tab.darkAtMount !== this.dark) editor.setTheme(...themeArgs(this.dark))
          setSpellcheck(host, this.settings.spellcheck)
          this.updateDirty(tab)
          if (tab === this.active) this.focusEditor(tab)
        },
        onInput: () => this.onInput(tab),
        onLinkClick: (href) => void this.followLink(tab, href)
      }
    )
    tab.editor = editor
  }

  // ---------------------------------------------------------------- state

  private valueOf(tab: Tab): string {
    return tab.ready ? tab.editor.getValue() : tab.initialValue
  }

  /**
   * The text to write to disk for the current editor state: the user's edits applied to the
   * original file (see fidelity.ts), or the editor's own markdown if that isn't possible.
   */
  private materialize(tab: Tab): { text: string; editorValue: string } {
    const editorValue = this.valueOf(tab)
    if (!tab.ready || tab.mode === 'sv' || tab.base === null) return { text: editorValue, editorValue }
    if (editorValue === tab.base) return { text: tab.disk, editorValue }
    const merged = mergeEdits(tab.editor, tab.disk, tab.base, editorValue)
    if (merged === null) console.info('[fidelity] could not map edits onto the original; saving editor output')
    return { text: merged ?? editorValue, editorValue }
  }

  private onInput(tab: Tab): void {
    this.updateDirty(tab)
    if (this.settings.autoSave && tab.path) {
      clearTimeout(tab.autoSaveTimer)
      tab.autoSaveTimer = window.setTimeout(() => {
        if (tab.dirty && this.tabs.includes(tab)) void this.save(tab, { quiet: true })
      }, 1000)
    }
  }

  private updateDirty(tab: Tab): void {
    if (!tab.ready || tab.base === null) return
    this.setDirty(tab, tab.editor.getValue() !== tab.base)
  }

  private setDirty(tab: Tab, dirty: boolean): void {
    if (tab.dirty === dirty) return
    tab.dirty = dirty
    this.renderTab(tab)
    if (tab === this.active) this.updateWindowTitle()
  }

  private titleOf(tab: Tab): string {
    if (tab.path) return basename(tab.path)
    return tab.untitledIndex > 1 ? `Untitled ${tab.untitledIndex}` : 'Untitled'
  }

  private renderTab(tab: Tab): void {
    tab.tabEl.querySelector('.tab-title')!.textContent = this.titleOf(tab)
    tab.tabEl.title = tab.path ?? 'Not saved yet'
    tab.tabEl.classList.toggle('dirty', tab.dirty)
    tab.tabEl.classList.toggle('active', tab === this.active)
    tab.tabEl.setAttribute('aria-selected', String(tab === this.active))
  }

  private updateWindowTitle(): void {
    const t = this.active
    // Electron mirrors document.title into the window title.
    document.title = t ? `${this.titleOf(t)}${t.dirty ? ' •' : ''} — Mark` : 'Mark'
  }

  // ---------------------------------------------------------------- switching

  activate(tab: Tab): void {
    const prev = this.active
    if (prev === tab) return
    if (prev) {
      prev.scrollTop = prev.pane.scrollTop
      const sel = getSelection()
      if (sel?.rangeCount && prev.pane.contains(sel.anchorNode)) prev.range = sel.getRangeAt(0).cloneRange()
      prev.pane.hidden = true
    }
    this.active = tab
    tab.pane.hidden = false
    tab.pane.scrollTop = tab.scrollTop
    if (prev) this.renderTab(prev)
    this.renderTab(tab)
    tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    this.updateWindowTitle()
    this.focusEditor(tab)
    this.scheduleSessionSave()
    void this.checkExternalChanges([tab])
  }

  private focusEditor(tab: Tab): void {
    if (!tab.ready) return
    // Vditor creates the elements for every mode; only the current mode's one is visible.
    const el = tab.host.querySelector<HTMLElement>(tab.mode === 'sv' ? 'textarea.vditor-sv' : '.vditor-ir > .vditor-reset')
    if (!el) return
    el.focus({ preventScroll: true })
    if (tab.range && tab.mode === 'ir' && tab.pane.contains(tab.range.startContainer)) {
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(tab.range)
    }
    tab.pane.scrollTop = tab.scrollTop
  }

  currentEditor(): Vditor | null {
    return this.active?.ready ? this.active.editor : null
  }

  cycle(step: 1 | -1): void {
    if (this.tabs.length < 2 || !this.active) return
    const i = this.tabs.indexOf(this.active)
    this.activate(this.tabs[(i + step + this.tabs.length) % this.tabs.length])
  }

  // ---------------------------------------------------------------- saving

  /** Save the tab; untitled tabs go through Save As. Returns false if cancelled or failed. */
  async save(tab = this.active, opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (!tab) return false
    if (!tab.path) return this.saveAs(tab)
    // Nothing to write for an unchanged file.
    if (!tab.dirty) return true
    const { text, editorValue } = this.materialize(tab)
    tab.saving = true
    try {
      const res = await mark.save({ path: tab.path, content: text, eol: tab.eol, bom: tab.bom })
      tab.mtimeMs = res.mtimeMs
      this.markSaved(tab, text, editorValue)
      return true
    } catch (err) {
      if (!opts.quiet) await this.showError(`Could not save ${this.titleOf(tab)}.`, err)
      return false
    } finally {
      tab.saving = false
    }
  }

  private markSaved(tab: Tab, text: string, editorValue: string): void {
    tab.disk = text
    if (tab.ready) tab.base = editorValue
    else tab.initialValue = text
    this.updateDirty(tab)
    if (!tab.ready) this.setDirty(tab, false)
  }

  async saveAs(tab = this.active): Promise<boolean> {
    if (!tab) return false
    const { text, editorValue } = this.materialize(tab)
    const oldPath = tab.path
    let res
    try {
      res = await mark.saveAs({
        suggestedPath: tab.path,
        suggestedName: this.titleOf(tab),
        content: text,
        eol: tab.eol,
        bom: tab.bom
      })
    } catch (err) {
      await this.showError(`Could not save ${this.titleOf(tab)}.`, err)
      return false
    }
    if (!res) return false
    // Saving over a file that is open in another tab: that tab is now stale.
    const other = this.findByPath(res.path)
    if (other && other !== tab) this.removeTab(other)
    tab.path = res.path
    tab.mtimeMs = res.mtimeMs
    tab.untitledIndex = 0
    this.markSaved(tab, text, editorValue)
    // Relative image paths resolve against the document's folder, which may have changed.
    if (!oldPath || dirname(oldPath).toLowerCase() !== dirname(res.path).toLowerCase()) {
      tab.scrollTop = tab.pane.scrollTop
      this.mountEditor(tab, tab.disk, tab.mode)
    }
    this.renderTab(tab)
    this.updateWindowTitle()
    this.scheduleSessionSave()
    return true
  }

  // ---------------------------------------------------------------- closing

  async close(tab = this.active): Promise<boolean> {
    if (!tab) return false
    if (tab.dirty) {
      this.activate(tab)
      const choice = await mark.confirm({
        message: `Do you want to save the changes you made to ${this.titleOf(tab)}?`,
        detail: "Your changes will be lost if you don't save them.",
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2
      })
      if (choice === 2) return false
      if (choice === 0 && !(await this.save(tab))) return false
    }
    this.removeTab(tab)
    if (!this.tabs.length) this.newTab()
    return true
  }

  private removeTab(tab: Tab): void {
    const i = this.tabs.indexOf(tab)
    if (i < 0) return
    clearTimeout(tab.autoSaveTimer)
    try {
      tab.editor.destroy()
    } catch {
      /* editor may not have finished loading */
    }
    tab.pane.remove()
    tab.tabEl.remove()
    this.tabs.splice(i, 1)
    if (this.active === tab) {
      this.active = null
      const next = this.tabs[Math.min(i, this.tabs.length - 1)]
      if (next) this.activate(next)
      else this.updateWindowTitle()
    }
    this.scheduleSessionSave()
  }

  /** Called when the window is about to close. Returns false to keep the window open. */
  async confirmCloseAll(): Promise<boolean> {
    const dirty = this.tabs.filter((t) => t.dirty)
    if (!dirty.length) return true
    const names = dirty.map((t) => this.titleOf(t))
    const single = dirty.length === 1
    const choice = await mark.confirm({
      message: single
        ? `Do you want to save the changes you made to ${names[0]}?`
        : `Do you want to save the changes to ${dirty.length} files?`,
      detail: (single ? '' : names.join('\n') + '\n\n') + "Your changes will be lost if you don't save them.",
      buttons: [single ? 'Save' : 'Save All', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2
    })
    if (choice === 2) return false
    if (choice === 0) {
      for (const t of dirty) {
        this.activate(t)
        if (!(await this.save(t))) return false
      }
    }
    return true
  }

  // ---------------------------------------------------------------- modes, links, settings

  /** Ctrl+/ : switch between rendered (Vditor "ir") and raw markdown (Vditor "sv"). */
  toggleSourceMode(tab = this.active): void {
    if (!tab || !tab.ready) return
    tab.scrollTop = 0
    tab.range = null
    // Source mode shows the real file text (plus unsaved edits), not Lute's re-serialization.
    const value = tab.mode === 'ir' ? this.materialize(tab).text : tab.editor.getValue()
    this.mountEditor(tab, value, tab.mode === 'ir' ? 'sv' : 'ir')
  }

  private async followLink(tab: Tab, href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      mark.openExternal(href)
      return
    }
    if (href.startsWith('#') || !tab.path) return
    try {
      const file = await mark.openLinked(tab.path, href)
      if (file) this.openFiles([file])
    } catch (err) {
      console.warn('Could not follow link', href, err)
    }
  }

  applySettings(settings: Settings): void {
    this.settings = settings
    for (const t of this.tabs) if (t.ready) setSpellcheck(t.host, settings.spellcheck)
  }

  setDark(dark: boolean): void {
    if (this.dark === dark) return
    this.dark = dark
    for (const t of this.tabs) {
      if (!t.ready) continue
      t.editor.setTheme(...themeArgs(dark))
      t.darkAtMount = dark
    }
  }

  // ---------------------------------------------------------------- external changes

  /** Reload files changed on disk by another program (git, another editor, Claude Code, ...). */
  async checkExternalChanges(only?: Tab[]): Promise<void> {
    if (this.checkingExternal) return
    this.checkingExternal = true
    try {
      const list = (only ?? this.tabs).filter((t) => t.path && t.ready && !t.saving)
      if (!list.length) return
      const stats = await mark.stat(list.map((t) => t.path!))
      for (const tab of list) {
        const mtime = stats[tab.path!]
        if (mtime == null || mtime <= tab.mtimeMs || tab.saving || !this.tabs.includes(tab)) continue
        if (tab.dirty) {
          this.activate(tab)
          const choice = await mark.confirm({
            message: `${this.titleOf(tab)} was changed by another program.`,
            detail: 'Reload it from disk and lose your unsaved changes, or keep your version?',
            buttons: ['Reload', 'Keep My Version'],
            defaultId: 1,
            cancelId: 1
          })
          if (choice !== 0) {
            tab.mtimeMs = mtime
            continue
          }
        }
        await this.reload(tab)
      }
    } catch (err) {
      console.warn('External change check failed', err)
    } finally {
      this.checkingExternal = false
    }
  }

  private async reload(tab: Tab): Promise<void> {
    const file = await mark.readFile(tab.path!)
    tab.eol = file.eol
    tab.bom = file.bom
    tab.mtimeMs = file.mtimeMs
    const scroll = tab.pane.scrollTop
    tab.disk = file.content
    tab.editor.setValue(file.content, true)
    tab.base = tab.editor.getValue()
    this.setDirty(tab, false)
    tab.pane.scrollTop = scroll
  }

  // ---------------------------------------------------------------- session

  private scheduleSessionSave(): void {
    clearTimeout(this.sessionTimer)
    this.sessionTimer = window.setTimeout(() => this.saveSessionNow(), 300)
  }

  saveSessionNow(): void {
    clearTimeout(this.sessionTimer)
    const withPath = this.tabs.filter((t) => t.path)
    mark.saveSession({
      files: withPath.map((t) => t.path!),
      active: Math.max(0, this.active ? withPath.indexOf(this.active) : 0)
    })
  }

  private async showError(message: string, err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    await mark.confirm({ message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0 })
  }
}
