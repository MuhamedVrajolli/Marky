// Images written as HTML <img> tags.
//
// Vditor's instant-rendering mode keeps inline HTML as hidden source text and never draws it, so
// an <img> tag on its own line or inside a paragraph showed nothing. Such tags are common in
// READMEs, and Typora saves resized images that way (<img src="a.png" style="zoom:50%;" />).
// Markdown images and HTML blocks such as <p><img></p> are drawn by Vditor itself.
//
// The preview goes in a shadow root on Vditor's html-inline node. Vditor turns the editor back
// into markdown, and takes its undo snapshots, from innerHTML, which leaves shadow roots out, so
// the preview can never end up in the file or in the undo history.

/** mdfile:// URL that serves the local file at `path` (see the protocol handler in the main process). */
export function localFileUrl(path: string): string {
  return `mdfile://local/${path.split(/[\\/]/).map(encodeURIComponent).join('/')}`
}

/** URL prefix that serves files next to `filePath` through the mdfile:// protocol. */
export function fileBaseUrl(filePath: string | null): string {
  if (!filePath) return ''
  return `${localFileUrl(filePath.replace(/[\\/][^\\/]*$/, ''))}/`
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Turns an image `src` as written in a document into a URL the editor can load: web and data
 * URLs as they are, local files (relative to the document, absolute, or file:///) through
 * mdfile://. Returns null for anything else.
 */
export function imageUrl(src: string, filePath: string | null): string | null {
  src = src.trim()
  if (/^(https?:|data:image\/)/i.test(src)) return src
  // C:\dir\a.png, C:/dir/a.png, file:///C:/dir/a.png
  const absolute = /^(?:file:\/\/\/)?([a-z]:[\\/].*)$/i.exec(src)
  if (absolute) return localFileUrl(safeDecode(absolute[1]))
  // Other schemes and network paths aren't shown; relative paths need the document's folder.
  if (!src || !filePath || /^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(src)) return null
  try {
    return new URL(src.replace(/\\/g, '/'), fileBaseUrl(filePath)).href
  } catch {
    return null
  }
}

/** Builds the preview for an inline-HTML snippet, or null if it isn't an <img> tag. */
function previewFor(html: string, filePath: string | null): HTMLImageElement | null {
  if (!/^\s*<img[\s/>]/i.test(html)) return null
  // DOMParser documents are inert: nothing in them loads or runs.
  const tag = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild
  if (tag?.tagName !== 'IMG') return null
  const src = imageUrl(tag.getAttribute('src') ?? '', filePath)
  if (!src) return null
  // A fresh element with only the attributes that matter for display.
  const img = document.createElement('img')
  img.src = src
  for (const name of ['alt', 'title', 'width', 'height']) {
    const value = tag.getAttribute(name)
    if (value !== null) img.setAttribute(name, value)
  }
  const style = (tag as HTMLElement).style
  for (const prop of ['zoom', 'width', 'height', 'max-width', 'max-height']) {
    const value = style.getPropertyValue(prop)
    if (value) img.style.setProperty(prop, value)
  }
  return img
}

const PREVIEW_CSS = 'img { max-width: 100%; }'

/** Keeps a preview next to every inline-HTML <img> tag in the editor inside `container`. */
export function attachHtmlImages(container: HTMLElement, filePath: string | null): void {
  // The tag each node's preview was built from.
  const shown = new WeakMap<Element, string>()

  const update = (): void => {
    for (const node of container.querySelectorAll<HTMLElement>('.vditor-ir span[data-type="html-inline"]')) {
      const html = node.querySelector(':scope > code')?.textContent ?? ''
      if (shown.get(node) === html) continue
      shown.set(node, html)
      const img = previewFor(html, filePath)
      if (!img && !node.shadowRoot) continue
      // Clicking the image puts the caret in its tag, which reveals the source (as clicking a
      // markdown image does). Vditor's own click handler runs next and expands the node.
      img?.addEventListener('click', () => {
        const code = node.querySelector(':scope > code')
        if (!code) return
        const range = document.createRange()
        range.selectNodeContents(code)
        range.collapse(false)
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(range)
      })
      const root = node.shadowRoot ?? node.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = PREVIEW_CSS
      // The <slot> shows the node's own content: the tag's source, while the caret is in it.
      root.replaceChildren(style, document.createElement('slot'), ...(img ? [img] : []))
    }
  }

  // Vditor re-renders a block on every edit, replacing its nodes.
  new MutationObserver(update).observe(container, { childList: true, subtree: true, characterData: true })
}
