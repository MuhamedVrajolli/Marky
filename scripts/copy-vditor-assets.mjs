// Copies Vditor's runtime assets (Lute, i18n, icons, themes, highlight.js, KaTeX, Mermaid, ...)
// into the renderer's public folder so the editor works fully offline.
// Vditor loads them from `${cdn}/dist/...`; the renderer sets `cdn: './vditor'`.
// Runs before `dev` and `build`; skips the copy when the assets are already up to date.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = join(root, 'node_modules', 'vditor', 'package.json')
const src = join(root, 'node_modules', 'vditor', 'dist')
const destRoot = join(root, 'src', 'renderer', 'public', 'vditor')
const dest = join(destRoot, 'dist')
const stamp = join(destRoot, '.version')

if (!existsSync(src)) {
  console.warn('[copy-vditor-assets] vditor is not installed yet, skipping')
  process.exit(0)
}

const version = JSON.parse(readFileSync(pkg, 'utf8')).version
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version && existsSync(dest)) process.exit(0)

rmSync(destRoot, { recursive: true, force: true })
// The TypeScript sources and typings are not needed at runtime.
cpSync(src, dest, {
  recursive: true,
  filter: (p) => !/[\\/]dist[\\/](ts|types)([\\/]|$)/.test(p) && !p.endsWith('.d.ts')
})
writeFileSync(stamp, version)
console.log(`[copy-vditor-assets] copied vditor ${version} assets -> src/renderer/public/vditor`)
