// Types shared by the main process, preload script and renderer.

export type ThemeSetting = 'system' | 'light' | 'dark'
export type FontChoice = 'sans' | 'serif' | 'mono' | 'custom'
export type Eol = '\n' | '\r\n'

export interface Settings {
  theme: ThemeSetting
  /** Max width of the text column in px (the "side margins" setting). */
  contentWidth: number
  /** Ignore contentWidth and use the whole window width. */
  fullWidth: boolean
  fontSize: number
  lineHeight: number
  fontFamily: FontChoice
  customFontFamily: string
  codeFontFamily: string
  autoSave: boolean
  spellcheck: boolean
  restoreTabs: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  contentWidth: 860,
  fullWidth: false,
  fontSize: 16,
  lineHeight: 1.7,
  fontFamily: 'sans',
  customFontFamily: '',
  codeFontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
  autoSave: false,
  spellcheck: true,
  restoreTabs: true
}

export const LIMITS = {
  contentWidth: { min: 500, max: 2000, step: 20 },
  fontSize: { min: 12, max: 24, step: 1 },
  lineHeight: { min: 1.3, max: 2.2, step: 0.05 }
} as const

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback

/** Merge untrusted/partial input over defaults and clamp everything into range. */
export function normalizeSettings(input: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) } as Settings
  const d = DEFAULT_SETTINGS
  return {
    theme: (['system', 'light', 'dark'] as const).includes(s.theme) ? s.theme : d.theme,
    contentWidth: clamp(s.contentWidth, LIMITS.contentWidth.min, LIMITS.contentWidth.max, d.contentWidth),
    fullWidth: typeof s.fullWidth === 'boolean' ? s.fullWidth : d.fullWidth,
    fontSize: clamp(s.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max, d.fontSize),
    lineHeight: clamp(s.lineHeight, LIMITS.lineHeight.min, LIMITS.lineHeight.max, d.lineHeight),
    fontFamily: (['sans', 'serif', 'mono', 'custom'] as const).includes(s.fontFamily) ? s.fontFamily : d.fontFamily,
    customFontFamily: typeof s.customFontFamily === 'string' ? s.customFontFamily.slice(0, 300) : '',
    codeFontFamily:
      typeof s.codeFontFamily === 'string' && s.codeFontFamily.trim() ? s.codeFontFamily.slice(0, 300) : d.codeFontFamily,
    autoSave: typeof s.autoSave === 'boolean' ? s.autoSave : d.autoSave,
    spellcheck: typeof s.spellcheck === 'boolean' ? s.spellcheck : d.spellcheck,
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

export interface TabsSession {
  files: string[]
  active: number
}

export interface Startup {
  settings: Settings
  /** Whether the effective theme (setting or Windows preference) is dark. */
  dark: boolean
  files: OpenedFile[]
  /** Index into `files` of the tab to activate. */
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
  closeConfirmed(): void
  openExternal(url: string): void
  zoom(direction: 1 | -1 | 0): void
  onMenu(cb: (action: MenuAction) => void): void
  onOpenFiles(cb: (files: OpenedFile[]) => void): void
  onRequestClose(cb: () => void): void
  onThemeChange(cb: (dark: boolean) => void): void
}
