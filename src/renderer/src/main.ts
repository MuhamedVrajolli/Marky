import './styles.css'
import type { MenuAction } from '../../shared/types'
import { redo } from './editor'
import { applySettingsToDom, SettingsDialog } from './settings'
import { TabManager } from './tabs'

const mark = window.mark
const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|mkdn|mdx|txt)$/i

async function boot(): Promise<void> {
  const startup = await mark.getStartup()
  applySettingsToDom(startup.settings)

  // The main process resolves the Theme setting (system/light/dark) and tells us when it changes.
  const applyTheme = (dark: boolean): void => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }
  applyTheme(startup.dark)

  const tabs = new TabManager(
    document.getElementById('tabs')!,
    document.getElementById('editors')!,
    startup.settings,
    startup.dark
  )
  mark.onThemeChange((dark) => {
    applyTheme(dark)
    tabs.setDark(dark)
  })

  if (startup.files.length) tabs.openFiles(startup.files, startup.active)
  else tabs.newTab()

  const settingsDialog = new SettingsDialog(startup.settings, (s) => {
    applySettingsToDom(s)
    tabs.applySettings(s)
  })

  const run = async (action: MenuAction): Promise<void> => {
    switch (action) {
      case 'new':
        return tabs.newTab()
      case 'open':
        return tabs.openFiles(await mark.openDialog())
      case 'save':
        await tabs.save()
        return
      case 'saveAs':
        await tabs.saveAs()
        return
      case 'closeTab':
        await tabs.close()
        return
      case 'settings':
        return settingsDialog.open()
      case 'toggleSource':
        return tabs.toggleSourceMode()
      case 'nextTab':
        return tabs.cycle(1)
      case 'prevTab':
        return tabs.cycle(-1)
    }
  }

  document.getElementById('new-tab')!.addEventListener('click', () => tabs.newTab())
  mark.onMenu((action) => void run(action))
  mark.onOpenFiles((files) => tabs.openFiles(files))
  mark.onRequestClose(async () => {
    if (await tabs.confirmCloseAll()) {
      tabs.saveSessionNow()
      mark.closeConfirmed()
    }
  })

  // App shortcuts are handled here, in the capture phase, so they take priority over Vditor's
  // own key handling (e.g. Vditor treats Ctrl+Tab as Tab inside lists).
  window.addEventListener(
    'keydown',
    (e) => {
      // AltGr arrives as Ctrl+Alt on Windows. It types characters on many keyboard layouts
      // (e.g. @ { [ ), so keep Vditor from treating it as a shortcut like Ctrl+Alt+2 = heading.
      if (e.getModifierState('AltGraph')) {
        e.stopPropagation()
        return
      }
      // Vditor's hidden Ctrl+Alt+7/8/9 switch its internal edit mode behind the app's back.
      if (e.ctrlKey && e.altKey && /^Digit[789]$/.test(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return
      let action: MenuAction | null = null
      let handled = true
      switch (e.code) {
        case 'KeyN':
          action = 'new'
          break
        case 'KeyO':
          // Ctrl+Shift+O is Vditor's "indent".
          if (e.shiftKey) handled = false
          else action = 'open'
          break
        case 'KeyS':
          action = e.shiftKey ? 'saveAs' : 'save'
          break
        case 'KeyW':
        case 'F4':
          action = 'closeTab'
          break
        case 'Comma':
          action = 'settings'
          break
        case 'Slash':
          action = 'toggleSource'
          break
        case 'Tab':
          action = e.shiftKey ? 'prevTab' : 'nextTab'
          break
        case 'PageDown':
          action = 'nextTab'
          break
        case 'PageUp':
          action = 'prevTab'
          break
        case 'KeyZ':
          if (e.shiftKey) {
            const editor = tabs.currentEditor()
            if (editor) redo(editor)
          } else handled = false
          break
        case 'Equal':
        case 'NumpadAdd':
          if (e.shiftKey || e.code === 'NumpadAdd') mark.zoom(1)
          else handled = false
          break
        case 'Minus':
        case 'NumpadSubtract':
          if (e.shiftKey || e.code === 'NumpadSubtract') mark.zoom(-1)
          else handled = false
          break
        case 'Digit0':
        case 'Numpad0':
          if (e.shiftKey || e.code === 'Numpad0') mark.zoom(0)
          else handled = false
          break
        default:
          handled = false
      }
      if (!handled && !action) return
      e.preventDefault()
      e.stopPropagation()
      if (action) void run(action)
    },
    true
  )

  // Drag-and-drop markdown files onto the window to open them. Other drops (e.g. images)
  // are blocked so they don't navigate the window or trigger Vditor's uploader.
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  window.addEventListener(
    'dragover',
    (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    },
    true
  )
  window.addEventListener(
    'drop',
    (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => MARKDOWN_FILE.test(f.name))
      if (files.length) void mark.openDropped(files).then((opened) => tabs.openFiles(opened))
    },
    true
  )

  // Pick up edits made by other programs when coming back to the window.
  window.addEventListener('focus', () => void tabs.checkExternalChanges())
}

void boot()
