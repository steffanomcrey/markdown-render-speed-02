// Driver for the markdown-render-speed-02 harness.
// Reads /input/cases.json (or $MAKEFUN_INPUT_DIR/cases.json) and writes
// /output/html.json (or $MAKEFUN_OUTPUT_DIR/html.json): one rendered HTML
// string per case, in input order, byte-identical to marked 18.1.3 output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => parse(typeof c === 'string' ? c : c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
