// Persists settings.json and session.json in the per-user app data folder.
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeSettings, type Settings, type TabsSession } from '../shared/types'

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
    mkdirSync(app.getPath('userData'), { recursive: true })
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

let session: Session | null = null

export function getSession(): Session {
  if (!session) {
    const raw = readJson('session.json') as Partial<Session> | undefined
    session = {
      files: Array.isArray(raw?.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [],
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
