// Types shared by the main process, preload script and renderer.

export type ThemeSetting = 'system' | 'light' | 'dark'
export type FontChoice = 'sans' | 'serif' | 'mono' | 'custom'
export type Eol = '\n' | '\r\n'

export type WidthMode = 'fixed' | 'percent'

export interface Settings {
  theme: ThemeSetting
  /** How the side margins are set: a fixed text column width, or a percentage of the window. */
  widthMode: WidthMode
  /** Max width of the text column in px (widthMode "fixed"). */
  contentWidth: number
  /** Margin on each side as a percentage of the window width (widthMode "percent"). */
  sideMargin: number
  /** Wrap long text inside table cells instead of making the table scroll sideways. */
  wrapTableCells: boolean
  fontSize: number
  lineHeight: number
  fontFamily: FontChoice
  customFontFamily: string
  codeFontFamily: string
  autoSave: boolean
  spellcheck: boolean
  /** Sublime-style "hot exit": closing keeps all tabs and unsaved changes, without asking. */
  hotExit: boolean
  /** Reopen last session's files (implied when hotExit is on). */
  restoreTabs: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  widthMode: 'fixed',
  contentWidth: 860,
  sideMargin: 15,
  wrapTableCells: true,
  fontSize: 16,
  lineHeight: 1.7,
  fontFamily: 'sans',
  customFontFamily: '',
  codeFontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
  autoSave: false,
  hotExit: true,
  spellcheck: true,
  restoreTabs: true
}

export const LIMITS = {
  contentWidth: { min: 500, max: 2000, step: 20 },
  sideMargin: { min: 0, max: 35, step: 1 },
  fontSize: { min: 12, max: 24, step: 1 },
  lineHeight: { min: 1.3, max: 2.2, step: 0.05 }
} as const

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback

/** Merge untrusted/partial input over defaults and clamp everything into range. */
export function normalizeSettings(input: unknown): Settings {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<Settings> & { fullWidth?: unknown }
  // Settings from 0.2.0 and earlier had a "full width" checkbox: that is now 0 % side margins.
  const migrated = raw.fullWidth === true && raw.widthMode === undefined ? { widthMode: 'percent', sideMargin: 0 } : {}
  const s = { ...DEFAULT_SETTINGS, ...raw, ...migrated } as Settings
  const d = DEFAULT_SETTINGS
  return {
    theme: (['system', 'light', 'dark'] as const).includes(s.theme) ? s.theme : d.theme,
    widthMode: (['fixed', 'percent'] as const).includes(s.widthMode) ? s.widthMode : d.widthMode,
    contentWidth: clamp(s.contentWidth, LIMITS.contentWidth.min, LIMITS.contentWidth.max, d.contentWidth),
    sideMargin: clamp(s.sideMargin, LIMITS.sideMargin.min, LIMITS.sideMargin.max, d.sideMargin),
    wrapTableCells: typeof s.wrapTableCells === 'boolean' ? s.wrapTableCells : d.wrapTableCells,
    fontSize: clamp(s.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max, d.fontSize),
    lineHeight: clamp(s.lineHeight, LIMITS.lineHeight.min, LIMITS.lineHeight.max, d.lineHeight),
    fontFamily: (['sans', 'serif', 'mono', 'custom'] as const).includes(s.fontFamily) ? s.fontFamily : d.fontFamily,
    customFontFamily: typeof s.customFontFamily === 'string' ? s.customFontFamily.slice(0, 300) : '',
    codeFontFamily:
      typeof s.codeFontFamily === 'string' && s.codeFontFamily.trim() ? s.codeFontFamily.slice(0, 300) : d.codeFontFamily,
    autoSave: typeof s.autoSave === 'boolean' ? s.autoSave : d.autoSave,
    spellcheck: typeof s.spellcheck === 'boolean' ? s.spellcheck : d.spellcheck,
    hotExit: typeof s.hotExit === 'boolean' ? s.hotExit : d.hotExit,
    restoreTabs: typeof s.restoreTabs === 'boolean' ? s.restoreTabs : d.restoreTabs
  }
}

/** A document read from disk. Content always uses '\n'; the original EOL/BOM is kept for saving. */
export interface OpenedFile {
  path: string
  content: string
  eol: Eol
  bom: boolean
  mtimeMs: number
}

export interface SaveRequest {
  path: string
  content: string
  eol: Eol
  bom: boolean
}

export interface SaveAsRequest {
  /** Current path, or a suggested file name for untitled documents. */
  suggestedPath: string | null
  suggestedName: string
  content: string
  eol: Eol
  bom: boolean
}

export interface SaveResult {
  path: string
  mtimeMs: number
}

/** One tab as remembered between runs. */
export interface SessionTab {
  /** File path, or null for an untitled document. */
  path: string | null
  /** Name of the tab's backup of unsaved changes (backups/<id>.json), if it has one. */
  backupId: string
  untitledIndex: number
}

export interface TabsSession {
  tabs: SessionTab[]
  /** Index into `tabs` of the active tab. */
  active: number
}

/** Unsaved changes kept for a tab ("hot exit" and crash safety). */
export interface TabBackup {
  /** The document text including unsaved changes. */
  content: string
  eol: Eol
  bom: boolean
  /** mtime of the file on disk the changes were based on (null for untitled documents). */
  diskMtimeMs: number | null
}

/** A tab to recreate at startup. */
export interface RestoredTab {
  path: string | null
  /** The file as it is on disk now (null for untitled documents or files that were deleted). */
  file: OpenedFile | null
  /** Unsaved changes kept from last time, if any. */
  backup: TabBackup | null
  backupId: string
  untitledIndex: number
}

export interface Startup {
  settings: Settings
  /** Whether the effective theme (setting or Windows preference) is dark. */
  dark: boolean
  tabs: RestoredTab[]
  /** Index into `tabs` of the tab to activate. */
  active: number
}

export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'closeTab'
  | 'settings'
  | 'toggleSource'
  | 'nextTab'
  | 'prevTab'
  | 'find'
  | 'replace'
  | 'findNext'
  | 'findPrev'

export interface ConfirmOptions {
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/** The API exposed on `window.mark` by the preload script. */
export interface MarkApi {
  getStartup(): Promise<Startup>
  openDialog(): Promise<OpenedFile[]>
  /** Open files dropped onto the window (paths are resolved inside the preload script). */
  openDropped(files: File[]): Promise<OpenedFile[]>
  /** Ctrl+click on a relative link to another markdown file. */
  openLinked(fromFile: string, href: string): Promise<OpenedFile | null>
  readFile(path: string): Promise<OpenedFile>
  save(req: SaveRequest): Promise<SaveResult>
  saveAs(req: SaveAsRequest): Promise<SaveResult | null>
  /** mtimeMs per path, or null when the file no longer exists. */
  stat(paths: string[]): Promise<Record<string, number | null>>
  confirm(opts: ConfirmOptions): Promise<number>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  saveSession(session: TabsSession): void
  writeBackup(id: string, backup: TabBackup): Promise<void>
  deleteBackup(id: string): Promise<void>
  closeConfirmed(): void
  openExternal(url: string): void
  zoom(direction: 1 | -1 | 0): void
  onMenu(cb: (action: MenuAction) => void): void
  onOpenFiles(cb: (files: OpenedFile[]) => void): void
  onRequestClose(cb: () => void): void
  onThemeChange(cb: (dark: boolean) => void): void
}
