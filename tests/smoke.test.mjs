// Smoke tests: start the built app (out/) with Electron, open documents and check the things
// that would hurt most if a dependency update broke them. Run with `npm test` (builds first).
// CI runs them before merging dependency updates and before publishing a release.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { _electron } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const electronPath = createRequire(import.meta.url)('electron')
const TIMEOUT = 30_000

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'marky-test-'))
  copyFileSync(join(ROOT, 'build/icon.png'), join(dir, 'icon.png'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

/** Writes a document with CRLF line endings, as many Windows files have. */
function writeDoc(name, lines) {
  const path = join(dir, name)
  writeFileSync(path, lines.join('\r\n') + '\r\n')
  return path
}

async function launch(file) {
  const profile = mkdtempSync(join(dir, 'profile-'))
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ theme: 'light' }))
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [ROOT, file],
    cwd: ROOT,
    env: { ...process.env, MARKY_USER_DATA: profile, ELECTRON_RENDERER_URL: '' }
  })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('.vditor-ir .vditor-reset p', { timeout: TIMEOUT })
  return { app, win, errors }
}

test('renders images, HTML images and Mermaid diagrams', async () => {
  const file = writeDoc('render.md', [
    '# Render',
    '',
    '![logo](icon.png)',
    '',
    '<img src="icon.png" width="48" alt="html logo">',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Start] --> B[End]',
    '```'
  ])
  const { app, win, errors } = await launch(file)
  try {
    await win.waitForSelector('.vditor-ir__preview > .language-mermaid svg', { timeout: TIMEOUT, state: 'attached' })
    await win.waitForFunction(() => [...document.querySelectorAll('.vditor-ir img')].every((i) => i.complete), null, { timeout: TIMEOUT })
    const result = await win.evaluate(() => ({
      markdownImage: document.querySelector('.vditor-ir img[alt="logo"]')?.naturalWidth ?? 0,
      htmlImage: document.querySelector('.vditor-ir span[data-type="html-inline"]')?.shadowRoot?.querySelector('img')?.naturalWidth ?? 0,
      // Marky's light diagram theme (mermaid.ts), not Mermaid's stock one
      themedDiagram: document.querySelector('.vditor-ir__preview > .language-mermaid svg')?.innerHTML.includes('#eaf1ff') ?? false
    }))
    assert.ok(result.markdownImage > 0, 'markdown image loads')
    assert.ok(result.htmlImage > 0, 'HTML <img> tag loads')
    assert.ok(result.themedDiagram, 'diagram uses Marky colours')
    assert.deepEqual(errors, [])
  } finally {
    await app.close()
  }
})

test('saves only what changed', async () => {
  const lines = [
    '# Fidelity',
    '',
    'A line with a hard break  ',
    'and its continuation.',
    '',
    '    indented code block',
    '',
    '***',
    '',
    'Edit this paragraph.'
  ]
  const file = writeDoc('save.md', lines)
  const original = readFileSync(file, 'utf8')
  const { app, win, errors } = await launch(file)
  try {
    await win.keyboard.press('Control+s')
    await win.waitForTimeout(800)
    assert.equal(readFileSync(file, 'utf8'), original, 'saving without changes writes nothing different')

    const para = win.locator('.vditor-ir .vditor-reset > p', { hasText: 'Edit this paragraph.' })
    const box = await para.boundingBox()
    await win.mouse.click(box.x + 4, box.y + box.height / 2)
    await win.keyboard.press('End')
    await win.keyboard.type(' Edited.')
    await win.waitForTimeout(1000)
    await win.keyboard.press('Control+s')
    await win.waitForTimeout(1000)
    assert.equal(readFileSync(file, 'utf8'), original.replace('Edit this paragraph.', 'Edit this paragraph. Edited.'))
    assert.deepEqual(errors, [])
  } finally {
    await app.close()
  }
})

test('links: a click reveals the markdown, the context menu copies the address', async () => {
  const file = writeDoc('links.md', ['# Links', '', 'Go to [the site](https://example.com/page) now.'])
  const { app, win, errors } = await launch(file)
  try {
    // Capture context menus instead of showing them.
    await app.evaluate(({ Menu }) => {
      globalThis.menus = []
      Menu.buildFromTemplate = (template) => {
        globalThis.menus.push(template)
        return { popup() {} }
      }
    })
    const link = win.locator('.vditor-ir [data-type="a"]')
    const box = await link.boundingBox()
    await win.mouse.click(box.x + 6, box.y + box.height / 2)
    await win.waitForTimeout(300)
    assert.ok(await link.evaluate((el) => el.classList.contains('vditor-ir__node--expand')), 'click reveals the link markdown')

    await win.mouse.click(box.x + 6, box.y + box.height / 2, { button: 'right' })
    await win.waitForTimeout(300)
    const copied = await app.evaluate(async ({ clipboard }) => {
      const template = globalThis.menus.at(-1)
      template.find((item) => item.label === 'Copy Link').click()
      await new Promise((r) => setTimeout(r, 200))
      return clipboard.readText()
    })
    assert.equal(copied, 'https://example.com/page')
    assert.deepEqual(errors, [])
  } finally {
    await app.close()
  }
})
