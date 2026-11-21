// Thin wrapper around Vditor: one instance per tab.
import Vditor from 'vditor'
import 'vditor/dist/index.css'

export type EditMode = 'ir' | 'sv'

export interface EditorHooks {
  onReady(): void
  onInput(): void
  /** Ctrl+click on a link. `href` is the raw link destination as written in the markdown. */
  onLinkClick(href: string): void
}

export interface EditorConfig {
  value: string
  mode: EditMode
  filePath: string | null
  dark: boolean
}

/**
 * Vditor lazy-loads Lute, i18n, icons, themes, highlight.js, KaTeX, Mermaid, ... from
 * `${cdn}/dist/...`. scripts/copy-vditor-assets.mjs copies them into public/vditor so they
 * are served locally (dev server and packaged app alike) and the editor works offline.
 */
const ASSETS = './vditor'

/**
 * The toolbar is hidden, but Vditor binds its keyboard shortcuts to toolbar items, so the
 * items stay defined. Shortcuts that clash with app shortcuts are removed
 * (ordered-list would steal Ctrl+O).
 */
const TOOLBAR: Array<string | IMenuItem> = [
  'headings', // Ctrl+H
  'bold', // Ctrl+B
  'italic', // Ctrl+I
  'strike', // Ctrl+D
  'link', // Ctrl+K
  'list', // Ctrl+L
  { name: 'ordered-list', hotkey: '' },
  'check', // Ctrl+J
  'outdent', // Ctrl+Shift+I
  'indent', // Ctrl+Shift+O
  'quote', // Ctrl+;
  'line', // Ctrl+Shift+H
  'code', // Ctrl+U
  'inline-code', // Ctrl+G
  'insert-before', // Ctrl+Shift+B
  'insert-after', // Ctrl+Shift+E
  'table', // Ctrl+M
  'undo', // Ctrl+Z
  'redo' // Ctrl+Y
]

/** URL prefix that serves files next to `filePath` through the mdfile:// protocol. */
export function fileBaseUrl(filePath: string | null): string {
  if (!filePath) return ''
  const dir = filePath.replace(/[\\/][^\\/]*$/, '')
  return `mdfile://local/${dir.split(/[\\/]/).map(encodeURIComponent).join('/')}/`
}

export const themeArgs = (dark: boolean) =>
  [dark ? 'dark' : 'classic', dark ? 'dark' : 'light', dark ? 'github-dark' : 'github'] as const

export function createEditor(container: HTMLElement, cfg: EditorConfig, hooks: EditorHooks): Vditor {
  const [theme, contentTheme, codeTheme] = themeArgs(cfg.dark)

  // index.html loads the icon sprite; this marker stops Vditor from injecting it as an inline
  // script (blocked by the CSP). Vditor's destroy() removes the marker, so re-add it each time.
  if (!document.getElementById('vditorIconScript')) {
    const marker = document.createElement('meta')
    marker.id = 'vditorIconScript'
    document.head.append(marker)
  }

  container.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement

      // Code block "copy" button: Vditor wires it with inline onclick handlers, which the CSP blocks.
      const copyBtn = target.closest<HTMLElement>('.vditor-copy > span')
      if (copyBtn) {
        e.preventDefault()
        e.stopPropagation()
        const code = (copyBtn.previousElementSibling as HTMLTextAreaElement | null)?.value ?? ''
        void navigator.clipboard.writeText(code).then(() => copyBtn.setAttribute('aria-label', 'Copied'))
        copyBtn.addEventListener('mouseleave', () => copyBtn.setAttribute('aria-label', 'Copy'), { once: true })
        return
      }

      // Ctrl+click opens links (like Typora); a plain click just places the cursor.
      if (!(e.ctrlKey || e.metaKey)) return
      const node = target.closest('[data-type="a"]')
      const href =
        node?.querySelector(':scope > .vditor-ir__marker--link')?.textContent ??
        target.closest('a')?.getAttribute('href') ??
        ''
      if (!href.trim()) return
      e.preventDefault()
      e.stopPropagation()
      hooks.onLinkClick(href.trim())
    },
    true
  )

  return new Vditor(container, {
    mode: cfg.mode,
    value: cfg.value,
    cdn: ASSETS,
    lang: 'en_US',
    width: '100%',
    height: 'auto',
    cache: { enable: false },
    toolbar: TOOLBAR,
    toolbarConfig: { hide: true },
    theme,
    icon: 'ant',
    preview: {
      mode: 'editor', // source mode: plain markdown, no side-by-side preview
      theme: { current: contentTheme, path: `${ASSETS}/dist/css/content-theme` },
      hljs: { style: codeTheme, lineNumber: false },
      math: { engine: 'KaTeX' },
      markdown: { linkBase: fileBaseUrl(cfg.filePath), sanitize: true }
    },
    hint: { emojiPath: `${ASSETS}/dist/images/emoji` },
    link: { isOpen: false, click: () => {} },
    after: () => hooks.onReady(),
    input: () => hooks.onInput()
  })
}

/** Vditor hard-codes spellcheck="false" on its editing surfaces; flip it per the setting. */
export function setSpellcheck(container: HTMLElement, on: boolean): void {
  container
    .querySelectorAll<HTMLElement>('.vditor-ir > .vditor-reset, .vditor-wysiwyg > .vditor-reset, textarea.vditor-sv')
    .forEach((el) => (el.spellcheck = on))
}

/** Vditor's redo is Ctrl+Y only; also support Ctrl+Shift+Z. Uses Vditor internals. */
export function redo(editor: Vditor): void {
  const inner = (editor as unknown as { vditor?: { undo?: { redo(v: unknown): void } } }).vditor
  inner?.undo?.redo(inner)
}
