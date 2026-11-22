// Syntax highlighting for the code block you're editing.
//
// While the cursor is in a code block, the editor shows its source as plain editable text (the
// highlighted copy is hidden, see styles.css). Wrapping that text in highlight spans would fight
// with the editor, so instead we run highlight.js on the text and colour the token ranges with the
// CSS Custom Highlight API, which paints text without touching the DOM.

interface Hljs {
  getLanguage(name: string): unknown
  highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string }
}

/** highlight.js class → colour group (the colours are in styles.css as ::highlight(hl-<group>)). */
const GROUPS: Record<string, string> = {
  keyword: 'kw',
  doctag: 'kw',
  'template-tag': 'kw',
  'template-variable': 'kw',
  type: 'kw',
  title: 'title',
  attr: 'const',
  attribute: 'const',
  literal: 'const',
  meta: 'const',
  number: 'const',
  operator: 'const',
  variable: 'const',
  property: 'const',
  'selector-attr': 'const',
  'selector-class': 'const',
  'selector-id': 'const',
  regexp: 'str',
  string: 'str',
  built_in: 'builtin',
  symbol: 'builtin',
  comment: 'comment',
  code: 'comment',
  formula: 'comment',
  name: 'name',
  quote: 'name',
  'selector-tag': 'name',
  'selector-pseudo': 'name',
  section: 'section',
  bullet: 'bullet',
  addition: 'add',
  deletion: 'del'
}
const ALL_GROUPS = [...new Set(Object.values(GROUPS))]

function groupOf(el: Element): string | null {
  for (let e: Element | null = el; e && e.tagName === 'SPAN'; e = e.parentElement) {
    const cls = Array.from(e.classList)
    if (cls.includes('language_')) return 'kw' // e.g. `this`, `self`
    const name = cls.find((c) => c.startsWith('hljs-'))?.slice(5)
    if (name && GROUPS[name]) return GROUPS[name]
  }
  return null
}

/** Ranges per colour group for one code element. */
function tokenize(code: HTMLElement, out: Map<string, Range[]>): void {
  const hljs = (window as unknown as { hljs?: Hljs }).hljs
  const lang = /(?:^|\s)language-([\w#+-]+)/.exec(code.className)?.[1]
  if (!hljs || !lang || !hljs.getLanguage(lang)) return

  // Live text nodes of the editable code, with their start offsets.
  const nodes: Array<{ node: Text; start: number }> = []
  let text = ''
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length })
    text += (n as Text).data
  }
  if (!text.trim() || text.length > 200_000) return

  const tpl = document.createElement('template')
  tpl.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  const locate = (offset: number): [Text, number] | null => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (nodes[mid].start <= offset) lo = mid
      else hi = mid - 1
    }
    const n = nodes[lo]
    return n ? [n.node, Math.min(offset - n.start, n.node.length)] : null
  }

  let pos = 0
  const tw = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT)
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const len = (n as Text).data.length
    const group = n.parentElement ? groupOf(n.parentElement) : null
    if (group && len) {
      const a = locate(pos)
      const b = locate(pos + len)
      if (a && b) {
        const r = document.createRange()
        r.setStart(a[0], a[1])
        r.setEnd(b[0], b[1])
        if (!out.has(group)) out.set(group, [])
        out.get(group)!.push(r)
      }
    }
    pos += len
  }
}

let timer = 0

/** Re-colour the code block(s) being edited in the visible editor. Cheap; call on every edit. */
export function scheduleCodeHighlight(): void {
  if (!('highlights' in CSS)) return
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    const groups = new Map<string, Range[]>()
    document
      .querySelectorAll<HTMLElement>(
        '.pane:not([hidden]) .vditor-ir__node--expand[data-type="code-block"] .vditor-ir__marker--pre > code'
      )
      .forEach((code) => tokenize(code, groups))
    for (const g of ALL_GROUPS) {
      const ranges = groups.get(g)
      if (ranges?.length) CSS.highlights.set(`hl-${g}`, new Highlight(...ranges))
      else CSS.highlights.delete(`hl-${g}`)
    }
  }, 30)
}

/** Keep the colours in step with typing and with the cursor moving into/out of code blocks. */
export function installCodeHighlighting(): void {
  document.addEventListener('selectionchange', scheduleCodeHighlight)
  document.addEventListener('input', scheduleCodeHighlight, true)
}
