# Mark

A small, Typora-style markdown editor for Windows. Markdown renders as you type, and the syntax
of the block under the cursor is revealed (`**`, `#`, `[]()`) so you can edit it. Tabs, open, save
and a few settings. Nothing else.

Built with [Electron](https://www.electronjs.org/) and [Vditor](https://github.com/Vanessa219/vditor)
(its "instant rendering" mode). Everything runs offline.

## Install

```sh
npm install
npm run dist:win
```

Run `dist/Mark-Setup-<version>.exe`. The installer isn't code-signed, so Windows SmartScreen will
warn the first time ("More info" → "Run anyway").

To open `.md` files with Mark by double-clicking: right-click a `.md` file → **Open with** →
**Choose another app** → **Mark** → **Always**. Opening a file while Mark is running adds a tab to
the existing window.

## Shortcuts

| Action | Keys |
| --- | --- |
| New / Open / Save / Save As | `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Close tab | `Ctrl+W` (or middle-click the tab) |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` (also `Ctrl+PgDn` / `Ctrl+PgUp`) |
| Toggle source mode (raw markdown) | `Ctrl+/` |
| Settings | `Ctrl+,` |
| Open a link | `Ctrl+click` (links to other `.md` files open in a new tab) |
| Zoom in / out / reset | `Ctrl+Shift+=` / `Ctrl+Shift+-` / `Ctrl+Shift+0` |
| Bold, italic, strike, link, inline code | `Ctrl+B`, `Ctrl+I`, `Ctrl+D`, `Ctrl+K`, `Ctrl+G` |
| Heading level / bigger / smaller | `Ctrl+Alt+1…6`, `Ctrl+=`, `Ctrl+-` |
| List, task list, quote, code block, table | `Ctrl+L`, `Ctrl+J`, `Ctrl+;`, `Ctrl+U`, `Ctrl+M` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z` |

Markdown typed directly (`## `, `- `, `> `, ` ``` `, `**bold**`, …) is converted as you type.

## Settings

Theme (follow Windows / light / dark), text column width (side margins) or full width, font,
font size, line height, code font, auto-save, spell check, and reopening last session's files.

Settings and the session live in `%APPDATA%\Mark\settings.json` and `session.json`.

## How saving works

Vditor rebuilds the whole markdown from the editor every time, and that round trip isn't exact: it
drops two-space line breaks, flattens indented code blocks, rewrites `***` as `---`, and so on.
Saving that output would quietly reformat (and sometimes change) your files.

Mark saves differently ([`fidelity.ts`](src/renderer/src/fidelity.ts)). It takes your edits as a diff
of the editor's content and applies only that diff to the original file text. Parts of the file you
didn't touch stay byte-for-byte identical, and line endings (CRLF/LF) and a UTF-8 BOM are kept.
Before writing, Mark checks that the merged file renders exactly like what's on screen. If it
doesn't, Mark saves the editor's own output instead. Opening a file and pressing `Ctrl+S` without
changes writes nothing.

Source mode (`Ctrl+/`) shows the actual file text.

## Development

```sh
npm install
npm run dev        # run with hot reload
npm run typecheck
npm run build      # build into out/
npm run dist:win   # build + Windows installer into dist/
```

Set `MARK_USER_DATA=<folder>` to run with a separate settings/session folder, alongside an
installed copy.

Layout:

- `src/main/`: app lifecycle, window, menu, file dialogs and I/O, settings/session storage
- `src/preload/`: the small `window.mark` API exposed to the page
- `src/renderer/`: tabs, editor (Vditor), settings dialog, styles
- `src/shared/types.ts`: types and settings defaults shared by both sides

Vditor is pinned to an exact version on purpose. Mark relies on some of its internals (its markdown
engine, icon loading, code-block copy button), so check those after upgrading.

## Known limitations

- Editing a paragraph that references a footnote can move the footnote's definition to the end
  of the file. Vditor does this, and the file still renders the same.
- If an edit can't be mapped cleanly onto the original text, the edited region (or, rarely, the
  whole file) is saved in Vditor's own formatting.
- No find/replace, outline, file tree, image pasting or export (yet).
- Uses Electron's default icon.
