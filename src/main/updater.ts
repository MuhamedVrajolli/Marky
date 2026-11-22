// Automatic updates from the GitHub releases that CI publishes (.github/workflows/ci.yml).
//
// Checks shortly after startup and every few hours, downloads new versions in the background
// and installs them when Marky is closed, so the next start runs the new version. There is
// nothing to click. If something fails (offline, GitHub unreachable), Marky stays on its current
// version and tries again later; details go to %APPDATA%\Marky\logs\updater.log.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FIRST_CHECK_DELAY = 10_000
const CHECK_INTERVAL = 4 * 60 * 60 * 1000
const MAX_LOG_SIZE = 512 * 1024

function logger(): (level: string) => (message?: unknown) => void {
  const dir = app.getPath('logs')
  const file = join(dir, 'updater.log')
  return (level) => (message) => {
    try {
      mkdirSync(dir, { recursive: true })
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_SIZE) writeFileSync(file, '')
      appendFileSync(file, `${new Date().toISOString()} ${level} ${String(message)}\n`)
    } catch {
      /* logging must never break the app */
    }
  }
}

export function startAutoUpdates(): void {
  // Running from source (npm run dev, tests): there is nothing to update.
  if (!app.isPackaged) return

  const log = logger()
  autoUpdater.logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => {
      /* already logged; try again at the next interval */
    })
  }
  setTimeout(check, FIRST_CHECK_DELAY)
  setInterval(check, CHECK_INTERVAL)
}
