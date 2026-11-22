// Settings dialog (Ctrl+,). Every change is applied immediately and persisted by the main process.
import { DEFAULT_SETTINGS, LIMITS, type Settings } from '../../shared/types'

const mark = window.mark

const FONT_STACKS = {
  sans: 'system-ui, "Segoe UI", -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Charter, "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
  mono: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace'
} as const

/** Push settings into CSS custom properties used by styles.css. */
export function applySettingsToDom(s: Settings): void {
  const root = document.documentElement.style
  // Horizontal padding of the text column. Percentages in padding are relative to the editor width.
  root.setProperty(
    '--side-padding',
    s.widthMode === 'percent' ? `max(32px, ${s.sideMargin}%)` : `max(40px, calc((100% - ${s.contentWidth}px) / 2))`
  )
  document.documentElement.classList.toggle('wrap-table-cells', s.wrapTableCells)
  root.setProperty('--font-size', `${s.fontSize}px`)
  root.setProperty('--line-height', String(s.lineHeight))
  root.setProperty(
    '--font-family',
    s.fontFamily === 'custom' ? s.customFontFamily.trim() || FONT_STACKS.sans : FONT_STACKS[s.fontFamily]
  )
  root.setProperty('--code-font', s.codeFontFamily)
}

const TEMPLATE = `
<form method="dialog">
  <header>
    <h2>Settings</h2>
    <button class="icon" value="close" aria-label="Close">✕</button>
  </header>

  <section>
    <h3>Appearance</h3>
    <label class="row"><span>Theme</span>
      <select name="theme">
        <option value="system">Follow system</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    <label class="row"><span>Side margins</span>
      <select name="widthMode">
        <option value="fixed">Fixed text width (px)</option>
        <option value="percent">Percentage of window (%)</option>
      </select>
    </label>
    <label class="row" data-when="fixed"><span>Text width</span>
      <span class="ctl"><input type="range" name="contentWidth"
        min="${LIMITS.contentWidth.min}" max="${LIMITS.contentWidth.max}" step="${LIMITS.contentWidth.step}">
        <output data-for="contentWidth"></output></span>
    </label>
    <label class="row" data-when="percent"><span>Margin on each side <small>(0% = full width)</small></span>
      <span class="ctl"><input type="range" name="sideMargin"
        min="${LIMITS.sideMargin.min}" max="${LIMITS.sideMargin.max}" step="${LIMITS.sideMargin.step}">
        <output data-for="sideMargin"></output></span>
    </label>
    <label class="row"><span>Wrap long text in table cells</span><input type="checkbox" name="wrapTableCells"></label>
    <label class="row"><span>Font</span>
      <select name="fontFamily">
        <option value="sans">Sans-serif (system)</option>
        <option value="serif">Serif</option>
        <option value="mono">Monospace</option>
        <option value="custom">Custom…</option>
      </select>
    </label>
    <label class="row" data-when="custom-font"><span>Custom font family</span>
      <input type="text" name="customFontFamily" placeholder='e.g. "Inter", sans-serif' spellcheck="false">
    </label>
    <label class="row"><span>Font size</span>
      <span class="ctl"><input type="range" name="fontSize"
        min="${LIMITS.fontSize.min}" max="${LIMITS.fontSize.max}" step="${LIMITS.fontSize.step}">
        <output data-for="fontSize"></output></span>
    </label>
    <label class="row"><span>Line height</span>
      <span class="ctl"><input type="range" name="lineHeight"
        min="${LIMITS.lineHeight.min}" max="${LIMITS.lineHeight.max}" step="${LIMITS.lineHeight.step}">
        <output data-for="lineHeight"></output></span>
    </label>
    <label class="row"><span>Code font family</span>
      <input type="text" name="codeFontFamily" spellcheck="false">
    </label>
  </section>

  <section>
    <h3>Editing</h3>
    <label class="row"><span>Auto-save <small>(1 s after you stop typing; saved files only)</small></span>
      <input type="checkbox" name="autoSave"></label>
    <label class="row"><span>Spell check</span><input type="checkbox" name="spellcheck"></label>
  </section>

  <section>
    <h3>Startup</h3>
    <label class="row"><span>Keep tabs and unsaved changes when closing <small>(like Sublime Text)</small></span>
      <input type="checkbox" name="hotExit"></label>
    <label class="row" data-when="no-hot-exit"><span>Reopen the files from last time</span><input type="checkbox" name="restoreTabs"></label>
  </section>

  <footer>
    <button type="button" data-action="reset">Reset to defaults</button>
    <button value="close" class="primary">Done</button>
  </footer>
</form>`

export class SettingsDialog {
  private readonly dialog: HTMLDialogElement
  private readonly form: HTMLFormElement
  private saveTimer = 0
  private pending: Partial<Settings> = {}

  constructor(
    private settings: Settings,
    private readonly onChange: (s: Settings) => void
  ) {
    this.dialog = document.createElement('dialog')
    this.dialog.id = 'settings'
    this.dialog.innerHTML = TEMPLATE
    document.body.append(this.dialog)
    this.form = this.dialog.querySelector('form')!

    this.form.addEventListener('input', (e) => this.onInput(e.target as HTMLInputElement))
    this.form.addEventListener('change', (e) => this.onInput(e.target as HTMLInputElement))
    this.form.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
      this.update({ ...DEFAULT_SETTINGS })
      this.fill()
    })
    // Click on the backdrop closes the dialog.
    this.dialog.addEventListener('mousedown', (e) => {
      if (e.target === this.dialog) this.dialog.close()
    })
    this.dialog.addEventListener('close', () => this.flush())
  }

  open(): void {
    this.fill()
    if (!this.dialog.open) this.dialog.showModal()
  }

  private field<T extends HTMLElement = HTMLInputElement>(name: keyof Settings): T {
    return this.form.elements.namedItem(name) as unknown as T
  }

  private fill(): void {
    const s = this.settings
    for (const [key, value] of Object.entries(s) as [keyof Settings, Settings[keyof Settings]][]) {
      const el = this.field<HTMLInputElement | HTMLSelectElement>(key)
      if (!el) continue
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value)
      else el.value = String(value)
    }
    this.syncDisplay()
  }

  private syncDisplay(): void {
    const s = this.settings
    const out = (name: string, text: string) => {
      const o = this.form.querySelector<HTMLOutputElement>(`output[data-for="${name}"]`)
      if (o) o.value = text
    }
    out('contentWidth', `${s.contentWidth}px`)
    out('sideMargin', `${s.sideMargin}%`)
    out('fontSize', `${s.fontSize}px`)
    out('lineHeight', s.lineHeight.toFixed(2))
    const show = (when: string, visible: boolean): void => {
      this.form.querySelector<HTMLElement>(`[data-when="${when}"]`)!.hidden = !visible
    }
    show('fixed', s.widthMode === 'fixed')
    show('percent', s.widthMode === 'percent')
    show('custom-font', s.fontFamily === 'custom')
    show('no-hot-exit', !s.hotExit) // keeping tabs on close already reopens them
  }

  private onInput(el: HTMLInputElement | HTMLSelectElement): void {
    const name = el.name as keyof Settings
    if (!name || !(name in this.settings)) return
    let value: unknown
    if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked
    else if (el instanceof HTMLInputElement && el.type === 'range') value = Number(el.value)
    else value = el.value
    this.update({ [name]: value } as Partial<Settings>)
  }

  /** Apply locally right away; persist (debounced) through the main process, which normalises. */
  private update(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch }
    this.pending = { ...this.pending, ...patch }
    this.syncDisplay()
    this.onChange(this.settings)
    clearTimeout(this.saveTimer)
    // Theme changes go through the main process (nativeTheme), so send those immediately.
    this.saveTimer = window.setTimeout(() => this.flush(), 'theme' in patch ? 0 : 250)
  }

  private flush(): void {
    clearTimeout(this.saveTimer)
    if (!Object.keys(this.pending).length) return
    const patch = this.pending
    this.pending = {}
    void mark.setSettings(patch).then((normalized) => {
      if (Object.keys(this.pending).length) return
      this.settings = normalized
      this.onChange(normalized)
    })
  }
}
