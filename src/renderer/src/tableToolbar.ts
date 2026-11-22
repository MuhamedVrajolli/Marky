// A small toolbar that floats above a table while the caret is inside it:
// insert/delete/move rows and columns, column alignment, delete table.
//
// Insert/delete use Vditor's own table commands (triggered through their keyboard shortcuts, so the
// tooltips show real shortcuts). Moving, aligning and deleting the table are done here on the
// editor DOM; afterwards the change is recorded in Vditor's undo history and reported as an edit.
import type Vditor from 'vditor'
import { recordUndoStep } from './undo'

interface Shortcut {
  key: string
  code: string
  shift?: boolean
}

interface Context {
  cell: HTMLTableCellElement
  row: HTMLTableRowElement
  table: HTMLTableElement
  col: number
}

interface Button {
  title: string
  icon: string
  rotate?: number
  enabled?(c: Context): boolean
  run(c: Context): void
}

const icon = (id: string, rotate = 0): string =>
  `<svg${rotate ? ` style="transform: rotate(${rotate}deg)"` : ''}><use xlink:href="#vditor-icon-${id}"></use></svg>`

function currentCell(container: HTMLElement): Context | null {
  const node = getSelection()?.anchorNode
  const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) : null
  const cell = el?.closest<HTMLTableCellElement>('.vditor-ir td, .vditor-ir th')
  if (!cell || !container.contains(cell)) return null
  const row = cell.parentElement as HTMLTableRowElement
  const table = cell.closest('table') as HTMLTableElement
  return { cell, row, table, col: cell.cellIndex }
}

export function attachTableToolbar(
  container: HTMLElement,
  getEditor: () => Vditor | undefined,
  onChange: () => void
): void {
  const bar = document.createElement('div')
  bar.className = 'table-toolbar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Table')
  container.append(bar)

  /** Fire one of Vditor's table shortcuts at the caret. */
  const shortcut = (c: Context, s: Shortcut): void => {
    c.cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: s.key, code: s.code, ctrlKey: true, shiftKey: !!s.shift, bubbles: true, cancelable: true })
    )
  }

  /** After editing the table DOM ourselves: record an undo step and report the edit. */
  const changed = (): void => {
    recordUndoStep(getEditor())
    onChange()
  }

  const moveColumn = (c: Context, step: -1 | 1): void => {
    const to = c.col + step
    for (const row of Array.from(c.table.rows)) {
      const a = row.cells[c.col]
      const b = row.cells[to]
      if (!a || !b) continue
      if (step < 0) row.insertBefore(a, b)
      else row.insertBefore(b, a)
    }
    changed()
  }

  const moveRow = (c: Context, step: -1 | 1): void => {
    const other = (step < 0 ? c.row.previousElementSibling : c.row.nextElementSibling) as HTMLElement | null
    if (!other) return
    c.row.parentElement!.insertBefore(step < 0 ? c.row : other, step < 0 ? other : c.row)
    changed()
  }

  const align = (c: Context, value: 'left' | 'center' | 'right'): void => {
    for (const row of Array.from(c.table.rows)) row.cells[c.col]?.setAttribute('align', value)
    changed()
  }

  const deleteTable = (c: Context): void => {
    const next = c.table.nextElementSibling ?? c.table.previousElementSibling
    c.table.remove()
    if (next) {
      const range = document.createRange()
      range.selectNodeContents(next)
      range.collapse(true)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(range)
    }
    changed()
  }

  const inBody = (c: Context): boolean => c.cell.tagName === 'TD'
  const buttons: Array<Button | 'sep'> = [
    { title: 'Insert row above (Ctrl+Shift+F)', icon: icon('insert-rowb'), run: (c) => shortcut(c, { key: 'F', code: 'KeyF', shift: true }) },
    { title: 'Insert row below (Ctrl+=)', icon: icon('insert-row'), run: (c) => shortcut(c, { key: '=', code: 'Equal' }) },
    { title: 'Delete row (Ctrl+-)', icon: icon('delete-row'), enabled: inBody, run: (c) => shortcut(c, { key: '-', code: 'Minus' }) },
    { title: 'Move row up', icon: icon('up'), enabled: (c) => inBody(c) && !!c.row.previousElementSibling, run: (c) => moveRow(c, -1) },
    { title: 'Move row down', icon: icon('down'), enabled: (c) => inBody(c) && !!c.row.nextElementSibling, run: (c) => moveRow(c, 1) },
    'sep',
    { title: 'Insert column left (Ctrl+Shift+G)', icon: icon('insert-columnb'), run: (c) => shortcut(c, { key: 'G', code: 'KeyG', shift: true }) },
    { title: 'Insert column right (Ctrl+Shift+=)', icon: icon('insert-column'), run: (c) => shortcut(c, { key: '+', code: 'Equal', shift: true }) },
    {
      title: 'Delete column (Ctrl+Shift+-)',
      icon: icon('delete-column'),
      enabled: (c) => c.row.cells.length > 1,
      run: (c) => shortcut(c, { key: '_', code: 'Minus', shift: true })
    },
    { title: 'Move column left', icon: icon('up', -90), enabled: (c) => c.col > 0, run: (c) => moveColumn(c, -1) },
    { title: 'Move column right', icon: icon('up', 90), enabled: (c) => c.col < c.row.cells.length - 1, run: (c) => moveColumn(c, 1) },
    'sep',
    { title: 'Align column left', icon: icon('align-left'), run: (c) => align(c, 'left') },
    { title: 'Align column center', icon: icon('align-center'), run: (c) => align(c, 'center') },
    { title: 'Align column right', icon: icon('align-right'), run: (c) => align(c, 'right') },
    'sep',
    { title: 'Delete table', icon: icon('trashcan'), run: deleteTable }
  ]

  const elements: Array<[HTMLButtonElement, Button]> = []
  for (const b of buttons) {
    if (b === 'sep') {
      bar.append(Object.assign(document.createElement('span'), { className: 'sep' }))
      continue
    }
    const el = document.createElement('button')
    el.type = 'button'
    el.title = b.title
    el.setAttribute('aria-label', b.title)
    el.tabIndex = -1
    el.innerHTML = b.icon
    // Keep the caret in the table: don't let the click move focus or the selection.
    el.addEventListener('mousedown', (e) => e.preventDefault())
    el.addEventListener('click', () => {
      const c = currentCell(container)
      if (!c || (b.enabled && !b.enabled(c))) return
      b.run(c)
      requestAnimationFrame(update)
    })
    bar.append(el)
    elements.push([el, b])
  }

  function update(): void {
    if (!container.isConnected) {
      // The editor was closed or re-created (e.g. source mode): stop listening.
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('resize', update)
      return
    }
    const c = currentCell(container)
    // The table with the toolbar gets extra space above it so the toolbar covers nothing.
    for (const t of Array.from(container.querySelectorAll('table.has-table-toolbar'))) {
      if (t !== c?.table) t.classList.remove('has-table-toolbar')
    }
    if (!c || !c.table.isConnected) {
      bar.classList.remove('visible')
      return
    }
    c.table.classList.add('has-table-toolbar')
    for (const [el, b] of elements) el.disabled = !!b.enabled && !b.enabled(c)
    bar.classList.add('visible')
    const host = container.getBoundingClientRect()
    const table = c.table.getBoundingClientRect()
    const above = table.top - host.top - bar.offsetHeight - 6
    bar.style.top = `${above >= 0 ? above : table.bottom - host.top + 6}px`
    bar.style.left = `${Math.max(0, table.left - host.left)}px`
  }

  document.addEventListener('selectionchange', update)
  container.addEventListener('input', () => requestAnimationFrame(update))
  window.addEventListener('resize', update)
}
