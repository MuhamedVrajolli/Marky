// Links in the editor: finding the link under the mouse, and revealing a clicked link's markdown.
import type { LinkInfo } from '../../shared/types'

/** Vditor uses zero-width spaces as caret anchors; they aren't part of the text. */
const clean = (s: string | null | undefined): string => (s ?? '').replace(/​/g, '')

/** Wraps a destination in <> when markdown needs it (spaces or parentheses). */
const destination = (href: string): string => (/[\s()]/.test(href) ? `<${href}>` : href)

/** A link's visible text: its content without markdown markers, or an image's alt text. */
function linkText(node: Element): string {
  const copy = node.cloneNode(true) as Element
  copy.querySelectorAll('.vditor-ir__marker').forEach((m) => m.remove())
  return clean(copy.textContent).trim() || (node.querySelector('img')?.alt ?? '')
}

const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase()

/** Looks up the destination of a reference link ([text][label]) in the document's definitions. */
function referenceUrl(node: Element, label: string): string {
  const editor = node.closest('.vditor-reset')
  const wanted = normalizeLabel(label)
  for (const defs of editor?.querySelectorAll('[data-type="link-ref-defs-block"]') ?? []) {
    for (const line of clean(defs.textContent).split('\n')) {
      const m = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]*)>|(\S+))/.exec(line)
      if (m && normalizeLabel(m[1]) === wanted) return m[2] ?? m[3]
    }
  }
  return ''
}

/**
 * The link at `target`, if any: a markdown link, a reference link, or an <a> in rendered HTML.
 * `href` is the destination as written in the document.
 */
export function linkAt(target: Element | null): LinkInfo | null {
  const node = target?.closest('.vditor-ir [data-type="a"], .vditor-ir [data-type="link-ref"]')
  if (node) {
    const text = linkText(node)
    const marker = clean(node.querySelector(':scope > .vditor-ir__marker--link')?.textContent)
    const source = clean(node.textContent)
    if (node.getAttribute('data-type') === 'a') {
      const href = marker.trim()
      return href ? { href, text, markdown: source } : null
    }
    // [text][label], [text][] or [text]
    const href = referenceUrl(node, marker.replace(/^\[|\]$/g, '') || text)
    if (!href) return null
    return { href, text, markdown: `${source.slice(0, source.length - marker.length)}(${destination(href)})` }
  }
  const a = target?.closest('.vditor-ir a[href]')
  const href = a?.getAttribute('href')?.trim()
  if (!a || !href) return null
  const text = clean(a.textContent).trim()
  return { href, text, markdown: `[${text}](${destination(href)})` }
}

/** The outermost formatted element (Vditor "node") containing `n`, below `root`. */
function topNode(n: Node, root: Element): Element | null {
  let top: Element | null = null
  for (let el = n instanceof Element ? n : n.parentElement; el && el !== root; el = el.parentElement) {
    if (el.classList.contains('vditor-ir__node')) top = el
  }
  return top
}

/**
 * Clicking formatted text reveals its markdown, except for links: for those Vditor calls its
 * `link.click` option (meant for opening the link) and stops, so the link stayed rendered and its
 * destination couldn't be seen or edited. This does what Vditor does for everything else.
 */
export function revealClickedLink(container: HTMLElement): void {
  const root = container.querySelector('.vditor-ir > .vditor-reset')
  const sel = getSelection()
  if (!root || !sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  const node = topNode(range.startContainer, root)
  if (!node || (!range.collapsed && topNode(range.endContainer, root) !== node)) return
  root.querySelectorAll('.vditor-ir__node--expand').forEach((el) => el.classList.remove('vditor-ir__node--expand'))
  node.classList.add('vditor-ir__node--expand')
  node.classList.remove('vditor-ir__node--hidden')
}
