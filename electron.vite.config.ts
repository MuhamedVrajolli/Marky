import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * index.html's Content-Security-Policy lets the page connect to ws: and http://localhost for the
 * dev server's hot reload. The built app doesn't need that, so it's removed from the build.
 */
function productionCsp(): Plugin {
  const devOnly = " ws: http://localhost:*"
  return {
    name: 'marky-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      if (!html.includes(`connect-src 'self'${devOnly};`)) {
        throw new Error('productionCsp: connect-src in index.html changed; update electron.vite.config.ts')
      }
      return html.replace(devOnly, '')
    }
  }
}

// Default layout: src/main/index.ts, src/preload/index.ts, src/renderer/index.html.
export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [productionCsp()] }
})
