// Thin wrapper around Vditor: one instance per tab.
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { attachTableToolbar } from './tableToolbar'
import { recordUndoStep, unrecordedEdits } from './undo'

export { undoStep } from './undo'

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

  // Tab: never let focus leave the editor. (By default Vditor only handles Tab in lists and
  // tables; anywhere else the browser moved focus to the next button and, after a few presses,
  // into the window menu bar, where every keystroke made Windows beep.)
  container.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return
      const target = e.target as HTMLElement
      const anchor = getSelection()?.anchorNode
      const at = anchor ? (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element)) : null
      const inCode = target.matches('textarea.vditor-sv') || !!at?.closest('.vditor-ir__marker--pre')
      if (!inCode) return // lists and tables: Vditor handles it (see the fallback below)
      e.preventDefault()
      e.stopPropagation()
      if (!e.shiftKey) document.execCommand('insertText', false, INDENT)
    },
    true
  )
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.defaultPrevented) e.preventDefault()
  })

  container.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return
      const range = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0) : null
      if (!range) return
      const at = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : (range.startContainer as Element)
      if (!at?.closest('.vditor-ir')) return

      // Enter in a table moves down a row (adding one at the end), like Typora.
      // Shift+Enter keeps Vditor's line break inside the cell.
      const cell = at.closest('td, th')
      if (cell && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        const row = cell.parentElement as HTMLTableRowElement
        const lastRow = cell.tagName === 'TH' ? !row.closest('table')?.tBodies.length : !row.nextElementSibling
        // Vditor's own table commands: Ctrl+= adds a row below, ArrowDown moves down a row.
        if (lastRow) at.dispatchEvent(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true, bubbles: true, cancelable: true }))
        at.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }))
        return
      }

      // Shift+Enter at the end of a paragraph or list item: Vditor trims the trailing newline
      // before you type the next line, which glued "line one" and "line two" together. Insert the
      // break plus an invisible placeholder without triggering Vditor's re-render; it's processed
      // with the next keystroke. (Mid-line, the default Shift+Enter works.)
      const block = e.shiftKey ? at.closest('p, li') : null
      if (block && !cell) {
        const rest = document.createRange()
        rest.setStart(range.endContainer, range.endOffset)
        rest.setEnd(block, block.childNodes.length)
        if (rest.toString().replace(/[​\n]/g, '') !== '') return
        e.preventDefault()
        e.stopPropagation()
        const brk = document.createTextNode('\n​')
        range.deleteContents()
        range.insertNode(brk)
        range.setStartAfter(brk)
        range.collapse(true)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(range)
      }
    },
    true
  )

  // Autocomplete popup (languages after ```, emoji after " :"). Enter keeps what you typed, like
  // Typora: ```py + Enter starts a "py" block. To pick a suggestion use the arrow keys, then Enter
  // (or click it). Enter only accepts a suggestion after you've moved through the list.
  let pickedWithArrows = false
  container.addEventListener(
    'keydown',
    (e) => {
      const inner = hintInternals(editor)
      if (!inner || inner.hint.element.style.display !== 'block' || e.isComposing) {
        pickedWithArrows = false
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        pickedWithArrows = true
        inner.hint.select(e, inner.vditor) // moves the highlight; stops the event
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (pickedWithArrows) inner.hint.select(e, inner.vditor) // inserts the highlighted entry
        else inner.hint.element.style.display = 'none' // let Vditor handle Enter normally
        pickedWithArrows = false
      } else if (e.key !== 'Shift') {
        pickedWithArrows = false
      }
    },
    true
  )

  // Track edits Vditor hasn't put in its undo history yet (see undoStep): typing, plus Vditor's
  // own commands, which handle the key themselves (Ctrl+B, table shortcuts, list Tab, ...).
  container.addEventListener('input', () => unrecordedEdits.add(editor))
  container.addEventListener('keydown', (e) => {
    if (e.defaultPrevented && !/^(Arrow|Page|Home|End|Escape)/.test(e.key)) unrecordedEdits.add(editor)
  })

  const editor: Vditor = new Vditor(container, {
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
    after: () => {
      tameHints(editor)
      recordInitialUndoState(editor)
      // Added after Vditor has built its UI (it clears the container while starting up).
      attachTableToolbar(container, () => editor, () => hooks.onInput())
      hooks.onReady()
    },
    input: () => {
      // Runs in the same tick in which Vditor records its undo step.
      unrecordedEdits.delete(editor)
      hooks.onInput()
    }
  })
  return editor
}

/** What Tab inserts in code blocks and in source mode. */
const INDENT = '    '

/** Suggested first in the code-block language list; everything highlight.js knows follows. */
const COMMON_LANGUAGES = [
  'javascript', 'typescript', 'python', 'bash', 'shell', 'powershell', 'json', 'yaml', 'html', 'xml',
  'css', 'scss', 'sql', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift',
  'dart', 'lua', 'r', 'markdown', 'diff', 'dockerfile', 'ini', 'plaintext', 'mermaid', 'math'
]
/** Vditor's extra languages: diagram renderers and aliases. */
const VDITOR_LANGUAGES = [
  'js', 'ts', 'toml', 'c#', 'bat', 'flowchart', 'graphviz', 'plantuml', 'echarts', 'mindmap', 'markmap',
  'wavedrom', 'smiles', 'abc'
]

interface HintInternals {
  element: HTMLElement
  recentLanguage: string
  genHTML(data: unknown[], key: string, vditor: unknown): void
  select(event: KeyboardEvent, vditor: unknown): boolean
}
interface VditorInternals {
  hint?: HintInternals
  options: { preview: { hljs: { langs?: string[] } } }
}

/** Vditor's autocomplete popup and its owner (Vditor internals; available once loaded). */
function hintInternals(editor: Vditor | undefined): { hint: HintInternals; vditor: VditorInternals } | null {
  const inner = (editor as unknown as { vditor?: VditorInternals } | undefined)?.vditor
  return inner?.hint ? { hint: inner.hint, vditor: inner } : null
}

/**
 * Makes Vditor's autocomplete popup (code-block languages after ```, emoji after " :") less
 * pushy. Uses Vditor internals; re-check after upgrading Vditor.
 */
function tameHints(editor: Vditor): void {
  const found = hintInternals(editor)
  if (!found) return
  const { hint, vditor: inner } = found

  // Vditor pre-fills every new code block with the last language used. Don't.
  Object.defineProperty(hint, 'recentLanguage', { get: () => '', set: () => {}, configurable: true })

  // Only suggest once something has been typed. With nothing typed the popup still opened with its
  // first entry pre-selected, so pressing Enter to start the code inserted that entry (e.g. "abc").
  const genHTML = hint.genHTML.bind(hint)
  hint.genHTML = (data, key, vditor) => {
    if (!key) {
      hint.element.style.display = 'none'
      return
    }
    genHTML(data, key, vditor)
  }

  // Offer every language highlight.js knows (index.html preloads it), common ones first.
  // Without this the list was only Vditor's 17 built-ins until a code block had been rendered.
  const known = (window as unknown as { hljs?: { listLanguages(): string[] } }).hljs?.listLanguages() ?? []
  inner.options.preview.hljs.langs = [...new Set([...COMMON_LANGUAGES, ...[...known].sort(), ...VDITOR_LANGUAGES])]
}

/** Vditor hard-codes spellcheck="false" on its editing surfaces; flip it per the setting. */
export function setSpellcheck(container: HTMLElement, on: boolean): void {
  container
    .querySelectorAll<HTMLElement>('.vditor-ir > .vditor-reset, .vditor-wysiwyg > .vditor-reset, textarea.vditor-sv')
    .forEach((el) => (el.spellcheck = on))
}

/**
 * Vditor records the starting state 0.8 s after loading, and every keystroke postpones that, so
 * typing straight away left nothing to undo back to. Record it as soon as the editor is ready.
 */
const recordInitialUndoState = (editor: Vditor): void => recordUndoStep(editor)

/** Whether the caret is inside a table cell of this editor (Vditor has table shortcuts there). */
export function caretInTable(): boolean {
  const node = getSelection()?.anchorNode
  const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null
  return !!el?.closest('.vditor-ir td, .vditor-ir th')
}
