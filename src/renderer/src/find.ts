// Find & replace (Ctrl+F / Ctrl+H).
//
// Rendered mode: searches the text you can see. Matches are painted with the CSS Custom Highlight
// API (no DOM changes, so the editor is unaffected), and replacements are typed in with
// execCommand('insertText'), exactly as if you had typed them, so the editor stays consistent and
// Ctrl+Z works. Source mode: works on the plain text area.

export interface FindTarget {
  mode: 'ir' | 'sv'
  /** The editing surface: the rendered editor element, or the source-mode text area. */
  root: HTMLElement
  /** The scroll container. */
  pane: HTMLElement
  /** Record an edit made directly to the editor's text (undo step, unsaved state, backup). */
  afterEdit(): void
}

interface Options {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

interface Segment {
  node: Text
  start: number
}

type Match = { range: Range; text: string } | { start: number; end: number; text: string }

const HIGHLIGHT_ALL = 'find-match'
const HIGHLIGHT_CURRENT = 'find-current'

// Text that is on screen but isn't document text, or can't be edited as text.
const SKIP = '.vditor-copy, .katex, .vditor-ir__marker--info, [data-type="math-inline"], [data-type="math-block"], [data-type="html-block"] .vditor-ir__preview'

const TEMPLATE = `
  <div class="find-row">
    <input class="find-input" type="text" placeholder="Find" spellcheck="false" aria-label="Find">
    <span class="find-count" aria-live="polite"></span>
    <button type="button" data-act="prev" title="Previous match (Shift+Enter, Shift+F3)">↑</button>
    <button type="button" data-act="next" title="Next match (Enter, F3)">↓</button>
    <button type="button" data-opt="caseSensitive" title="Match case" aria-pressed="false">Aa</button>
    <button type="button" data-opt="wholeWord" title="Whole word" aria-pressed="false"><u>ab</u></button>
    <button type="button" data-opt="regex" title="Regular expression" aria-pressed="false">.*</button>
    <button type="button" data-act="toggle-replace" title="Show replace (Ctrl+H)">⇅</button>
    <button type="button" data-act="close" title="Close (Esc)">✕</button>
  </div>
  <div class="replace-row">
    <input class="replace-input" type="text" placeholder="Replace" spellcheck="false" aria-label="Replace">
    <button type="button" data-act="replace" title="Replace this match (Enter)">Replace</button>
    <button type="button" data-act="replace-all" title="Replace all matches">All</button>
  </div>`

export class FindBar {
  private readonly bar: HTMLElement
  private readonly findInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly count: HTMLElement
  private readonly opts: Options = { caseSensitive: false, wholeWord: false, regex: false }
  private matches: Match[] = []
  private current = -1
  private target: FindTarget | null = null
  private refreshTimer = 0

  constructor(
    container: HTMLElement,
    private readonly getTarget: () => FindTarget | null
  ) {
    this.bar = document.createElement('div')
    this.bar.id = 'find-bar'
    this.bar.hidden = true
    this.bar.innerHTML = TEMPLATE
    container.append(this.bar)
    this.findInput = this.bar.querySelector('.find-input')!
    this.replaceInput = this.bar.querySelector('.replace-input')!
    this.count = this.bar.querySelector('.find-count')!

    this.findInput.addEventListener('input', () => this.search(true))
    this.bar.addEventListener('mousedown', (e) => {
      // Buttons shouldn't steal focus from the inputs.
      if ((e.target as HTMLElement).closest('button')) e.preventDefault()
    })
    this.bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button')
      if (!btn) return
      const opt = btn.dataset.opt as keyof Options | undefined
      if (opt) {
        this.opts[opt] = !this.opts[opt]
        btn.setAttribute('aria-pressed', String(this.opts[opt]))
        this.search(true)
        return
      }
      switch (btn.dataset.act) {
        case 'next':
          return this.step(1)
        case 'prev':
          return this.step(-1)
        case 'close':
          return this.close()
        case 'toggle-replace':
          return this.setReplaceMode(!this.bar.classList.contains('with-replace'))
        case 'replace':
          return this.replaceCurrent()
        case 'replace-all':
          return this.replaceAll()
      }
    })
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.step(e.shiftKey ? -1 : 1)
      }
    })
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.ctrlKey || e.altKey) this.replaceAll()
        else this.replaceCurrent()
      }
    })
    this.bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.close()
      }
    })
  }

  get isOpen(): boolean {
    return !this.bar.hidden
  }

  open(withReplace: boolean): void {
    const selected = getSelection()?.toString() ?? ''
    if (selected && selected.length < 200 && !selected.includes('\n')) this.findInput.value = selected
    this.bar.hidden = false
    this.setReplaceMode(withReplace)
    const input = withReplace && this.findInput.value ? this.replaceInput : this.findInput
    input.focus()
    input.select()
    this.search(true)
  }

  close(): void {
    if (this.bar.hidden) return
    this.bar.hidden = true
    const m = this.matches[this.current]
    this.clearHighlights()
    // Put the cursor on the current match in the editor.
    const t = this.getTarget()
    if (t && m) this.select(t, m)
    else t?.root.focus({ preventScroll: true })
    this.matches = []
  }

  /** Re-run the search after the document or the active tab changed (no-op when closed). */
  refresh(): void {
    if (this.bar.hidden) return
    clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => this.search(false), 150)
  }

  next(): void {
    if (!this.isOpen) this.open(false)
    else this.step(1)
  }

  previous(): void {
    if (!this.isOpen) this.open(false)
    else this.step(-1)
  }

  private setReplaceMode(on: boolean): void {
    this.bar.classList.toggle('with-replace', on)
  }

  // ---------------------------------------------------------------- searching

  private pattern(): RegExp | null {
    const q = this.findInput.value
    if (!q) return null
    let source = this.opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (this.opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
    try {
      return new RegExp(source, 'gu' + (this.opts.caseSensitive ? '' : 'i'))
    } catch {
      return null // incomplete regular expression while typing
    }
  }

  /** Visible text of the rendered editor, as one string plus the text nodes it came from. */
  private collectText(root: HTMLElement): { text: string; segments: Segment[] } {
    const segments: Segment[] = []
    let text = ''
    let lastBlock: Element | null = null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement
        if (!p || !(n as Text).data || p.closest(SKIP)) return NodeFilter.FILTER_REJECT
        // Markdown syntax (`**`, `#`, link URLs, ...) isn't searched, even while it's shown for
        // editing. The one exception is the source of the code block being edited (when it isn't
        // being edited, its highlighted copy is searched instead).
        const marker = p.closest('.vditor-ir__marker')
        if (marker) {
          const source = p.closest('.vditor-ir__marker--pre')
          if (!source?.closest('.vditor-ir__node')?.classList.contains('vditor-ir__node--expand')) {
            return NodeFilter.FILTER_REJECT
          }
        }
        return p.checkVisibility({ visibilityProperty: true }) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      }
    })
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      // Keep matches from running across block boundaries.
      const block = n.parentElement!.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, [data-block]')
      if (block !== lastBlock && text) text += '\n'
      lastBlock = block
      segments.push({ node: n, start: text.length })
      text += n.data
    }
    return { text, segments }
  }

  private rangeFor(segments: Segment[], start: number, end: number): Range | null {
    // An offset where one text node ends and the next begins belongs to the next node when it is
    // a match's start, and to the previous node when it is a match's end. (Otherwise a match that
    // ends a bold word would reach into the hidden `**` after it.)
    const locate = (offset: number, isEnd: boolean): [Text, number] | null => {
      let lo = 0
      let hi = segments.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (isEnd ? segments[mid].start < offset : segments[mid].start <= offset) lo = mid
        else hi = mid - 1
      }
      const s = segments[lo]
      return s ? [s.node, Math.min(Math.max(0, offset - s.start), s.node.length)] : null
    }
    const a = locate(start, false)
    const b = locate(end, true)
    if (!a || !b) return null
    const r = document.createRange()
    r.setStart(a[0], a[1])
    r.setEnd(b[0], b[1])
    return r
  }

  private search(resetPosition: boolean): void {
    const t = (this.target = this.getTarget())
    const re = this.pattern()
    this.findInput.classList.toggle('invalid', !!this.findInput.value && !re)
    const previous = this.matches[this.current]
    this.matches = []
    if (t && re) {
      if (t.mode === 'sv') {
        const value = (t.root as HTMLTextAreaElement).value
        for (const m of value.matchAll(re)) {
          if (!m[0]) continue
          this.matches.push({ start: m.index!, end: m.index! + m[0].length, text: m[0] })
          if (this.matches.length >= 10_000) break
        }
      } else {
        const { text, segments } = this.collectText(t.root)
        for (const m of text.matchAll(re)) {
          if (!m[0]) continue
          const range = this.rangeFor(segments, m.index!, m.index! + m[0].length)
          if (range) this.matches.push({ range, text: m[0] })
          if (this.matches.length >= 10_000) break
        }
      }
    }
    // Which match is "current": the first one at/after the cursor (or the old current match).
    this.current = this.matches.length ? 0 : -1
    if (this.matches.length && t) {
      const anchor = resetPosition ? this.caret(t) : previous
      if (anchor) {
        const i = this.matches.findIndex((m) => this.compare(m, anchor) >= 0)
        this.current = i >= 0 ? i : 0
      }
    }
    this.paint()
    if (resetPosition) this.reveal()
  }

  /** Where the cursor is in the editor, as a zero-width match (for picking the nearest match). */
  private caret(t: FindTarget): Match | null {
    if (t.mode === 'sv') {
      const ta = t.root as HTMLTextAreaElement
      return { start: ta.selectionStart, end: ta.selectionStart, text: '' }
    }
    const sel = getSelection()
    if (!sel?.rangeCount || !t.root.contains(sel.anchorNode)) return null
    const r = sel.getRangeAt(0).cloneRange()
    r.collapse(true)
    return { range: r, text: '' }
  }

  /** Document order of two matches (by start). */
  private compare(a: Match, b: Match): number {
    try {
      if ('range' in a && 'range' in b) return a.range.compareBoundaryPoints(Range.START_TO_START, b.range)
      if ('start' in a && 'start' in b) return a.start - b.start
    } catch {
      // `b` was in text the editor has since re-rendered.
    }
    return 0
  }

  private step(dir: 1 | -1): void {
    if (!this.matches.length) return this.search(true)
    this.current = (this.current + dir + this.matches.length) % this.matches.length
    this.paint()
    this.reveal()
  }

  // ---------------------------------------------------------------- display

  private paint(): void {
    const n = this.matches.length
    this.count.textContent = this.findInput.value ? (n ? `${this.current + 1} of ${n}${n >= 10_000 ? '+' : ''}` : 'No results') : ''
    this.clearHighlights()
    if (!('highlights' in CSS)) return
    const ranges = this.matches.flatMap((m) => ('range' in m ? [m.range] : []))
    if (ranges.length) CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges))
    const cur = this.matches[this.current]
    if (cur && 'range' in cur) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(cur.range))
  }

  private clearHighlights(): void {
    if (!('highlights' in CSS)) return
    CSS.highlights.delete(HIGHLIGHT_ALL)
    CSS.highlights.delete(HIGHLIGHT_CURRENT)
  }

  /** Scroll the current match into the middle of the view. */
  private reveal(): void {
    const t = this.target
    const m = this.matches[this.current]
    if (!t || !m) return
    if ('range' in m) {
      const rect = m.range.getBoundingClientRect()
      const pane = t.pane.getBoundingClientRect()
      if (rect.top < pane.top + 60 || rect.bottom > pane.bottom - 20) {
        t.pane.scrollTop += rect.top - pane.top - pane.height / 3
      }
    } else {
      // Source mode: select the match in the text area (shown even while the find box has focus).
      const ta = t.root as HTMLTextAreaElement
      ta.setSelectionRange(m.start, m.end)
      const line = ta.value.slice(0, m.start).split('\n').length - 1
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24
      ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3)
    }
  }

  /** Put the editor's cursor/selection on a match. */
  private select(t: FindTarget, m: Match): void {
    if ('range' in m) {
      t.root.focus({ preventScroll: true })
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(m.range)
    } else {
      const ta = t.root as HTMLTextAreaElement
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(m.start, m.end)
    }
  }

  // ---------------------------------------------------------------- replacing

  /** The replacement for one match ($1 etc. work in regular-expression mode). */
  private replacementFor(matchText: string): string {
    const replacement = this.replaceInput.value
    if (!this.opts.regex) return replacement
    const re = this.pattern()
    if (!re) return replacement
    return matchText.replace(new RegExp(re.source, re.flags.replace('g', '')), replacement)
  }

  /**
   * In a code block that isn't being edited, the visible text is a highlighted copy that can't be
   * edited. Move the match to the same characters in the editable source (same text), opening it.
   */
  private toEditable(range: Range): Range | null {
    const start = range.startContainer.parentElement
    const preview = start?.closest('.vditor-ir__preview')
    if (!preview) return range
    const node = preview.closest('[data-type="code-block"]')
    const code = node?.querySelector<HTMLElement>('.vditor-ir__marker--pre > code')
    const shown = preview.querySelector('code')
    if (!node || !code || !shown) return null
    const before = document.createRange()
    before.setStart(shown, 0)
    before.setEnd(range.startContainer, range.startOffset)
    const offset = before.toString().length
    const length = range.toString().length
    node.classList.add('vditor-ir__node--expand')
    const segments: Segment[] = []
    let pos = 0
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      segments.push({ node: n, start: pos })
      pos += n.data.length
    }
    return this.rangeFor(segments, offset, offset + length)
  }

  private replaceOne(t: FindTarget, m: Match): void {
    const replacement = this.replacementFor(m.text)
    if ('range' in m) {
      const range = this.toEditable(m.range)
      if (range) this.replaceText(t.root, range, replacement)
      return
    }
    // Source mode: typed into the text area, so it can be undone like typing.
    const ta = t.root as HTMLTextAreaElement
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(m.start, m.end)
    if (replacement) document.execCommand('insertText', false, replacement)
    else document.execCommand('delete')
  }

  /**
   * Rendered mode: change the matched characters inside their existing text nodes and put the
   * cursor after them. Bold, links etc. around the text stay intact (the browser's own "insert
   * text" removes an element whose whole text is replaced, and the editor's re-render of such an
   * edit drops the closing `**`), and a plain text change needs no re-render. The caller records
   * the edit through FindTarget.afterEdit. In a code block the editor is told, like typing, so
   * it refreshes the highlighted copy.
   */
  private replaceText(root: HTMLElement, range: Range, text: string): void {
    const start = range.startContainer as Text
    const end = range.endContainer as Text
    const startOffset = range.startOffset
    if (start === end) {
      start.replaceData(startOffset, range.endOffset - startOffset, text)
    } else {
      const nodes: Text[] = []
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (range.intersectsNode(n)) nodes.push(n)
      }
      for (const n of nodes) {
        // Never touch hidden markdown syntax that lies between the parts of a match.
        const p = n.parentElement
        if (p?.closest('.vditor-ir__marker') && !p.closest('.vditor-ir__marker--pre')) continue
        if (n === start) n.replaceData(startOffset, n.length - startOffset, text)
        else if (n === end) n.deleteData(0, range.endOffset)
        else n.data = ''
      }
    }
    root.focus({ preventScroll: true })
    const caret = document.createRange()
    caret.setStart(start, Math.min(startOffset + text.length, start.length))
    caret.collapse(true)
    const sel = getSelection()!
    sel.removeAllRanges()
    sel.addRange(caret)
    if (start.parentElement?.closest('.vditor-ir__marker--pre')) {
      root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }))
    }
  }

  private replaceCurrent(): void {
    const t = this.getTarget()
    const m = this.matches[this.current]
    if (!t || !m) return this.search(true)
    this.replaceOne(t, m)
    if (t.mode === 'ir') t.afterEdit()
    this.replaceInput.focus({ preventScroll: true })
    // Continue with the next match after the replaced text.
    this.search(false)
    const anchor = this.caretAfterEdit(t)
    if (anchor) {
      const i = this.matches.findIndex((x) => this.compare(x, anchor) >= 0)
      this.current = i >= 0 ? i : this.matches.length ? 0 : -1
      this.paint()
    }
    this.reveal()
  }

  private caretAfterEdit(t: FindTarget): Match | null {
    if (t.mode === 'sv') {
      const ta = t.root as HTMLTextAreaElement
      return { start: ta.selectionEnd, end: ta.selectionEnd, text: '' }
    }
    const sel = getSelection()
    if (!sel?.rangeCount) return null
    const r = sel.getRangeAt(0).cloneRange()
    r.collapse(false)
    return { range: r, text: '' }
  }

  private replaceAll(): void {
    const t = this.getTarget()
    const re = this.pattern()
    if (!t || !re) return
    let replaced = 0
    if (t.mode === 'sv') {
      const ta = t.root as HTMLTextAreaElement
      replaced = [...ta.value.matchAll(re)].filter((m) => m[0]).length
      // Regular expressions: $1 etc. are expanded. Plain text: inserted literally.
      const replacement = this.replaceInput.value
      const value = this.opts.regex ? ta.value.replace(re, replacement) : ta.value.replace(re, () => replacement)
      if (replaced) {
        ta.focus({ preventScroll: true })
        ta.select()
        document.execCommand('insertText', false, value) // one undo step
      }
    } else {
      // One match at a time, always continuing after the text just inserted, so a replacement
      // that contains the search text can't loop forever.
      this.search(false)
      let next: Match | undefined = this.matches[0]
      while (next && replaced < 10_000) {
        this.replaceOne(t, next)
        replaced++
        const anchor = this.caretAfterEdit(t)
        this.search(false)
        next = anchor ? this.matches.find((x) => this.compare(x, anchor) >= 0) : undefined
      }
      if (replaced) t.afterEdit() // one undo step for all of them
    }
    this.replaceInput.focus({ preventScroll: true })
    this.search(false)
    this.count.textContent = `Replaced ${replaced}`
  }
}
