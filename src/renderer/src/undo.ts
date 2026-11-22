// Bookkeeping around Vditor's undo history (uses Vditor internals).
import type Vditor from 'vditor'

type UndoInternals = { addToUndoStack(v: unknown): void; undo(v: unknown): void; redo(v: unknown): void }
interface VditorInternals {
  undo?: UndoInternals
  ir?: { processTimeoutId?: number }
  sv?: { processTimeoutId?: number }
}
const internals = (editor: Vditor | undefined): VditorInternals | undefined =>
  (editor as unknown as { vditor?: VditorInternals } | undefined)?.vditor

/**
 * Editors with edits that Vditor hasn't recorded in its undo history yet. Vditor records a step
 * 0.8 s after you stop typing; undoStep records pending edits first so Ctrl+Z right after typing
 * works, but only when there are some (recording a mere caret move would make the next Ctrl+Z
 * just move the caret back).
 */
export const unrecordedEdits = new WeakSet<Vditor>()

/** Record the editor's current state as an undo step now (after editing its DOM directly). */
export function recordUndoStep(editor: Vditor | undefined): void {
  const inner = internals(editor)
  if (!inner?.undo) return
  // Vditor's own delayed recording (0.8 s after an edit) would otherwise add a second,
  // caret-only step, so the next Ctrl+Z would just move the cursor.
  clearTimeout(inner.ir?.processTimeoutId)
  clearTimeout(inner.sv?.processTimeoutId)
  inner.undo.addToUndoStack(inner)
  if (editor) unrecordedEdits.delete(editor)
}

export function undoStep(editor: Vditor, direction: 'undo' | 'redo'): void {
  const inner = internals(editor)
  if (!inner?.undo) return
  if (unrecordedEdits.has(editor)) inner.undo.addToUndoStack(inner)
  unrecordedEdits.delete(editor)
  inner.undo[direction](inner)
}
