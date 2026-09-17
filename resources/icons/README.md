# Application icons

`icon.ico` (Windows, multi-resolution: 16, 32, 48, 64, 128, 256) belongs here
and is referenced by `electron-builder.yml` and by the tray.

**No icon file is committed yet.** Rather than ship a placeholder that would
look like a finished asset, the code degrades: `src/main/tray.ts` draws a small
inline SVG charger glyph when no icon file is present, so the tray entry — and
therefore Quit — always works.

`npm run verify:package` fails if no icon is present in a packaged build, so a
release cannot go out without one.

Design reference: the brand tile in the UI handoff is a 26px rounded square in
`--bg-panel` with a charger glyph in `--accent` (`#5DBB97`) on `--bg-app`
(`#0D1412`).
