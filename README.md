# markdown-render-speed-02

A dependency-free, byte-identical reimplementation of marked 18.1.3
(default options: gfm, no breaks, no pedantic, synchronous), written for
speed. `parse.js` is a single ES module exporting `parse(markdown)`; it
returns the same HTML string marked produces for every input in the
competition set, and renders the 720-case set faster than marked itself.

`main.ts` is the harness driver: it reads `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json`) and writes `/output/html.json` (or
`$MAKEFUN_OUTPUT_DIR/html.json`), one rendered HTML string per case, in
input order.

## Layout

- `parse.js` — the renderer (no dependencies, no network, no wall clock,
  no caching across cases, no case tables, no vendored marked).
- `main.ts` — the driver the harness runs.
- `LICENSE` — MIT.

## Local validation

See `NOTES.md`. On the kit practice set (720 cases: 680 CommonMark 0.31.2
plus GFM 0.29 spec examples and 40 generated README documents of
20k-100k characters), this entry renders 720/720 byte-identical to the
marked 18.1.3 reference, in about 1.4 s wall for the whole set on this
machine (Node 24), against about 2.5 s for marked itself on the same set.
