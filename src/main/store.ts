// Persists settings.json, session.json and backups/ (unsaved changes) in the per-user app data folder.
import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettings, type SessionTab, type Settings, type TabBackup, type TabsSession } from '../shared/types'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface Session extends TabsSession {
  window?: WindowState
}

const filePath = (name: string): string => join(app.getPath('userData'), name)

function readJson(name: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath(name), 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(name: string, data: unknown): void {
  const target = filePath(name)
  const tmp = `${target}.tmp`
  try {
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch (err) {
    console.error(`[store] failed to write ${name}:`, err)
  }
}

let settings: Settings | null = null

export function getSettings(): Settings {
  settings ??= normalizeSettings(readJson('settings.json'))
  return settings
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = normalizeSettings({ ...getSettings(), ...patch })
  writeJson('settings.json', settings)
  return settings
}

// ------------------------------------------------------------------ session

export const isBackupId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id)

function toSessionTab(t: unknown): SessionTab | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Partial<SessionTab>
  if (o.path !== null && typeof o.path !== 'string') return null
  return {
    path: o.path,
    backupId: isBackupId(o.backupId) ? o.backupId : '',
    untitledIndex: typeof o.untitledIndex === 'number' ? o.untitledIndex : 0
  }
}

let session: Session | null = null

export function getSession(): Session {
  if (!session) {
    const raw = readJson('session.json') as (Partial<Session> & { files?: unknown }) | undefined
    let tabs: SessionTab[] = []
    if (Array.isArray(raw?.tabs)) {
      tabs = raw.tabs.map(toSessionTab).filter((t): t is SessionTab => t !== null)
    } else if (Array.isArray(raw?.files)) {
      // Session format of 0.3.0 and earlier: just a list of file paths.
      tabs = raw.files.filter((f): f is string => typeof f === 'string').map((path) => ({ path, backupId: '', untitledIndex: 0 }))
    }
    session = {
      tabs,
      active: typeof raw?.active === 'number' ? raw.active : 0,
      window: raw?.window && typeof raw.window.width === 'number' ? raw.window : undefined
    }
  }
  return session
}

export function updateSession(patch: Partial<Session>): void {
  session = { ...getSession(), ...patch }
  writeJson('session.json', session)
}

// ------------------------------------------------------------------ backups of unsaved changes

const backupFile = (id: string): string => join('backups', `${id}.json`)

export function readBackup(id: string): TabBackup | null {
  if (!isBackupId(id)) return null
  const raw = readJson(backupFile(id)) as Partial<TabBackup> | undefined
  if (!raw || typeof raw.content !== 'string') return null
  return {
    content: raw.content,
    eol: raw.eol === '\r\n' ? '\r\n' : '\n',
    bom: !!raw.bom,
    diskMtimeMs: typeof raw.diskMtimeMs === 'number' ? raw.diskMtimeMs : null
  }
}

export function writeBackup(id: string, backup: TabBackup): void {
  if (!isBackupId(id) || typeof backup?.content !== 'string') return
  writeJson(backupFile(id), {
    content: backup.content,
    eol: backup.eol === '\r\n' ? '\r\n' : '\n',
    bom: !!backup.bom,
    diskMtimeMs: typeof backup.diskMtimeMs === 'number' ? backup.diskMtimeMs : null
  })
}

export function deleteBackup(id: string): void {
  if (!isBackupId(id)) return
  rmSync(filePath(backupFile(id)), { force: true })
}

/** Remove backups that no tab refers to any more. */
export function pruneBackups(keep: Set<string>): void {
  let names: string[] = []
  try {
    names = readdirSync(filePath('backups'))
  } catch {
    return
  }
  for (const name of names) {
    const id = name.replace(/\.json(\.tmp)?$/, '')
    if (!keep.has(id)) rmSync(filePath(join('backups', name)), { force: true })
  }
}
