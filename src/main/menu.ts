// Native application menu.
//
// App shortcuts (Ctrl+N/O/S/W, Ctrl+Tab, Ctrl+/, ...) are handled by the renderer in a
// capture-phase keydown listener so they win over Vditor's own key handling. The menu only
// *displays* those accelerators (registerAccelerator: false) and sends the same action on click.
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuAction } from '../shared/types'

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const send = (action: MenuAction) => () => getWindow()?.webContents.send('menu', action)
  const item = (label: string, action: MenuAction, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: send(action)
  })

  const zoom = (dir: 1 | -1 | 0) => () => {
    const wc = getWindow()?.webContents
    if (!wc) return
    wc.setZoomLevel(dir === 0 ? 0 : wc.getZoomLevel() + dir * 0.5)
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        item('New', 'new', 'CmdOrCtrl+N'),
        item('Open…', 'open', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        { type: 'separator' },
        item('Settings…', 'settings', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { label: 'Exit', accelerator: 'Alt+F4', registerAccelerator: false, click: () => getWindow()?.close() ?? app.quit() }
      ]
    },
    {
      label: '&Edit',
      // Undo/redo are intentionally absent: Vditor keeps its own undo stack (Ctrl+Z / Ctrl+Y).
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
    },
    {
      label: '&View',
      submenu: [
        item('Toggle Source Mode', 'toggleSource', 'CmdOrCtrl+/'),
        { type: 'separator' },
        item('Next Tab', 'nextTab', 'Ctrl+Tab'),
        item('Previous Tab', 'prevTab', 'Ctrl+Shift+Tab'),
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Shift+=', registerAccelerator: false, click: zoom(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+Shift+-', registerAccelerator: false, click: zoom(-1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+Shift+0', registerAccelerator: false, click: zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: 'F11' },
        { role: 'toggleDevTools', accelerator: 'F12' }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
