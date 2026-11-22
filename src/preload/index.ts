import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { MarkApi, MenuAction, OpenedFile } from '../shared/types'

const api: MarkApi = {
  getStartup: () => ipcRenderer.invoke('app:startup'),
  openDialog: () => ipcRenderer.invoke('files:openDialog'),
  openDropped: (files) =>
    ipcRenderer.invoke(
      'files:openDropped',
      Array.from(files)
        .map((f) => webUtils.getPathForFile(f))
        .filter(Boolean)
    ),
  openLinked: (fromFile, href) => ipcRenderer.invoke('files:openLinked', fromFile, href),
  readFile: (path) => ipcRenderer.invoke('files:read', path),
  save: (req) => ipcRenderer.invoke('files:save', req),
  saveAs: (req) => ipcRenderer.invoke('files:saveAs', req),
  stat: (paths) => ipcRenderer.invoke('files:stat', paths),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  saveSession: (session) => ipcRenderer.send('session:save', session),
  writeBackup: (id, backup) => ipcRenderer.invoke('backup:write', id, backup),
  deleteBackup: (id) => ipcRenderer.invoke('backup:delete', id),
  closeConfirmed: () => ipcRenderer.send('window:closeConfirmed'),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  showLinkMenu: (link, hasSelection) => ipcRenderer.send('menu:link', link, hasSelection),
  zoom: (direction) => webFrame.setZoomLevel(direction === 0 ? 0 : webFrame.getZoomLevel() + direction * 0.5),
  onMenu: (cb) => {
    ipcRenderer.on('menu', (_e, action: MenuAction) => cb(action))
  },
  onOpenLink: (cb) => {
    ipcRenderer.on('link:open', (_e, href: string) => cb(href))
  },
  onOpenFiles: (cb) => {
    ipcRenderer.on('files:open', (_e, files: OpenedFile[]) => cb(files))
  },
  onThemeChange: (cb) => {
    ipcRenderer.on('theme:changed', (_e, dark: boolean) => cb(dark))
  },
  onRequestClose: (cb) => {
    ipcRenderer.on('window:requestClose', () => {
      ipcRenderer.send('window:closeAck')
      cb()
    })
  }
}

contextBridge.exposeInMainWorld('mark', api)
