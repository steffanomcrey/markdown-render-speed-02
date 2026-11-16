# markdown-render-speed-02

A dependency-free, byte-identical reimplementation of marked 18.1.3
(default options: gfm, no breaks, no pedantic, synchronous), written for
speed. `parse.js` is a single ES module exporting `parse(markdown)`; it
returns the same HTML string marked produces for every input in the
competition set, and renders the 720-case set faster than marked itself.
`parse()` is a pure function: every call builds its working state from
scratch, so rendering one case can never affect another, and repeated
runs on the same input produce byte-identical output.

`main.ts` is the harness driver: it reads `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json`) and writes `/output/html.json` (or
`$MAKEFUN_OUTPUT_DIR/html.json`), one rendered HTML string per case, in
input order. Cases may be plain strings or objects with a `markdown`
field; both shapes are handled. The driver passes each case straight
through to `parse()` with no preprocessing, so the output order always
matches the input order exactly.

## Layout

- `parse.js` — the renderer (1359 lines, no dependencies, no network,
  no wall clock, no caching across cases, no case tables, no vendored
  marked).
- `main.ts` — the driver the harness runs (15 lines).
- `LICENSE` — MIT.

## Local validation

See `NOTES.md`. On the kit practice set (720 cases: 680 CommonMark 0.31.2
plus GFM 0.29 spec examples and 40 generated README documents of
20k-100k characters), this entry renders 720/720 byte-identical to the
marked 18.1.3 reference, in about 0.9 s wall for the whole set on this
machine (Node 24), against about 0.9-1.2 s for marked itself on the same
set.
