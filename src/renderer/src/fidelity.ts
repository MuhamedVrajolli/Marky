// Keeps saved files as close to the original bytes as possible.
//
// Vditor's engine (Lute) re-serializes the *whole* document from the editor DOM, and that round
// trip is lossy: it drops two-space hard breaks, flattens indented code blocks, rewrites `***`
// as `---`, re-pads table delimiter rows, adds spaces after task markers, etc.
//
// Instead of writing Lute's output, we diff the editor's markdown before and after the user's
// edits (both in Lute's normalized form) and apply only that diff to the original file text.
// Untouched parts of the file stay byte-for-byte identical. If the result wouldn't render the
// same as what's in the editor, we fall back to Lute's output.
import DiffMatchPatch from 'diff-match-patch'
import type Vditor from 'vditor'

const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 2

interface LuteLike {
  Md2VditorIRDOM(md: string): string
  VditorIRDOM2Md(html: string): string
}

/** What the editor would produce for `md` (load it, then read it back). */
export function normalize(editor: Vditor, md: string): string | null {
  const lute = (editor as unknown as { vditor?: { lute?: LuteLike } }).vditor?.lute
  if (!lute) return null
  try {
    return lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(md))
  } catch {
    return null
  }
}

/** Ignore differences that Lute itself doesn't round-trip stably. */
function canonical(md: string): string {
  return md
    .replaceAll(String.fromCharCode(160), ' ') // non-breaking spaces
    .replace(/[ \t]+$/gm, '')
    .replace(/^(\s*(?:[-*+]|\d+[.)]) \[[ xX]\]) +/gm, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Line diff of `a` → `b` as a list of operations on whole lines. */
function diffLines(a: string[], b: string[]): Array<[op: number, count: number]> {
  // Encode each distinct line as one UTF-16 unit so dmp's char diff becomes a line diff.
  const codes = new Map<string, string>()
  const encode = (lines: string[]): string =>
    lines
      .map((line) => {
        let c = codes.get(line)
        if (c === undefined) {
          if (codes.size >= 0xd000) throw new Error('too many distinct lines')
          c = String.fromCharCode(codes.size + 1)
          codes.set(line, c)
        }
        return c
      })
      .join('')
  return dmp.diff_main(encode(a), encode(b), false).map(([op, text]) => [op, text.length])
}

/**
 * Index pairs of equal, non-blank lines in `a` and `b` (a longest-common-subsequence alignment).
 * Blank lines are ignored: they are too ambiguous to anchor anything.
 */
function matchLines(a: string[], b: string[]): Map<number, number> {
  const ai = a.flatMap((l, i) => (l.trim() ? [i] : []))
  const bi = b.flatMap((l, i) => (l.trim() ? [i] : []))
  const pairs = new Map<number, number>()
  let i = 0
  let j = 0
  for (const [op, n] of diffLines(
    ai.map((k) => a[k]),
    bi.map((k) => b[k])
  )) {
    if (op === DiffMatchPatch.DIFF_EQUAL) for (let k = 0; k < n; k++) pairs.set(ai[i++], bi[j++])
    else if (op === DiffMatchPatch.DIFF_DELETE) i += n
    else j += n
  }
  return pairs
}

interface Hunk {
  /** Lines [b0, b1) of base were replaced by lines [c0, c1) of current. */
  b0: number
  b1: number
  c0: number
  c1: number
}

function lineHunks(B: string[], C: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | null = null
  for (const [op, n] of diffLines(B, C)) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      if (open) hunks.push(open)
      open = null
      i += n
      j += n
      continue
    }
    open ??= { b0: i, b1: i, c0: j, c1: j }
    if (op === DiffMatchPatch.DIFF_DELETE) open.b1 = i += n
    else open.c1 = j += n
  }
  if (open) hunks.push(open)
  return hunks
}

/**
 * Character-level three-way merge of a small region: replays the edits `base → current` on
 * `original`, mapping each edit position through the base → original alignment.
 */
function mergeChars(original: string, base: string, current: string): string {
  const edits = dmp.diff_main(base, current)
  dmp.diff_cleanupSemantic(edits)
  const alignment = dmp.diff_main(base, original)
  const ops: Array<{ from: number; to: number; text: string }> = []
  let pos = 0
  for (const [op, text] of edits) {
    if (op === DiffMatchPatch.DIFF_EQUAL) pos += text.length
    else if (op === DiffMatchPatch.DIFF_DELETE) {
      ops.push({ from: pos, to: pos + text.length, text: '' })
      pos += text.length
    } else ops.push({ from: pos, to: pos, text })
  }
  let out = original
  for (const op of ops.reverse()) {
    const from = dmp.diff_xIndex(alignment, op.from)
    const to = Math.max(from, dmp.diff_xIndex(alignment, op.to))
    out = out.slice(0, from) + op.text + out.slice(to)
  }
  return out
}

/** Offset of the start of each line, plus one entry past the end. */
function lineStarts(lines: string[]): number[] {
  const starts = [0]
  for (const l of lines) starts.push(starts[starts.length - 1] + l.length + 1)
  return starts
}

/**
 * Applies the user's edits (base → current) to the original text.
 *
 * Each edit hunk is widened until it is bracketed by (non-blank) lines that exist unchanged in
 * the original, which pins down exactly which region of the original it belongs to. The edits are
 * then replayed character by character on that region of the original. Everything outside edited
 * regions is copied from the original untouched.
 */
export function transplant(original: string, base: string, current: string): string {
  const O = original.split('\n')
  const B = base.split('\n')
  const C = current.split('\n')
  const bo = matchLines(B, O)

  // Group hunks into regions anchored on both sides by base lines that exist in the original.
  interface Region {
    e0: number
    e1: number
    offBefore: number
    offAfter: number
  }
  const regions: Region[] = []
  let offset = 0 // current index − base index, outside hunks
  for (const h of lineHunks(B, C)) {
    let e0 = h.b0
    let e1 = h.b1
    while (e0 > 0 && !bo.has(e0 - 1)) e0--
    while (e1 < B.length && !bo.has(e1)) e1++
    const offBefore = offset
    offset += h.c1 - h.c0 - (h.b1 - h.b0)
    const prev = regions.at(-1)
    if (prev && e0 <= prev.e1) {
      prev.e1 = Math.max(prev.e1, e1)
      prev.offAfter = offset
    } else {
      regions.push({ e0, e1, offBefore, offAfter: offset })
    }
  }

  const sO = lineStarts(O)
  const sB = lineStarts(B)
  const sC = lineStarts(C)
  // Character range covering lines [l0, l1) (the last line of a text has no trailing newline).
  const span = (starts: number[], text: string, l0: number, l1: number): [number, number] => [
    Math.min(starts[l0], text.length),
    Math.min(starts[l1], text.length)
  ]

  let out = ''
  let oPos = 0
  for (const r of regions) {
    const o0 = r.e0 > 0 ? bo.get(r.e0 - 1)! + 1 : 0
    const o1 = r.e1 < B.length ? bo.get(r.e1)! : O.length
    const [oa, oz] = span(sO, original, o0, o1)
    const [ba, bz] = span(sB, base, r.e0, r.e1)
    const [ca, cz] = span(sC, current, r.e0 + r.offBefore, r.e1 + r.offAfter)
    out += original.slice(oPos, oa)
    out += mergeChars(original.slice(oa, oz), base.slice(ba, bz), current.slice(ca, cz))
    oPos = oz
  }
  return out + original.slice(oPos)
}

/**
 * Applies the edit `base → current` to `original`.
 * Returns null when that can't be done safely; the caller then saves `current` as-is.
 */
export function mergeEdits(editor: Vditor, original: string, base: string, current: string): string | null {
  if (current === base) return original
  if (original === base) return current
  try {
    const merged = transplant(original, base, current)
    // Safety net: the merged file must render exactly like what the user sees in the editor.
    const check = normalize(editor, merged)
    return check !== null && canonical(check) === canonical(current) ? merged : null
  } catch (err) {
    console.warn('[fidelity] merge failed', err)
    return null
  }
}
