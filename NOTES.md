# NOTES — markdown-render-speed-02

## Local validation (2026-11-16, Node v24.22.1)

Kit practice set: 720 cases (680 CommonMark 0.31.2 + GFM 0.29 spec
examples, 40 generated README documents of 20k-100k characters).

- `node diff.mjs 0` (repo `parse.js` vs
  `kit/.../practice/reference/expected.json`): **720/720 pass, 0 fail**.
- All 680 spec examples pass; all 40 README documents pass.
- Speed on the same 720-case set, same machine, fresh processes
  (`scratch/speed.mjs`):
  - baseline marked 18.1.3 (`kit/.../baselines/parse.js`): 937-1236 ms.
  - this `parse.js`: 884-947 ms first run, 649-725 ms warmed;
    `diff.mjs` wall 892-935 ms.
  - So the entry is roughly 1.06x to 1.34x faster than marked cold,
    and more once warmed. The kit RULES.txt quotes marked at about
    7 s wall / 4 s CPU per 720-case set in the grading sandbox
    (Node 22, 1 CPU); the local ratio is the number that matters,
    and it favours this entry.

## How the renderer works

Single-pass block parser plus a flat inline tokenizer. Emphasis is
resolved opener-driven, mirroring marked's `emStrong`/`del`
accounting: a forward scan from each opener, opener-only runs adding
to the closers needed, closer-only runs subtracting, both-flanking
runs skipped by the rule of three (with the `o` flag: an opener
preceded by the same delimiter char aborts on a both-flanking run)
and otherwise subtracting, a `*` inside a `__...__` pair (and `_`
inside `**...**`) skipped by marked's RDelim skip-alternative, and
an opener that finds no closer giving up one delimiter char as
literal text and retrying the shortened run (so `**foo*` renders
`*<em>foo</em>`). Leftover opener/closer delimiters stay inside the
wrap as its first/last children. Link labels hide their delimiters
from the emphasis scan exactly where marked's mask does (failed
`[...](...)` constructs, Ot code spans), and autolink backpedal,
fenced-code indent, blockquote laziness, HTML-block trailing
newlines and bare-email trailing underscores all follow marked's
own rules.

## Entry

- Competition `markdown-render-speed-02`, account @kiyelsauter.
- `parse.js` is 1359 lines, 59,741 bytes; `main.ts` is 15 lines.
  Repo total about 65 KB, under the 1 MiB cap.
- No entry fee. Prizes $250 total (1st $50, 2nd $35, 3rd $25,
  4th-10th $10, 11th-20th $7).
- Deadline 2026-11-16T20:30:00Z (17 Nov 03:30 WIB).

## Final validation, finish session (2026-11-16 12:13 WIB)

- `node diff.mjs 0` re-run in the finish session against the submitted
  `repo/parse.js`: **720/720 pass, 0 fail, 1023 ms wall (1.421 ms/case)**.
  No parser change was needed; the code submitted is the validated code.
