// Fast CommonMark 0.31.2 + GFM renderer, byte-exact with marked 18.1.3
// (default options: gfm on, breaks off, pedantic off, async off).
// Single-file, dependency-free ES module. Written from the CommonMark/GFM
// spec and measured against marked's own practice set; no marked code inside.
//
// Design: line-based block parser (paragraph state machine, recursive
// containers), then a two-phase inline parser (scan to nodes, delimiter-stack
// emphasis). Hot paths avoid regex: char-code dispatch, bulk text runs.

const SP = 32, TAB = 9, NL = 10, CR = 13, BANG = 33, QUOT = 34, HASH = 35;
const AMP = 38, APOS = 39, LPAREN = 40, RPAREN = 41, STAR = 42, PLUS = 43;
const COMMA = 44, MINUS = 45, DOT = 46, SLASH = 47, COLON = 58, SEMI = 59;
const LT = 60, EQ = 61, GT = 62, QMARK = 63, AT = 64, LBRK = 91, BSLASH = 92;
const RBRK = 93, CARET = 94, USCORE = 95, BTICK = 96, LBRACE = 123;
const PIPE = 124, RBRACE = 125, TILDE = 126;
// Document-level inLink state (marked's lexer.state.inLink, shared
// across blocks): an inline <a ...> tag sets it, a </a> tag clears it,
// and while set, bare URLs/emails are not autolinked anywhere in the
// document. Reset at the start of each parse().
let _docInLink = false;

// ---- character classification -------------------------------------------
// ASCII punctuation (for backslash escapes and emphasis flanking).
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isSpace(c) { return c === SP || c === TAB; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
// Unicode whitespace per CommonMark (space, tab, LF, VT, FF, CR + Unicode spaces).
function isWs(c) {
  if (c === SP || c === TAB || c === NL || c === 11 || c === 12 || c === CR) return true;
  if (c < 160) return false;
  return c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}
// Unicode punctuation (P or S general category) for emphasis flanking.
// Fast path for ASCII; non-ASCII falls back to a cached property regex.
const _punRe = /[\p{P}\p{S}]/u;
const _punCache = new Map();
function isPunctCp(cp) {
  if (cp < 128) return isAsciiPunct(cp);
  let v = _punCache.get(cp);
  if (v === undefined) { v = _punRe.test(String.fromCodePoint(cp)); _punCache.set(cp, v); }
  return v;
}
function isWsCp(cp) {
  if (cp < 128) return isWs(cp);
  return isWs(cp);
}

// ---- HTML escaping ------------------------------------------------------
// escape(s, encode): encode=true escapes & < > " ' ; encode=false escapes
// < > " ' and & only when it does not start a valid entity reference.
const _escRe = /[&<>"']/g;
const _escNoEncRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);)/g;
const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s, encode) {
  if (encode) {
    return s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0 ? s :
      s.replace(_escRe, (ch) => _escMap[ch]);
  }
  return s.replace(_escNoEncRe, (ch) => _escMap[ch]);
}

// Decode numeric character references in a string (named entities pass
// through untouched, exactly like marked). Invalid values become U+FFFD;
// code point 38 becomes &amp;.
const _numRefRe = /&(?:#(\d{1,7})|#[Xx]([A-Fa-f0-9]{1,6}));/g;
function decodeNumericRefs(s) {
  if (s.indexOf('&#') < 0) return s;
  return s.replace(_numRefRe, (m, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Unescape backslash escapes in a link label/destination/title fragment and
// decode numeric refs. `esc` maps a backslash-escaped punctuation char to
// the char itself; other backslashes survive.
function unescapeText(s) {
  if (s.indexOf('\\') < 0) return decodeNumericRefs(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === BSLASH && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1]; i++;
    } else {
      out += s[i];
    }
  }
  return decodeNumericRefs(out);
}

// Encode a link href the way marked does: encodeURI, then restore %25 to %
// (marked keeps literal percent signs unencoded in practice). Returns null
// when encodeURI throws (lone surrogates); the caller then renders the link
// text / image alt without a link, exactly like marked.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (_) { return null; }
}

// Normalize a link label exactly like marked's F(): trim, collapse all
// whitespace runs to one space, triple case-fold. Backslash escapes are
// NOT removed (both the definition label and the reference label keep
// them, so they still match).
function normalizeLabel(raw) {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Unescape backslash + Unicode punctuation/symbol (marked's anyPunctuation)
// in a link destination or title. Numeric references are NOT decoded here.
function unescapePunct(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === BSLASH && i + 1 < s.length) {
      const cp = s.codePointAt(i + 1);
      if (isPunctCp(cp)) { out += s[i + 1]; i++; if (cp > 0xFFFF) i++; continue; }
    }
    out += s[i];
  }
  return out;
}

// Column math for tabs (tab advances to the next multiple of 4).
// Returns [columns, byteIndex] after consuming leading spaces/tabs.
function leadCols(line) {
  let col = 0, i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === SP) { col++; i++; }
    else if (c === TAB) { col += 4 - (col & 3); i++; }
    else break;
  }
  return [col, i];
}
// Remove up to `n` leading columns from a line; a tab straddling the cut
// becomes spaces for the leftover columns.
function stripCols(line, n) {
  let col = 0, i = 0;
  const len = line.length;
  while (i < len && col < n) {
    const c = line.charCodeAt(i);
    if (c === SP) { col++; i++; }
    else if (c === TAB) {
      const next = col + 4 - (col & 3);
      if (next <= n) { col = next; i++; }
      else {
        // Tab straddles the cut: keep (next - n) spaces, drop the tab.
        return ' '.repeat(next - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}
// True if a line ends a GFM table body: empty or spaces-only, or an
// indented code line (4+ spaces, or 0-3 spaces + tab, followed by any
// char). A tab-only line (or space+tab) is not indented code, so it is
// a row of empty cells.
function isTableRowEnd(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP) i++;
  if (i === line.length) return true;
  if (i >= 4) return true;
  if (line.charCodeAt(i) === TAB) return i + 1 < line.length;
  return false;
}

// ---- inline parsing -----------------------------------------------------
// Node shapes:
//  text {s} · code {s} · br · html {s} · link {href,title,children}
//  img {src,title,alt} · em {children} · strong {children} · del {children}
//  delim {ch,n,canOpen,canClose} (resolved by processEmphasis)

// Scan a link label / link text starting at s[i] === '['.
// Returns the index just past the matching ']' or -1.
// Allows backslash escapes, nested balanced brackets, backtick code spans,
// and single newlines (but not a blank line).
function scanBracket(s, i, end) {
  let depth = 0;
  let j = i + 1;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === BSLASH) { j += 2; continue; }
    if (c === BTICK) {
      // A code span inside a label must match marked's label regex:
      // an opening run, content with no backtick at all, then a closing
      // run of any length. A run that cannot open such a span makes the
      // whole label unmatchable, so the link is not formed ([a ` b](u)
      // and [cache `` a ` b ``_ x](u) are literal text in marked).
      // The one exception is a run of 2+ backticks immediately before
      // ']' (the `` ``+(?=]) `` alternative).
      let n = 0, k = j;
      while (k < end && s.charCodeAt(k) === BTICK) { n++; k++; }
      if (n >= 2 && k < end && s.charCodeAt(k) === RBRK) { j = k; continue; }
      let m = k;
      let closed = false;
      while (m < end) {
        if (s.charCodeAt(m) === BTICK) {
          let q = m;
          while (q < end && s.charCodeAt(q) === BTICK) q++;
          closed = true; m = q; break;
        }
        m++;
      }
      if (!closed) return -1;
      j = m;
      continue;
    }
    if (c === LBRK) { depth++; j++; continue; }
    if (c === RBRK) {
      if (depth === 0) return j + 1;
      depth--; j++; continue;
    }
    if (c === LT) {
      // Skip an inline HTML tag so a ']' inside it (e.g. in a quoted
      // attribute value) does not close the label: [foo <bar
      // attr="](baz)"> is not a link, the tag runs to the '>'.
      const tag = parseInlineHtml(s, j, end);
      if (tag !== null) { j += tag.length; continue; }
    }
    if (c === NL) {
      // A blank line inside link text/label fails the link.
      let k = j + 1;
      while (k < end && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
      if (k < end && s.charCodeAt(k) === NL) return -1;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Skip spaces/tabs/newlines starting at i; fail (return -1) on a blank line.
function skipWsNoBlank(s, i, end) {
  let nl = 0;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === SP || c === TAB) i++;
    else if (c === NL) { nl++; if (nl >= 2) return -1; i++; }
    else break;
  }
  return i;
}

// Parse a link destination starting at i (after '(' + skipped ws).
// Returns [dest, nextIndex] or null. nextIndex is past the destination.
function parseDest(s, i, end) {
  if (i >= end) return null;
  if (s.charCodeAt(i) === LT) {
    let j = i + 1;
    let out = '';
    while (j < end) {
      const c = s.charCodeAt(j);
      if (c === GT) return [unescapePunct(out), j + 1];
      if (c === LT || c === NL) return null;
      if (c === BSLASH && j + 1 < end && isPunctCp(s.codePointAt(j + 1))) {
        out += s[j + 1]; j += 2;
      } else { out += s[j]; j++; }
    }
    return null;
  }
  let depth = 0, j = i;
  let out = '';
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === SP || c === TAB || c === NL) break;
    if (c < 32) return null;
    if (c === LPAREN) { depth++; out += s[j]; j++; continue; }
    if (c === RPAREN) {
      if (depth === 0) break;
      depth--; out += s[j]; j++; continue;
    }
    if (c === BSLASH && j + 1 < end && isPunctCp(s.codePointAt(j + 1))) {
      out += s[j + 1]; j += 2;
      continue;
    }
    out += s[j]; j++;
  }
  return [unescapePunct(out), j];
}

// Parse a link title starting at i. Returns [title, nextIndex] or null.
function parseTitle(s, i, end) {
  if (i >= end) return null;
  const q = s.charCodeAt(i);
  if (q !== QUOT && q !== APOS && q !== LPAREN) return null;
  const close = q === LPAREN ? RPAREN : q;
  let j = i + 1;
  let out = '';
  let nl = 0;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === close) return [unescapePunct(out), j + 1];
    if (c === NL) {
      nl++;
      // A blank line inside a title fails the link.
      let k = j + 1;
      while (k < end && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
      if (k < end && s.charCodeAt(k) === NL) return null;
      out += s[j]; j++;
      continue;
    }
    if (c === BSLASH && j + 1 < end && isPunctCp(s.codePointAt(j + 1))) {
      out += s[j + 1]; j += 2;
    } else { out += s[j]; j++; }
  }
  return null;
}

// Does a node tree contain a link or image anywhere (links cannot nest)?
function hasLink(nodes) {
  // A link's text may contain an image but not another link (marked's
  // inLink state); an image inside link text is the common badge pattern.
  // An angle-bracket autolink inside link text is allowed (marked's
  // inLink guards only the url tokenizer, not autolink), so autolinks
  // do not count here.
  for (const n of nodes) {
    if (n.t === 'link' && !n.autolink) return true;
    if (n.children && hasLink(n.children)) return true;
  }
  return false;
}

// Plain text of inline nodes (for image alt text). Text is numeric-ref
// decoded (marked's text tokens carry Ie-processed text), except raw-block
// text which stays literal.
function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.raw ? n.s : decodeNumericRefs(n.s);
    else if (n.t === 'esc') out += n.s;
    else if (n.t === 'code') out += n.s;
    else if (n.t === 'br') out += '\n';
    else if (n.t === 'html') out += n.s;
    else if (n.t === 'delim') out += n.ch.repeat(n.n);
    else if (n.t === 'link' && n.autolink) out += n.text;
    // An image inside alt text contributes its own alt text.
    else if (n.t === 'img') out += n.alt;
    else if (n.children) out += plainText(n.children);
  }
  return out;
}

// Try to parse a link or image starting at s[i] ('[' or '!' + '[').
// Returns {node, next} or null.
function parseLinkAt(s, i, end, defs, isImage) {
  const open = isImage ? i + 1 : i;
  const afterText = scanBracket(s, open, end);
  if (afterText < 0) return null;
  const text = s.slice(open + 1, afterText - 1);
  // Marked's Be(): if the link text contains a '<' starting an inline
  // tag or an angle-bracket autolink that runs past the end of the link
  // text, the link is not formed at all ([foo<https://...](uri)> is an
  // autolink, not a link). Code spans and backslash escapes are skipped.
  if (!isImage) {
    for (let q = 0; q < text.length; q++) {
      const qc = text.charCodeAt(q);
      if (qc === BSLASH) { q++; continue; }
      if (qc === BTICK) {
        const cs = parseCodeSpan(text, q, text.length);
        if (cs) { q = cs.next - 1; continue; }
        continue;
      }
      if (qc !== LT) continue;
      const pos = open + 1 + q;
      const tag = parseInlineHtml(s, pos, end);
      let mLen = -1;
      if (tag !== null) mLen = tag.length;
      else {
        const au = parseAngleAutolink(s, pos, end);
        if (au !== null) mLen = au.next - pos;
      }
      if (mLen > 0 && mLen > text.length - q) return null;
      if (mLen > 0) q += mLen - 1;
    }
  }
  // Inside a link's text, bare URLs/emails are not autolinked (marked's
  // inLink state guards the url tokenizer); angle-bracket autolinks
  // still are. An image's alt text keeps autolinking (it renders as
  // plain text anyway).
  const children = scanInline(text, 0, text.length, defs, !isImage);
  processEmphasis(children);
  // A link's text may not contain another link (marked's inLink state);
  // an image's alt text may contain links and images (they render as
  // their plain text in the alt attribute).
  if (!isImage && hasLink(children)) return null;
  // Marked unescapes \[ and \] in the link text before lexing it, so a
  // bracket that only looks escaped can still hide a link ([a \[b\]](/u)
  // with a [b] definition is not a link at all).
  if (text.indexOf('\\[') >= 0 || text.indexOf('\\]') >= 0) {
    const unesc = text.replace(/\\([\[\]])/g, '$1');
    if (unesc !== text) {
      const probe = scanInline(unesc, 0, unesc.length, defs, !isImage);
      processEmphasis(probe);
      if (!isImage && hasLink(probe)) return null;
    }
  }
  const j = afterText;
  if (j < end && s.charCodeAt(j) === LPAREN) {
    // Inline link: ( dest "title" ). If it fails to parse (an invalid
    // destination or title), fall through to the reference-link forms:
    // [foo](not a link) with a [foo] definition is a shortcut link.
    let k = skipWsNoBlank(s, j + 1, end);
    if (k >= 0) {
      let dest = '', next = k, ok = true;
      if (k < end && s.charCodeAt(k) !== RPAREN) {
        const d = parseDest(s, k, end);
        if (!d) ok = false;
        else {
          dest = d[0]; next = d[1];
          const k2 = skipWsNoBlank(s, next, end);
          if (k2 < 0) ok = false; else next = k2;
        }
      }
      let title = null;
      if (ok && next < end && s.charCodeAt(next) !== RPAREN) {
        const t = parseTitle(s, next, end);
        if (!t) ok = false;
        else {
          title = t[0]; next = t[1];
          const k2 = skipWsNoBlank(s, next, end);
          if (k2 < 0) ok = false; else next = k2;
        }
      }
      if (ok && next < end && s.charCodeAt(next) === RPAREN) {
        if (isImage) return { node: { t: 'img', src: dest, title, alt: plainText(children) }, next: next + 1 };
        return { node: { t: 'link', href: dest, title, children }, next: next + 1 };
      }
    }
  }
  if (j < end && s.charCodeAt(j) === LBRK) {
    // Full or collapsed reference link: [text][label] or [text][]
    const afterLabel = scanBracket(s, j, end);
    if (afterLabel < 0) return null;
    const label = s.slice(j + 1, afterLabel - 1);
    const key = label.length === 0 ? normalizeLabel(text) : normalizeLabel(label);
    if (!key) return null;
    const def = defs.get(key);
    if (!def) return null;
    if (isImage) return { node: { t: 'img', src: def.href, title: def.title, alt: plainText(children) }, next: afterLabel };
    return { node: { t: 'link', href: def.href, title: def.title, children }, next: afterLabel };
  }
  // Shortcut reference link.
  const key = normalizeLabel(text);
  if (!key) return null;
  const def = defs.get(key);
  if (!def) return null;
  if (isImage) return { node: { t: 'img', src: def.href, title: def.title, alt: plainText(children) }, next: j };
  return { node: { t: 'link', href: def.href, title: def.title, children }, next: j };
}

// Code span starting at a backtick run at i. Returns {content, next} or null.
function parseCodeSpan(s, i, end) {
  let n = 0, j = i;
  while (j < end && s.charCodeAt(j) === BTICK) { n++; j++; }
  let k = j;
  while (k < end) {
    if (s.charCodeAt(k) === BTICK) {
      let n2 = 0, q = k;
      while (q < end && s.charCodeAt(q) === BTICK) { n2++; q++; }
      if (n2 === n) {
        let content = s.slice(j, k).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === SP &&
            content.charCodeAt(content.length - 1) === SP && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        return { content, next: q };
      }
      k = q;
    } else k++;
  }
  return null;
}

// Ot-style code span starting at s[i] === '`' (marked's
// anyPunctuationOutsideCode): opening run + content whose first and last
// chars are not backticks + closing run of the same length. Returns the
// index just past the closing run, or -1.
function otCodeSpanEnd(s, i, end) {
  let n = 0, j = i;
  while (j < end && s.charCodeAt(j) === BTICK) { n++; j++; }
  if (j >= end || s.charCodeAt(j) === BTICK) return -1;
  let k = j;
  while (k < end) {
    if (s.charCodeAt(k) === BTICK) {
      let n2 = 0, q = k;
      while (q < end && s.charCodeAt(q) === BTICK) { n2++; q++; }
      if (n2 === n) return q;
      k = q;
    } else k++;
  }
  return -1;
}

// BlockSkip destination: '(' already consumed. Balanced parens (at most one
// level of nesting, as in marked's pattern), backslash escapes. Returns the
// index just past the closing ')', or -1.
function scanLinkDest(s, i, end) {
  let depth = 0, k = i;
  while (k < end) {
    const c = s.charCodeAt(k);
    if (c === BSLASH) { k += 2; continue; }
    if (c === LPAREN) { if (depth >= 1) return -1; depth++; k++; continue; }
    if (c === RPAREN) {
      if (depth === 0) return k + 1;
      depth--; k++; continue;
    }
    k++;
  }
  return -1;
}

// End of a blockSkip link match [...](...) starting at s[i] === '[',
// or -1. Marked's emStrong mask replaces such a construct (even one that
// fails to form a link, e.g. because its label holds a code span whose
// content contains a backtick) with [aaa...], so delimiters inside it are
// invisible to the emphasis scan. The label holds no '[' outside a code
// span; the first ']' outside a code span ends it.
function blockSkipLinkEnd(s, i, end) {
  let j = i + 1;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === BTICK) {
      const csEnd = otCodeSpanEnd(s, j, end);
      if (csEnd < 0) return -1;
      j = csEnd;
      continue;
    }
    if (c === LBRK) return -1;
    if (c === RBRK) {
      if (j + 1 < end && s.charCodeAt(j + 1) === LPAREN) {
        const dEnd = scanLinkDest(s, j + 2, end);
        if (dEnd > 0) return dEnd;
      }
      return -1;
    }
    j++;
  }
  return -1;
}

// Ranges [from, to) covered by an Ot code span over the raw text (marked's
// emStrong mask, steps 1+2: a code span's content is hidden from the
// emphasis scan). The scan ignores link/code boundaries, so a lone backtick
// can pair with a later one across a ']' and hide delimiters between them
// (e.g. the lone ` after ``small` pairs with the ` before __init__, hiding
// __issues most__). Real code spans are consumed as nodes anyway, so the
// ranges only matter for such fake spans. A backslash-escaped backtick is
// consumed by Ot's \\punct alternative and never starts a code span.
const _otPunctRe = /[\p{P}\p{S}]/u;
function otHiddenRanges(s, start, end) {
  const ranges = [];
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === BSLASH && i + 1 < end && _otPunctRe.test(s[i + 1])) { i += 2; continue; }
    if (c === BTICK) {
      const csEnd = otCodeSpanEnd(s, i, end);
      if (csEnd > 0) { ranges.push([i, csEnd]); i = csEnd; continue; }
      let j = i;
      while (j < end && s.charCodeAt(j) === BTICK) j++;
      i = j;
      continue;
    }
    i++;
  }
  return ranges;
}

// Inline HTML tag starting at s[i] === '<'. Returns the raw tag or null.
function parseInlineHtml(s, i, end) {
  if (s.startsWith('<!--', i)) {
    // Short comments <!--> and <!---> are complete tags (marked's -?> arm).
    if (s.startsWith('<!-->', i)) return s.slice(i, i + 5);
    if (s.startsWith('<!--->', i)) return s.slice(i, i + 7);
    const k = s.indexOf('-->', i + 4);
    if (k < 0) return s.slice(i, end);
    return s.slice(i, k + 3);
  }
  if (s.startsWith('<?', i)) {
    const k = s.indexOf('?>', i + 2);
    if (k < 0) return s.slice(i, end);
    return s.slice(i, k + 2);
  }
  if (s.startsWith('<!', i)) {
    if (i + 2 < end && s.charCodeAt(i + 2) >= 65 && s.charCodeAt(i + 2) <= 90) {
      const k = s.indexOf('>', i + 2);
      if (k < 0) return null;
      return s.slice(i, k + 1);
    }
    if (s.startsWith('<![CDATA[', i)) {
      const k = s.indexOf(']]>', i + 9);
      if (k < 0) return s.slice(i, end);
      return s.slice(i, k + 3);
    }
    return null;
  }
  // Open or close tag. A closing tag takes no attributes (marked's
  // close-tag pattern is </name\s*>); an open tag's attributes must each
  // be preceded by whitespace (<m:abc> and <a href='bar'title=title>
  // are not tags: the ':' and the 't' follow the name/value directly).
  let j = i + 1;
  let closing = false;
  if (j < end && s.charCodeAt(j) === SLASH) { closing = true; j++; }
  if (j >= end || !isAlpha(s.charCodeAt(j))) return null;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === MINUS) j++;
    else break;
  }
  if (closing) {
    while (j < end && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB || s.charCodeAt(j) === NL)) j++;
    if (j < end && s.charCodeAt(j) === GT) return s.slice(i, j + 1);
    return null;
  }
  // Attributes, each preceded by whitespace.
  let sawWs = false;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === SP || c === TAB || c === NL) { sawWs = true; j++; continue; }
    if (c === SLASH && j + 1 < end && s.charCodeAt(j + 1) === GT) return s.slice(i, j + 2);
    if (c === GT) return s.slice(i, j + 1);
    // Attribute name (must follow whitespace).
    if (!sawWs) return null;
    if (!isAlpha(c) && c !== USCORE && c !== COLON) return null;
    sawWs = false;
    while (j < end) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === USCORE || d === COLON || d === DOT || d === MINUS) j++;
      else break;
    }
    // Whitespace here separates this attribute from the next one (a
    // boolean attribute like _boolean is followed by a space, then the
    // next attribute name).
    while (j < end && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB || s.charCodeAt(j) === NL)) { sawWs = true; j++; }
    if (j < end && s.charCodeAt(j) === EQ) {
      j++;
      while (j < end && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB || s.charCodeAt(j) === NL)) j++;
      if (j < end && (s.charCodeAt(j) === QUOT || s.charCodeAt(j) === APOS)) {
        const q = s.charCodeAt(j);
        j++;
        while (j < end && s.charCodeAt(j) !== q) j++;
        if (j >= end) return null;
        j++;
      } else {
        while (j < end) {
          const d = s.charCodeAt(j);
          if (d === SP || d === TAB || d === NL || d === GT || d === QUOT || d === APOS ||
              d === EQ || d === LT || d === BTICK) break;
          j++;
        }
        if (j >= end) return null;
      }
    }
  }
  return null;
}

// Angle-bracket autolink <...> starting at i. Returns {href, text, next} or null.
function parseAngleAutolink(s, i, end) {
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}: then no space/<</> up to '>'.
  let j = i + 1;
  if (j >= end || !isAlpha(s.charCodeAt(j))) return null;
  let k = j;
  while (k < end) {
    const c = s.charCodeAt(k);
    if (isAlnum(c) || c === PLUS || c === DOT || c === MINUS) k++;
    else break;
  }
  if (k - j >= 2 && k - j <= 32 && k < end && s.charCodeAt(k) === COLON) {
    let m = k + 1;
    while (m < end) {
      const c = s.charCodeAt(m);
      if (c === GT) {
        const inner = s.slice(i + 1, m);
        return { href: inner, text: inner, next: m + 1 };
      }
      if (c === SP || c === TAB || c === NL || c === LT) return null;
      m++;
    }
    return null;
  }
  // Email: local@domain(.domain)* up to '>'.
  const emailRe = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/;
  const m = emailRe.exec(s.slice(i + 1, end));
  if (m) {
    const inner = m[0].slice(0, -1);
    return { href: 'mailto:' + inner, text: inner, next: i + 1 + m[0].length };
  }
  return null;
}

// Trailing trim for extended autolinks: marked's _backpedal regex, applied
// to the whole candidate. It keeps a trailing ')' when it closes a
// balanced (...) group or sits mid-URL (https://x/a)](./b/c) links in
// full), drops trailing punctuation at the very end, cuts a trailing
// named entity back to its '&', and keeps a numeric reference's digits
// while dropping its ';'.
const _backpedalRe = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAutolinkEnd(url) {
  // Marked applies the backpedal repeatedly until the string stops
  // changing (a single pass can leave a trailing '*' or ')' behind when
  // it is followed by more punctuation).
  let cur = url;
  for (;;) {
    const m = _backpedalRe.exec(cur);
    const next = m ? m[0] : '';
    if (next === cur) return next.length;
    cur = next;
  }
}

// Extended autolink (www. / http(s)|ftp:// / bare email / mailto: / xmpp:)
// starting at i. The caller guarantees the preceding-char rule for www.
// Returns {href, text, next} or null. allowU: as in parseBareEmail, a '_'
// run may end a mailto:/xmpp: address when it closes an open emphasis.
function parseExtAutolink(s, i, end, allowU) {
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    let k = j;
    while (k < end) {
      const c = s.charCodeAt(k);
      if (c === SP || c === TAB || c === NL || c === LT) break;
      k++;
    }
    const raw = s.slice(i, k);
    const cut = trimAutolinkEnd(raw);
    if (cut <= 4) return null;
    const url = raw.slice(0, cut);
    // Domain part: at least one label char after www. (a dot is not
    // required; www.foo is a link). Labels are alnum/dash separated by dots.
    if (!/^www\.[A-Za-z0-9-]/.test(url)) return null;
    return { href: 'http://' + url, text: url, next: i + cut };
  }
  // Scheme URLs are case-insensitive (Https:// links, marked's protocol
  // pattern is [hH][tT][tT][pP][sS]?).
  const lower = s.slice(i, Math.min(end, i + 8)).toLowerCase();
  if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('ftp://')) {
    const protoLen = lower.startsWith('https://') ? 8 : lower.startsWith('http://') ? 7 : 6;
    // A domain label must follow the protocol (http://&copy; is not a link).
    const dc = i + protoLen < end ? s.charCodeAt(i + protoLen) : -1;
    if (dc < 0 || (!isAlnum(dc) && dc !== MINUS)) return null;
    let k = i;
    while (k < end) {
      const c = s.charCodeAt(k);
      if (c === SP || c === TAB || c === NL || c === LT) break;
      k++;
    }
    const raw = s.slice(i, k);
    const cut = trimAutolinkEnd(raw);
    if (cut <= 0) return null;
    const url = raw.slice(0, cut);
    return { href: url, text: url, next: i + cut };
  }
  if (s.startsWith('mailto:', i)) {
    const proto = 'mailto:';
    const rest = s.slice(i + proto.length, end);
    const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/.exec(rest);
    if (!m) return null;
    // The email must not be followed by a word char or '-'; a '_' run
    // may end it when it closes an open emphasis (see parseBareEmail).
    const after = i + proto.length + m[0].length;
    if (after < end) {
      const c = s.charCodeAt(after);
      if (c === USCORE) {
        if (!allowU) return null;
        let r = after;
        while (r < end && s.charCodeAt(r) === USCORE) r++;
        if (r < end && (isAlnum(s.charCodeAt(r)) || s.charCodeAt(r) === MINUS)) return null;
      } else if (isAlnum(c) || c === MINUS) return null;
    }
    const url = proto + m[0];
    return { href: url, text: url, next: after };
  }
  if (s.startsWith('xmpp:', i)) {
    // xmpp: is emailProtocol: the email plus an optional single path
    // segment /[A-Za-z0-9@.]+ (no second slash: xmpp:foo@bar.baz/txt
    // links, /bin stays outside).
    const rest = s.slice(i + 5, end);
    let m = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?/.exec(rest);
    if (!m && allowU) {
      // Retry without the trailing-word lookahead: the address may end
      // before a '_' run that closes an open emphasis.
      const m2 = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?/.exec(rest);
      if (m2) {
        const after = i + 5 + m2[0].length;
        if (after < end && s.charCodeAt(after) === USCORE) {
          let r = after;
          while (r < end && s.charCodeAt(r) === USCORE) r++;
          if (r >= end || (!isAlnum(s.charCodeAt(r)) && s.charCodeAt(r) !== MINUS)) m = m2;
        }
      }
    }
    if (!m) return null;
    const url = 'xmpp:' + m[0];
    return { href: url, text: url, next: i + 5 + m[0].length };
  }
  return null;
}

// Bare email starting at i (local part). Returns {href, text, next} or null.
// allowU: a '_' run may end the address when it closes an unmatched '_'
// opener scanned so far (marked tokenizes the emphasis first, so an email
// inside _..._ is scanned without its closing '_'; _foo@bar.com_ links,
// while foo@bar.com_ with no opener does not).
function parseBareEmail(s, i, end, allowU) {
  let j = i;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === DOT || c === USCORE || c === PLUS || c === MINUS) j++;
    else break;
  }
  if (j === i || j >= end || s.charCodeAt(j) !== AT) return null;
  const local = s.slice(i, j);
  let k = j + 1;
  const domStart = k;
  while (k < end) {
    const c = s.charCodeAt(k);
    if (isAlnum(c) || c === DOT || c === MINUS || c === USCORE) k++;
    else break;
  }
  // A trailing dot or underscore is not part of the domain
  // (a.b-c_d@a.b. links the address without the dot).
  while (k > domStart && (s.charCodeAt(k - 1) === DOT || s.charCodeAt(k - 1) === USCORE)) k--;
  const dom = s.slice(domStart, k);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(dom)) return null;
  if (k < end) {
    const c = s.charCodeAt(k);
    if (c === USCORE) {
      // A '_' run ends the address only when it can close an open
      // emphasis (followed by whitespace, punctuation or end, not by a
      // word character: foo@bar.com_baz is not a link).
      if (!allowU) return null;
      let r = k;
      while (r < end && s.charCodeAt(r) === USCORE) r++;
      if (r < end && (isAlnum(s.charCodeAt(r)) || s.charCodeAt(r) === MINUS)) return null;
      const addr = local + '@' + dom;
      return { href: 'mailto:' + addr, text: addr, next: k };
    }
    if (isAlnum(c) || c === MINUS) return null;
  }
  const addr = local + '@' + dom;
  return { href: 'mailto:' + addr, text: addr, next: k };
}

// Is there an unmatched '_' opener delimiter among the nodes scanned so
// far? Simulates the delimiter stack greedily: a closer consumes an
// opener, an opener (or a both-flanking run with nothing to close) adds
// one.
function hasOpenUnderscore(nodes) {
  let depth = 0;
  for (const nd of nodes) {
    if (nd.t !== 'delim' || nd.ch !== '_') continue;
    if (nd.canClose && depth > 0) depth--;
    else if (nd.canOpen) depth++;
  }
  return depth > 0;
}

// Flanking info for a delimiter run starting at i with length n in s[start..end).
function delimFlankingCp(before, after, ch) {
  const beforeWs = before < 0 || isWsCp(before);
  const beforePunct = before >= 0 && isPunctCp(before);
  const afterWs = after < 0 || isWsCp(after);
  const afterPunct = after >= 0 && isPunctCp(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  if (ch === '_') {
    return { canOpen: leftFlanking && (!rightFlanking || beforePunct),
             canClose: rightFlanking && (!leftFlanking || afterPunct) };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

function delimFlanking(s, i, n, start, end) {
  // Code point before the run (-1 = start of inline text, counts as ws).
  let before = -1;
  if (i > start) {
    const c1 = s.charCodeAt(i - 1);
    if (c1 >= 0xDC00 && c1 <= 0xDFFF && i - 2 >= start) {
      const c0 = s.charCodeAt(i - 2);
      if (c0 >= 0xD800 && c0 <= 0xDBFF) before = s.codePointAt(i - 2);
      else before = c1;
    } else before = c1;
  }
  const after = i + n < end ? s.codePointAt(i + n) : -1;
  const beforeWs = before < 0 || isWsCp(before);
  const beforePunct = before >= 0 && isPunctCp(before);
  const afterWs = after < 0 || isWsCp(after);
  const afterPunct = after >= 0 && isPunctCp(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { leftFlanking, rightFlanking, beforePunct, afterPunct, before, after };
}

function renderText(s, raw) {
  if (raw) return s;
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  return escapeHtml(decodeNumericRefs(s), false);
}

function renderNodes(nodes, out) {
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out.push(renderText(n.s, n.raw)); break;
      // A backslash-escaped char is its own node: it is escaped but never
      // entity-decoded, so \&copy; renders &amp;copy; (marked's escape token).
      case 'esc': out.push(escapeHtml(n.s, false)); break;
      case 'code': out.push('<code>' + escapeHtml(n.s, true) + '</code>'); break;
      case 'br': out.push('<br>'); break;
      case 'html': out.push(n.s); break;
      case 'delim': out.push(n.ch.repeat(n.n)); break;
      case 'checkbox':
        out.push('<input ' + (n.checked ? 'checked="" ' : '') +
          'disabled="" type="checkbox"> ');
        break;
      case 'link': {
        const cleaned = cleanUrl(n.href);
        if (cleaned === null) {
          // encodeURI threw: the link renders as plain text (marked's he()).
          if (n.autolink) out.push(escapeHtml(n.text, true));
          else renderNodes(n.children, out);
          break;
        }
        // Autolinks escape the href with encode=true and their text (the
        // raw URL) the same way; normal links use encode=false for both.
        out.push('<a href="' + escapeHtml(cleaned, !!n.autolink) + '"');
        if (n.title != null) out.push(' title="' + escapeHtml(n.title, false) + '"');
        out.push('>');
        if (n.autolink) out.push(escapeHtml(n.text, true));
        else renderNodes(n.children, out);
        out.push('</a>');
        break;
      }
      case 'img': {
        const cleaned = cleanUrl(n.src);
        if (cleaned === null) { out.push(escapeHtml(n.alt, false)); break; }
        out.push('<img src="' + escapeHtml(cleaned, false) + '" alt="' +
          escapeHtml(n.alt, false) + '"');
        if (n.title != null) out.push(' title="' + escapeHtml(n.title, false) + '"');
        out.push('>');
        break;
      }
      case 'em': out.push('<em>'); renderNodes(n.children, out); out.push('</em>'); break;
      case 'strong': out.push('<strong>'); renderNodes(n.children, out); out.push('</strong>'); break;
      case 'del': out.push('<del>'); renderNodes(n.children, out); out.push('</del>'); break;
    }
  }
}

// Collect the same-char delimiter runs between two nodes (exclusive) in
// order, for marked's emStrong accounting: a wrap contributes its opener
// run, its children's runs, then its closer run; a leftover delimiter
// adjacent to a wrap is the same original run as that wrap's run and is
// merged into it; link children are not scanned (marked masks them).
function collectEmRunsInto(nodes, from, to, ch, runs) {
  let pending = null; // leftover delim waiting to merge into a wrap's opener
  for (let k = from; k < to; k++) {
    const nd = nodes[k];
    if (nd.t === 'delim' && nd.ch === ch) {
      const prev = k > from ? nodes[k - 1] : null;
      if (prev && (prev.t === 'em' || prev.t === 'strong' || prev.t === 'del') && prev.ch === ch && runs.length > 0) {
        runs[runs.length - 1].len += nd.n;
        continue;
      }
      const next = k + 1 < to ? nodes[k + 1] : null;
      if (next && (next.t === 'em' || next.t === 'strong' || next.t === 'del') && next.ch === ch) {
        pending = nd;
        continue;
      }
      runs.push({ len: nd.n, canOpen: nd.canOpen, canClose: nd.canClose });
      continue;
    }
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
      // Only a wrap of the same char contributes its own runs; a wrap of
      // another char still hides same-char runs in its children.
      if (nd.ch === ch) {
        const oLen = (nd.oUse || 0) + (pending && pending.ch === ch ? pending.n : 0);
        runs.push({ len: oLen, canOpen: true, canClose: !!nd.openerCanClose });
      }
      pending = null;
      if (nd.children) collectEmRunsInto(nd.children, 0, nd.children.length, ch, runs);
      if (nd.ch === ch) runs.push({ len: nd.cUse || 0, canOpen: !!nd.closerCanOpen, canClose: true });
      continue;
    }
    pending = null;
  }
}

// Marked's emStrong accounting for a candidate opener (nodes[oi]) and
// closer (nodes[ci]) of char ch: m starts at the opener length; an
// opener-only run adds, a closer-only run subtracts, a both-flanking run
// is skipped when y%3 and (y+len)%3==0 and otherwise subtracts. True when
// the closer can close the opener.
function emphasisAccountingAllows(nodes, oi, ci, ch) {
  const opener = nodes[oi];
  const closer = nodes[ci];
  const y = opener.n;
  let m = opener.n;
  const runs = [];
  collectEmRunsInto(nodes, oi + 1, ci, ch, runs);
  for (const r of runs) {
    if (r.canOpen && !r.canClose) { m += r.len; continue; }
    if (!r.canOpen && r.canClose) { m -= r.len; if (m <= 0) return true; continue; }
    if (r.canOpen && r.canClose) {
      if (y % 3 !== 0 && (y + r.len) % 3 === 0) continue;
      m -= r.len;
      if (m <= 0) return true;
    }
  }
  if (!closer.canOpen && closer.canClose) { m -= closer.n; return m <= 0; }
  if (closer.canOpen && closer.canClose) {
    if (y % 3 !== 0 && (y + closer.n) % 3 === 0) return false;
    m -= closer.n;
    return m <= 0;
  }
  return false;
}

// CommonMark delimiter-stack emphasis (+ GFM strikethrough for '~').
// '~' delimiters match only equal-length runs of 1-2; '*'/'_' use the
// odd-match (multiple-of-3) rule and 1-or-2 delimiter consumption.
// Length of the same-char run immediately before the opener at nodes[oi]
// in the masked text, the code point before that run (-1 = start), and
// whether the character immediately before the opener run is the
// delimiter char itself (marked's `o`: the opener is part of a longer
// run, so a both-flanking run later in the scan aborts the match).
// The run extends over text nodes ending with the char, leftover delim
// runs of the same char, and a wrap whose closer run is the same char.
function prevRunInfo(nodes, oi, ch) {
  const chCp = ch === '*' ? STAR : ch === '_' ? USCORE : TILDE;
  let ext = 0, prevCp = -1, o = false;
  let j = oi - 1;
  if (j >= 0) {
    const p0 = nodes[j];
    const last0 = edgeCp(nodes, j, j + 1, false);
    o = last0 === chCp;
  }
  while (j >= 0) {
    const p = nodes[j];
    if (p.t === 'text' || p.t === 'esc') {
      let k2 = 0;
      for (let q = p.s.length - 1; q >= 0 && p.s.charCodeAt(q) === chCp; q--) k2++;
      ext += k2;
      if (k2 < p.s.length) { prevCp = p.s.codePointAt(p.s.length - 1 - k2); break; }
      j--; continue;
    }
    if (p.t === 'delim' && p.ch === ch) { ext += p.n; j--; continue; }
    if ((p.t === 'em' || p.t === 'strong' || p.t === 'del') && p.ch === ch) {
      ext += p.cUse || 0;
      // The char before the wrap's closer run is the last char of its
      // inner text (or the opener's delimiter when the text is empty).
      const lastCp = p.children.length ? edgeCp(p.children, 0, p.children.length, false) : -1;
      prevCp = lastCp >= 0 ? lastCp : chCp;
      break;
    }
    prevCp = edgeCp(nodes, j, j + 1, false);
    break;
  }
  return { ext, prevCp, o };
}

// First/last character of the content nodes[from..to), for the flanking of
// a leftover delimiter run at the edge of a wrap's inner text. Returns the
// code point, or -1 when the range is empty. A link starts with '[' and
// ends with ')', a code span with '`', a wrap with its delimiter, an image
// with '!' / ')', an HTML tag with '<' / '>'.
function edgeCp(nodes, from, to, first) {
  if (first) {
    for (let j = from; j < to; j++) {
      const n = nodes[j];
      if (n.t === 'br' || n.t === 'checkbox') continue;
      if (n.t === 'text' || n.t === 'esc') return n.s.length ? n.s.codePointAt(0) : -1;
      if (n.t === 'code') return BTICK;
      if (n.t === 'link') return LBRK;
      if (n.t === 'img') return BANG;
      if (n.t === 'html') return LT;
      if (n.t === 'delim') return n.ch === '*' ? STAR : n.ch === '_' ? USCORE : TILDE;
      if (n.t === 'em' || n.t === 'strong' || n.t === 'del') return n.ch === '*' ? STAR : n.ch === '_' ? USCORE : TILDE;
    }
    return -1;
  }
  for (let j = to - 1; j >= from; j--) {
    const n = nodes[j];
    if (n.t === 'br' || n.t === 'checkbox') continue;
    if (n.t === 'text' || n.t === 'esc') return n.s.length ? n.s.codePointAt(n.s.length - 1) : -1;
    if (n.t === 'code') return BTICK;
    if (n.t === 'link' || n.t === 'img') return RPAREN;
    if (n.t === 'html') return GT;
    if (n.t === 'delim') return n.ch === '*' ? STAR : n.ch === '_' ? USCORE : TILDE;
    if (n.t === 'em' || n.t === 'strong' || n.t === 'del') return n.ch === '*' ? STAR : n.ch === '_' ? USCORE : TILDE;
  }
  return -1;
}

// Marked's RDelim skip-alternative: a run of `ch` inside an other-char
// strong pair (__...*...__ for `*`, **..._...** for `_`) is skipped by
// the scan, but only when the pair starts before any other delimiter run
// after the opener (the regex alternative is anchored at the start of the
// scanned text). Returns the index of the skipped run, or -1. A code span
// or link node between the runs does not break the [^_*]*? gap (the mask
// hides it); a text node containing a literal * or _ does.
function findSkippedRun(nodes, oi, ch) {
  const other = ch === '*' ? '_' : '*';
  let j = oi + 1;
  while (j < nodes.length) {
    const nd = nodes[j];
    if (nd.t === 'delim') break;
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') return -1;
    if ((nd.t === 'text' || nd.t === 'esc') && (nd.s.includes('*') || nd.s.includes('_'))) return -1;
    j++;
  }
  if (j >= nodes.length) return -1;
  const open = nodes[j];
  if (open.t !== 'delim' || open.ch !== other || open.n < 2) return -1;
  let k2 = j + 1;
  while (k2 < nodes.length) {
    const nd = nodes[k2];
    if (nd.t === 'delim') break;
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') return -1;
    if ((nd.t === 'text' || nd.t === 'esc') && (nd.s.includes('*') || nd.s.includes('_'))) return -1;
    k2++;
  }
  if (k2 >= nodes.length) return -1;
  const mid = nodes[k2];
  if (mid.t !== 'delim' || mid.ch !== ch) return -1;
  let l2 = k2 + 1;
  while (l2 < nodes.length) {
    const nd = nodes[l2];
    if (nd.t === 'delim') break;
    if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') return -1;
    if ((nd.t === 'text' || nd.t === 'esc') && (nd.s.includes('*') || nd.s.includes('_'))) return -1;
    l2++;
  }
  if (l2 >= nodes.length) return -1;
  const close = nodes[l2];
  if (close.t !== 'delim' || close.ch !== other || close.n < 2) return -1;
  return k2;
}

// Marked's emStrong forward scan for the opener at nodes[oi]: m starts at
// the opener length; an opener-only run adds, a closer-only run subtracts,
// a both-flanking run is skipped by the rule of three (y = opener length)
// and otherwise subtracts; f accumulates the skipped runs' lengths. The
// first run where m <= 0 is the closer; b is the number of delimiters the
// match consumes from that run (the whole run when m + f >= 0, otherwise
// only enough to reach zero). Returns {closerIdx, b, f} or null. For '~'
// (del) the scan is marked's del accounting: same-length runs only,
// opener-only runs add, closer-only/both runs subtract.
function findEmCloser(nodes, oi) {
  const opener = nodes[oi];
  const ch = opener.ch;
  if (ch === '~') {
    const o = opener.n;
    let p = o;
    for (let j = oi + 1; j < nodes.length; j++) {
      const nd = nodes[j];
      if (nd.t !== 'delim' || nd.ch !== '~' || nd.n !== o) continue;
      if (nd.canOpen && !nd.canClose) { p += o; continue; }
      p -= o;
      if (p <= 0) return { closerIdx: j, b: o, f: 0 };
    }
    return null;
  }
  const k = opener.n;
  const { ext, prevCp, o } = prevRunInfo(nodes, oi, ch);
  const y = k + ext;
  let m = k, f = 0;
  const skipIdx = findSkippedRun(nodes, oi, ch);
  for (let j = oi + 1; j < nodes.length; j++) {
    const nd = nodes[j];
    if (nd.t !== 'delim' || nd.ch !== ch) continue;
    if (j === skipIdx) continue;
    const len = nd.n;
    if (nd.canOpen && !nd.canClose) { m += len; continue; }
    if (nd.canOpen && nd.canClose) {
      if (o) return null;
      if (y % 3 !== 0 && (y + len) % 3 === 0) { f += len; continue; }
      m -= len;
      if (m <= 0) return { closerIdx: j, b: Math.min(len, len + m + f), f };
      continue;
    }
    if (!nd.canOpen && nd.canClose) {
      m -= len;
      if (m <= 0) return { closerIdx: j, b: Math.min(len, len + m + f), f };
    }
  }
  return null;
}

// CommonMark delimiter-stack emphasis (+ GFM strikethrough for '~'),
// opener-driven like marked's emStrong/del: the leftmost opener is tried
// first and claims the first closer its accounting reaches. An opener with
// no closer becomes literal text, so a later closer cannot claim it
// (**by command *tool*one** forms no strong: the outer ** has no closer).
// A match consumes `use` delimiters from the opener (1 for em, 2 for
// strong); the opener's leftover (k - use) and the closer's leftover
// (b - use) stay INSIDE the wrap as its first/last children (marked's
// M.slice(use, -use)), and only the closer run's unconsumed rest (L - b)
// stays after the wrap.
function processEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (node.t !== 'delim' || !node.canOpen) { i++; continue; }
    const res = findEmCloser(nodes, i);
    if (!res) {
      if (node.ch !== '~' && node.n > 1) {
        // Marked consumes one delimiter char as literal text and retries
        // the shortened run (**foo* forms *<em>foo</em>: the first * is
        // literal, the second opens the em). The shortened run is
        // preceded by the delimiter char itself.
        const chCp = node.ch === '*' ? STAR : USCORE;
        const rem = delimFlankingCp(chCp, node.after ?? -1, node.ch);
        nodes.splice(i, 1,
          { t: 'text', s: node.ch },
          { t: 'delim', ch: node.ch, n: node.n - 1, canOpen: rem.canOpen, canClose: rem.canClose, before: chCp, after: node.after ?? -1 });
        i += 1;
        continue;
      }
      node.canOpen = false;
      node.canClose = false;
      i++;
      continue;
    }
    const closer = nodes[res.closerIdx];
    const k = node.n;
    const L = closer.n;
    const b = res.b;
    const use = node.ch === '~' ? res.b :
      (Math.min(k, b) % 2 === 1 ? 1 : 2);
    const wrapType = node.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const inner = nodes.slice(i + 1, res.closerIdx);
    const children = [];
    if (k - use > 0) {
      const firstCp = edgeCp(nodes, i + 1, res.closerIdx, true);
      const lf = delimFlankingCp(-1, firstCp, node.ch);
      children.push({ t: 'delim', ch: node.ch, n: k - use,
        canOpen: lf.canOpen, canClose: false, before: -1, after: firstCp });
    }
    children.push(...inner);
    if (b - use > 0) {
      const lastCp = edgeCp(nodes, i + 1, res.closerIdx, false);
      const lf = delimFlankingCp(lastCp, -1, node.ch);
      children.push({ t: 'delim', ch: node.ch, n: b - use,
        canOpen: false, canClose: lf.canClose, before: lastCp, after: -1 });
    }
    processEmphasis(children);
    const wrap = { t: wrapType, ch: node.ch, children,
      closerCanOpen: closer.canOpen, openerCanClose: node.canClose,
      oUse: use, cUse: use };
    const repl = [wrap];
    if (L - b > 0) {
      const chCp = node.ch === '*' ? STAR : node.ch === '_' ? USCORE : TILDE;
      const lf = delimFlankingCp(chCp, closer.after ?? -1, node.ch);
      repl.push({ t: 'delim', ch: node.ch, n: L - b,
        canOpen: lf.canOpen, canClose: lf.canClose, before: chCp, after: closer.after ?? -1 });
    }
    nodes.splice(i, res.closerIdx - i + 1, ...repl);
    // Continue just after the wrap: the node there is either the closer
    // run's leftover (a possible opener for a later closer) or the next
    // untouched node.
    i += 1;
  }
}

// Scan inline content s[start..end) into nodes (emphasis not yet resolved).
// inLink disables bare-URL/email autolinking (inside a link's text).
function scanInline(s, start, end, defs, inLink) {
  const nodes = [];
  let textBuf = '';
  // End of a blockSkip-masked [...](...) region: delimiters inside it are
  // literal text (marked's emStrong mask hides the construct from the
  // emphasis scan even when it fails to form a link).
  let noEmUntil = -1;
  // Ranges hidden by Ot code spans (see otHiddenRanges); delimiters inside
  // them are literal text. Delimiters are met in increasing position order,
  // so a single index walks the ranges.
  const hidden = otHiddenRanges(s, start, end);
  let hiddenIdx = 0;
  const isHidden = (pos) => {
    while (hiddenIdx < hidden.length && hidden[hiddenIdx][1] <= pos) hiddenIdx++;
    return hiddenIdx < hidden.length && hidden[hiddenIdx][0] <= pos && pos < hidden[hiddenIdx][1];
  };
  // Inside <pre>/<code>/<kbd>/<script> (and until the matching end tag)
  // text tokens are raw: no entity decoding, no escaping (marked's
  // inRawBlock state).
  let inRawBlock = false;
  const flush = () => {
    if (textBuf) {
      nodes.push(inRawBlock ? { t: 'text', s: textBuf, raw: true } : { t: 'text', s: textBuf });
      textBuf = '';
    }
  };
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === BSLASH) {
      const d = i + 1 < end ? s.charCodeAt(i + 1) : -1;
      if (d === NL) {
        // Backslash hard break: only if non-whitespace content follows
        // (marked's br regex (?!\s*$) lookahead), and the break consumes
        // the leading spaces/tabs of the next line.
        let k = i + 2;
        while (k < end && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
        let hasContent = false;
        for (let q = k; q < end; q++) {
          const qc = s.charCodeAt(q);
          if (qc !== SP && qc !== TAB && qc !== NL) { hasContent = true; break; }
        }
        if (hasContent) { flush(); nodes.push({ t: 'br' }); i = k; continue; }
        textBuf += '\\'; i++; continue;
      }
      // A backslash-escaped char is its own node (never entity-decoded).
      if (d >= 0 && isAsciiPunct(d)) { flush(); nodes.push({ t: 'esc', s: s[i + 1] }); i += 2; continue; }
      textBuf += '\\'; i++; continue;
    }
    if (c === BTICK) {
      const cs = parseCodeSpan(s, i, end);
      if (cs) { flush(); nodes.push({ t: 'code', s: cs.content }); i = cs.next; continue; }
      // No closing run of the same length: the whole backtick run is
      // literal text (marked's text tokenizer consumes `+ as one token).
      let n = 0, j = i;
      while (j < end && s.charCodeAt(j) === BTICK) { n++; j++; }
      textBuf += s.slice(i, j); i = j; continue;
    }
    if (c === LBRK || (c === BANG && i + 1 < end && s.charCodeAt(i + 1) === LBRK)) {
      if (i < noEmUntil) { textBuf += s[i]; i++; continue; }
      const r = parseLinkAt(s, i, end, defs, c === BANG);
      if (r) { flush(); nodes.push(r.node); i = r.next; continue; }
      const bEnd = blockSkipLinkEnd(s, c === BANG ? i + 1 : i, end);
      if (bEnd > 0) noEmUntil = bEnd;
      textBuf += s[i]; i++; continue;
    }
    if (c === STAR || c === USCORE) {
      const ch = c === STAR ? '*' : '_';
      let n = 0, j = i;
      while (j < end && s.charCodeAt(j) === c) { n++; j++; }
      if (i < noEmUntil || isHidden(i)) { textBuf += s.slice(i, j); i = j; continue; }
      const fl = delimFlanking(s, i, n, start, end);
      let canOpen, canClose;
      if (c === STAR) { canOpen = fl.leftFlanking; canClose = fl.rightFlanking; }
      else {
        canOpen = fl.leftFlanking && (!fl.rightFlanking || fl.beforePunct);
        canClose = fl.rightFlanking && (!fl.leftFlanking || fl.afterPunct);
      }
      flush();
      nodes.push({ t: 'delim', ch, n, canOpen, canClose, before: fl.before, after: fl.after });
      i = j;
      continue;
    }
    if (c === TILDE) {
      let n = 0, j = i;
      while (j < end && s.charCodeAt(j) === TILDE) { n++; j++; }
      if (i < noEmUntil || isHidden(i)) { textBuf += s.slice(i, j); i = j; continue; }
      if (n <= 2) {
        const fl = delimFlanking(s, i, n, start, end);
        flush();
        nodes.push({ t: 'delim', ch: '~', n, canOpen: fl.leftFlanking, canClose: fl.rightFlanking, before: fl.before, after: fl.after });
      } else {
        textBuf += s.slice(i, j);
      }
      i = j;
      continue;
    }
    if (c === LT) {
      const au = parseAngleAutolink(s, i, end);
      if (au) {
        flush();
        nodes.push({ t: 'link', href: au.href, title: null, text: au.text, autolink: true });
        i = au.next;
        continue;
      }
      const html = parseInlineHtml(s, i, end);
      if (html !== null) {
        flush();
        nodes.push({ t: 'html', s: html });
        if (!inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(html)) inRawBlock = true;
        else if (inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(html)) inRawBlock = false;
        // An inline <a ...> tag sets the document-level inLink (bare
        // autolinks stop for the rest of the document); </a> clears it.
        // startATag is /^<a /i, endATag is /^<\/a>/i in marked.
        if (/^<a /i.test(html)) _docInLink = true;
        else if (/^<\/a>/i.test(html)) _docInLink = false;
        i += html.length;
        continue;
      }
      textBuf += '<'; i++; continue;
    }
    if (c === SP) {
      // Hard break: 2+ spaces + newline (with non-whitespace content
      // after it), consuming the leading spaces/tabs of the next line
      // (marked's br regex: ^( {2,}|\\\\)\n(?!\s*$)[ \t]*).
      let j = i;
      while (j < end && s.charCodeAt(j) === SP) j++;
      if (j - i >= 2 && j < end && s.charCodeAt(j) === NL) {
        let k = j + 1;
        while (k < end && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB)) k++;
        let hasContent = false;
        for (let q = k; q < end; q++) {
          const qc = s.charCodeAt(q);
          if (qc !== SP && qc !== TAB && qc !== NL) { hasContent = true; break; }
        }
        if (hasContent) { flush(); nodes.push({ t: 'br' }); i = k; continue; }
      }
      textBuf += s.slice(i, j); i = j; continue;
    }
    if (c === AT && !inLink && !_docInLink) {
      // Bare email: the local part may be split across the current text
      // run and preceding nodes (a '_' delimiter flushes the buffer, so
      // a.b-c_d@a.b would otherwise read as only d@a.b). Collect the
      // trailing local-part run from the buffer and the nodes before it.
      let local = '';
      let bufCut = textBuf.length;
      {
        let k = textBuf.length;
        while (k > 0) {
          const d = textBuf.charCodeAt(k - 1);
          if (isAlnum(d) || d === DOT || d === USCORE || d === PLUS || d === MINUS) k--;
          else break;
        }
        local = textBuf.slice(k);
        bufCut = k;
      }
      // How many trailing nodes are fully part of the local run, and
      // where the run starts inside the last partial node.
      let nodeCut = nodes.length; // first node index that is (partly) consumed
      let nodeTextCut = -1; // cut position inside nodes[nodeCut] if it is text
      if (bufCut === 0 && local.length > 0) {
        let ni = nodes.length - 1;
        let done = false;
        while (ni >= 0 && !done) {
          const nd = nodes[ni];
          if (nd.t === 'delim' && nd.ch === '_') {
            local = '_'.repeat(nd.n) + local;
            ni--;
            continue;
          }
          if (nd.t === 'text') {
            const s2 = nd.s;
            let m = s2.length;
            while (m > 0) {
              const d = s2.charCodeAt(m - 1);
              if (isAlnum(d) || d === DOT || d === USCORE || d === PLUS || d === MINUS) m--;
              else break;
            }
            local = s2.slice(m) + local;
            nodeCut = ni;
            nodeTextCut = m;
            done = m > 0;
            ni--;
            continue;
          }
          done = true;
        }
        if (!done) nodeCut = ni + 1;
      }
      if (local.length > 0) {
        const em = parseBareEmail(local + s.slice(i, end), 0, local.length + (end - i), hasOpenUnderscore(nodes));
        if (em) {
          // Remove the consumed local part from the buffer/nodes.
          textBuf = textBuf.slice(0, bufCut);
          if (nodeCut < nodes.length) {
            const nd = nodes[nodeCut];
            if (nd.t === 'text') {
              if (nodeTextCut === 0) nodes.splice(nodeCut, nodes.length - nodeCut);
              else { nd.s = nd.s.slice(0, nodeTextCut); nodes.length = nodeCut + 1; }
            } else {
              nodes.length = nodeCut;
            }
          }
          flush();
          nodes.push({ t: 'link', href: em.href, title: null, text: em.text, autolink: true });
          i += em.next - local.length;
          continue;
        }
      }
      textBuf += '@'; i++; continue;
    }
    if ((c === 119 || c === 104 || c === 102 || c === 87 || c === 72 || c === 70) && !inLink && !_docInLink) { // w/h/f/W/H/F
      const au = parseExtAutolink(s, i, end);
      if (au) {
        // www. needs the preceding-char rule.
        if (s.startsWith('www.', i)) {
          const p = i - 1;
          const ok = p < start || (() => {
            const pc = s.charCodeAt(p);
            return isWs(pc) || pc === STAR || pc === USCORE || pc === TILDE || pc === LPAREN;
          })();
          if (!ok) { textBuf += s[i]; i++; continue; }
        }
        flush();
        nodes.push({ t: 'link', href: au.href, title: null, text: au.text, autolink: true });
        i = au.next;
        continue;
      }
      textBuf += s[i]; i++; continue;
    }
    if ((c === 109 || c === 120) && !inLink && !_docInLink) { // m / x : mailto: / xmpp:
      const au = parseExtAutolink(s, i, end, hasOpenUnderscore(nodes));
      if (au) {
        flush();
        nodes.push({ t: 'link', href: au.href, title: null, text: au.text, autolink: true });
        i = au.next;
        continue;
      }
      textBuf += s[i]; i++; continue;
    }
    textBuf += s[i];
    i++;
  }
  flush();
  return nodes;
}

// Render inline markdown to HTML.
function inline(s, defs) {
  if (!s) return '';
  const nodes = scanInline(s, 0, s.length, defs);
  processEmphasis(nodes);
  const out = [];
  renderNodes(nodes, out);
  return out.join('');
}

// ---- block parsing ------------------------------------------------------
// Line-based block parser mirroring marked 18.1.3 (GFM, default options).
// Block node shapes:
//  para {s} · text {s} (list-item text run, rendered without <p>) ·
//  heading {depth,s} · hr · code {lang,s} · html {s} ·
//  blockquote {children} · list {ordered,start,loose,items} ·
//  table {header:[{s,align}], rows:[[{s,align}]]}
// A para/text node may carry `pre` (raw HTML prepended inside it, used for
// loose-list task checkboxes).

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const PRE_TAGS = new Set(['script', 'pre', 'style', 'textarea']);

// Split a table row/header into cells (marked's de()): split on unescaped
// '|', drop a leading/trailing empty cell, pad/truncate to `count`.
function splitCells(s, count) {
  const parts = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === BSLASH && i + 1 < s.length && s.charCodeAt(i + 1) === PIPE) { cur += '|'; i += 2; continue; }
    if (c === PIPE) { parts.push(cur); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  parts.push(cur);
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.length = count;
    while (parts.length < count) parts.push('');
  }
  for (let k = 0; k < parts.length; k++) parts[k] = parts[k].trim();
  return parts;
}

const _delimRe = /^ {0,3}\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
function delimCells(line) {
  if (!_delimRe.test(line)) return null;
  if (line.indexOf(':') < 0 && line.indexOf('|') < 0) return null;
  const cells = line.replace(/^\||\| *$/g, '').split('|');
  return cells;
}
function alignOf(cell) {
  if (/^ *-+: *$/.test(cell)) return 'right';
  if (/^ *:-+: *$/.test(cell)) return 'center';
  if (/^ *:-+ *$/.test(cell)) return 'left';
  return null;
}
// Does lines[i] (header) + lines[i+1] (delimiter) form a table?
function tableAt(lines, i) {
  if (i + 1 >= lines.length) return null;
  const header = lines[i];
  if (!header || header.charCodeAt(0) === SP && header.trim() === '') return null;
  const dc = delimCells(lines[i + 1]);
  if (!dc) return null;
  const hc = splitCells(header);
  if (hc.length !== dc.length) return null;
  return { header: hc, aligns: dc.map(alignOf) };
}

const _atxRe = /^ {0,3}(#{1,6})(?=$|[ \t])/;
function atxHeading(line) {
  const m = _atxRe.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  if (text.endsWith('#')) {
    let s = text;
    while (s.endsWith('#')) s = s.slice(0, -1);
    if (s === '' || /[ \t]$/.test(s)) text = s.trim();
  }
  return { depth: m[1].length, text };
}
const _hrRe = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
function isHr(line) { return _hrRe.test(line); }
const _fenceRe = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
function fenceStart(line) {
  const m = _fenceRe.exec(line);
  if (!m) return null;
  const run = m[1];
  if (run.charCodeAt(0) === BTICK && m[2].indexOf('`') >= 0) return null;
  return { ch: run.charAt(0), len: run.length, info: m[2] };
}
const _setextRe = /^ {0,3}(=+|-+)[ \t]*$/;
function setextDepth(line) {
  const m = _setextRe.exec(line);
  return m ? (m[1].charCodeAt(0) === EQ ? 1 : 2) : 0;
}
const _listRe = /^ {0,3}([*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
function listMarker(line) {
  const m = _listRe.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = marker.length > 1;
  let indent = 0;
  while (indent < line.length && line.charCodeAt(indent) === SP) indent++;
  return { marker, ordered, delim: ordered ? marker.charAt(marker.length - 1) : marker, start: ordered ? parseInt(marker.slice(0, -1), 10) : 0, indent };
}
const _bqRe = /^ {0,3}>/;
function isBlockquoteStart(line) { return _bqRe.test(line); }

// HTML block start classification (marked's Ue, types 1/6/7).
// Returns {type:'script'|'comment'|'pi'|'decl'|'cdata'|'type6'|'type7', tag}
// or null.
function htmlBlockStart(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === SP && i < 3) i++;
  if (i >= line.length || line.charCodeAt(i) !== LT) return null;
  const rest = line.slice(i);
  let m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m) return { type: 'script', tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 'comment' };
  if (rest.startsWith('<?')) return { type: 'pi' };
  if (/^<!\[CDATA\[/.test(rest)) return { type: 'cdata' };
  if (/^<![A-Z]/.test(rest)) return { type: 'decl' };
  // Type 6: open/close tag of a block-level tag.
  m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m) {
    const name = m[1].toLowerCase();
    const after = rest.charAt(m[0].length);
    if (BLOCK_TAGS.has(name) && (after === '' || after === ' ' || after === '\t' || after === '>' || after === '/')) {
      return { type: 'type6', tag: name };
    }
    // Type 7: a complete tag alone on the line. An open tag may carry
    // attributes; a closing tag may not (</a href="foo"> is not a tag).
    if (!PRE_TAGS.has(name)) {
      const isClose = rest.startsWith('</');
      const tagRe = isClose
        ? /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/
        : /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*"[^"\n]*"|\s*=\s*'[^'\n]*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>[ \t]*$/;
      if (tagRe.test(rest)) return { type: 'type7', tag: name };
    }
  }
  return null;
}

// Expand the leading spaces/tabs of a string to spaces, starting at the
// given column (marked's J(): a tab advances to the next multiple of 4).
function expandLeadingWs(s, startCol) {
  let col = startCol, i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === SP) { col++; i++; }
    else if (c === TAB) { col += 4 - (col & 3); i++; }
    else break;
  }
  if (i === 0) return s;
  return ' '.repeat(col - startCol) + s.slice(i);
}

// Does this line start an html block that interrupts a paragraph (or a
// list item / table row)? Marked's html pattern in those lookaheads covers
// block tags, script/pre/style/textarea, comments, PIs, declarations and
// CDATA, but NOT a type-7 inline tag alone on the line.
function htmlParaInterrupt(line) {
  const hb = htmlBlockStart(line);
  return hb !== null && hb.type !== 'type7';
}

// Is this line a block start (used where indented code does start a
// block, e.g. table body rows)?
function isBlockStart(line) {
  const [col] = leadCols(line);
  if (col >= 4) return true;
  return isParaInterrupt(line);
}

// Does this line start a list that can interrupt a paragraph (marked's
// paragraph pattern list alternative, We)? An unordered bullet or '1.' /
// '1)' followed by whitespace and a non-space character. An empty item
// ('*' alone, '1.' alone) and a later ordered number ('14.') do not.
function listInterruptsPara(line) {
  return /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line);
}

// Does this line interrupt a paragraph (start a new block)? Indented code
// does NOT interrupt a paragraph, so it is excluded here (unlike
// isBlockStart, which is used where indented code does start a block).
function isParaInterrupt(line) {
  if (atxHeading(line) || isHr(line) || fenceStart(line)) return true;
  if (isBlockquoteStart(line) || listInterruptsPara(line)) return true;
  if (htmlParaInterrupt(line)) return true;
  return false;
}

// Strip trailing blank lines the way marked's ge() does: if the text ends
// with a blank line (2+ trailing newlines), drop everything after the last
// non-blank line; otherwise keep it as-is.
function stripTrailingBlanks(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && isBlankLine(lines[t])) t--;
  if (lines.length - t <= 2) return text;
  return lines.slice(0, t + 1).join('\n');
}

// Collect an indented code block starting at line i (col >= 4).
// Returns {node, next}.
function parseIndentedCode(lines, i, end) {
  const out = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) { out.push(stripCols(line, 4)); j++; continue; }
    const [col] = leadCols(line);
    if (col < 4) break;
    out.push(stripCols(line, 4));
    j++;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return { node: { t: 'code', lang: '', indented: true, s: out.join('\n') }, next: j };
}

// Collect a fenced code block starting at line i. Returns {node, next}.
function parseFences(lines, i, end, fence) {
  const content = [];
  let j = i + 1;
  const closeRe = new RegExp(`^ {0,3}\\${fence.ch}{${fence.len},}[ \\t]*$`);
  while (j < end) {
    if (closeRe.test(lines[j])) { j++; break; }
    content.push(lines[j]);
    j++;
  }
  // Marked's Dt(): only a BACKTICK fence strips its indent from content
  // lines (tilde fences keep content verbatim). The strip amount is the
  // opening fence line's leading-whitespace length in characters, and
  // each content line loses up to that many leading whitespace chars.
  if (fence.ch === '`') {
    const indent = lines[i].length - lines[i].trimStart().length;
    for (let k = 0; k < content.length; k++) {
      const line = content[k];
      let p = 0;
      while (p < line.length && p < indent && (line.charCodeAt(p) === SP || line.charCodeAt(p) === TAB || line.charCodeAt(p) === CR)) p++;
      if (p > 0) content[k] = line.slice(p);
    }
  }
  const lang = fence.info.trim().replace(/\\([\p{P}\p{S}])/gu, '$1');
  return { node: { t: 'code', lang, s: content.join('\n') }, next: j };
}

// Collect an HTML block starting at line i. Returns {node, next}.
function parseHtmlBlock(lines, i, end, start, endsNL) {
  const out = [lines[i]];
  let j = i + 1;
  if (start.type === 'script') {
    const closeRe = new RegExp(`</${start.tag}>`, 'i');
    if (closeRe.test(lines[i])) {
      j = i + 1;
    } else {
      while (j < end) {
        out.push(lines[j]);
        if (closeRe.test(lines[j])) { j++; break; }
        j++;
      }
    }
  } else if (start.type === 'comment' || start.type === 'pi' || start.type === 'decl' || start.type === 'cdata') {
    const endMark = start.type === 'comment' ? '-->' : start.type === 'pi' ? '?>' : start.type === 'decl' ? '>' : ']]>';
    let done = lines[i].indexOf(endMark, start.type === 'comment' ? 4 : 2) >= 0;
    while (!done && j < end) {
      out.push(lines[j]);
      if (lines[j].indexOf(endMark) >= 0) done = true;
      j++;
    }
  } else {
    // Types 6/7: swallow lines until a blank line.
    while (j < end && !isBlankLine(lines[j])) { out.push(lines[j]); j++; }
  }
  // Trailing newline rule (marked's ge() on the raw match): the raw text
  // has one newline after the last line plus one per blank line that
  // follows; ge() keeps the text unchanged iff there is at most one
  // trailing newline, else it strips them all. So the text keeps exactly
  // one trailing '\n' iff the trailing-newline count is exactly 1.
  // Which following lines count as blank depends on the type: the
  // comment/script/pi/decl/cdata endings consume only consecutive '\n'
  // characters, so a spaces-only line stops the run (<!-- .. -->\n\t\n
  // keeps its '\n'); the type-6/7 ending consumes blank lines including
  // spaces-only ones.
  const lastIdx = j - 1;
  const hasNLAfter = lastIdx < lines.length - 1 || !!endsNL;
  let blankAfter = 0;
  const strictEmpty = start.type === 'script' || start.type === 'comment' ||
    start.type === 'pi' || start.type === 'decl' || start.type === 'cdata';
  for (let k = j; k < end; k++) {
    if (strictEmpty ? lines[k].length === 0 : isBlankLine(lines[k])) blankAfter++;
    else break;
  }
  const trailingNL = (hasNLAfter ? 1 : 0) + blankAfter;
  let text = out.join('\n');
  if (trailingNL === 1) text += '\n';
  return { node: { t: 'html', s: text }, next: j };
}

// Collect paragraph lines starting at i. Stops at a blank line, a block
// start, a setext underline, or a line that starts a table (with the next
// line as its delimiter). Returns {lines, next}.
// Collect a list-item text node's lines (top=false): consecutive plain
// lines, where an indented line is an indented code block merged into the
// text (dedented by 4, marked's blockTokens code-merge). A setext
// underline still ends the text (it becomes a heading in parseBlocks).
// Unlike a top-level paragraph, ANY list marker ends the text here:
// inside a list item the list tokenizer runs before the text tokenizer,
// so a nested list can start with any number, not just 1.
function collectText(lines, i, end) {
  const out = [lines[i]];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) break;
    if (atxHeading(line) || isHr(line) || fenceStart(line)) break;
    if (isBlockquoteStart(line) || listMarker(line)) break;
    if (htmlParaInterrupt(line)) break;
    if (setextDepth(line)) break;
    if (j + 1 < end && tableAt(lines, j)) break;
    const [col] = leadCols(line);
    out.push(col >= 4 ? stripCols(line, 4) : line);
    j++;
  }
  return { lines: out, next: j };
}

function collectParagraph(lines, i, end, lastNoNL) {
  const out = [lines[i]];
  let j = i + 1;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // A spaces-only line as the very last line, not followed by a
      // newline, is a paragraph continuation (marked's paragraph pattern
      // only excludes a blank line followed by '\n').
      if (lastNoNL && j === end - 1 && line.length > 0) { out.push(line); j++; }
      break;
    }
    if (isParaInterrupt(line)) break;
    // A setext underline ends the paragraph (the lheading tokenizer takes
    // precedence over the paragraph tokenizer); a following underline
    // converts the whole paragraph to a heading in parseBlocks.
    if (setextDepth(line)) break;
    if (j + 1 < end && tableAt(lines, j)) break;
    out.push(line);
    j++;
  }
  return { lines: out, next: j };
}

// Parenthesis balance for a link destination (marked's ke()): -1 means
// balanced (or no parens), otherwise the index of an unbalanced ')' or -2.
function parenBalance(s) {
  if (s.indexOf('(') < 0 && s.indexOf(')') < 0) return -1;
  let depth = 0;
  for (let n = 0; n < s.length; n++) {
    if (s.charCodeAt(n) === BSLASH) { n++; continue; }
    if (s.charCodeAt(n) === LPAREN) depth++;
    else if (s.charCodeAt(n) === RPAREN) { depth--; if (depth < 0) return n; }
  }
  return depth > 0 ? -2 : -1;
}

// Try to parse a link reference definition starting at lines[i] (0-3 spaces
// indent). Returns {label, href, title, next} or null. First definition
// wins (the caller stores it only if the label is new).
function tryParseDef(lines, i, end) {
  const win = [];
  let k = i;
  while (k < end && win.length < 12) { win.push(lines[k]); k++; }
  const s = win.join('\n');
  let p = 0;
  while (p < s.length && s.charCodeAt(p) === SP && p < 3) p++;
  if (p >= s.length || s.charCodeAt(p) !== LBRK) return null;
  let label = '', q = p + 1, closed = false;
  while (q < s.length) {
    const c = s.charCodeAt(q);
    if (c === BSLASH && q + 1 < s.length) { label += s[q] + s[q + 1]; q += 2; continue; }
    if (c === RBRK) { closed = true; break; }
    if (c === LBRK) return null;
    if (c === NL) {
      let r = q + 1;
      while (r < s.length && (s.charCodeAt(r) === SP || s.charCodeAt(r) === TAB)) r++;
      if (r >= s.length || s.charCodeAt(r) === NL) return null;
      label += '\n'; q++; continue;
    }
    label += s[q]; q++;
  }
  if (!closed || label.trim() === '') return null;
  q++;
  if (q >= s.length || s.charCodeAt(q) !== COLON) return null;
  q++;
  while (q < s.length && (s.charCodeAt(q) === SP || s.charCodeAt(q) === TAB)) q++;
  if (q < s.length && s.charCodeAt(q) === NL) {
    q++;
    while (q < s.length && (s.charCodeAt(q) === SP || s.charCodeAt(q) === TAB)) q++;
  }
  // Destination.
  let dest = '', angle = false;
  if (q < s.length && s.charCodeAt(q) === LT) {
    angle = true;
    q++;
    let found = false;
    while (q < s.length) {
      const c = s.charCodeAt(q);
      if (c === GT) { found = true; q++; break; }
      if (c === NL || c === LT) return null;
      dest += s[q]; q++;
    }
    if (!found) return null;
  } else {
    if (q >= s.length) return null;
    const c0 = s.charCodeAt(q);
    if (c0 === SP || c0 === TAB || c0 === NL || c0 < 32) return null;
    while (q < s.length) {
      const c = s.charCodeAt(q);
      if (c === SP || c === TAB || c === NL || c < 32) break;
      dest += s[q]; q++;
    }
    if (dest === '') return null;
  }
  if (!angle && parenBalance(dest) !== -1) return null;
  dest = unescapePunct(dest);
  // Optional title: it must be preceded by at least one space/tab or by a
  // newline (+ spaces). If the title or the trailing check fails, marked's
  // def regex backtracks and retries without the title.
  const afterDest = q;
  let title = null;
  let titleEnd = afterDest;
  {
    let r = q, spaces = 0, sawNL = false;
    while (r < s.length && (s.charCodeAt(r) === SP || s.charCodeAt(r) === TAB)) { r++; spaces++; }
    if (r < s.length && s.charCodeAt(r) === NL) {
      sawNL = true;
      r++;
      while (r < s.length && (s.charCodeAt(r) === SP || s.charCodeAt(r) === TAB)) r++;
    }
    if ((spaces > 0 || sawNL) && r < s.length &&
        (s.charCodeAt(r) === QUOT || s.charCodeAt(r) === APOS || s.charCodeAt(r) === LPAREN)) {
      const tq = s.charCodeAt(r);
      const close = tq === LPAREN ? RPAREN : tq;
      let t = '', u = r + 1, ok = false;
      while (u < s.length) {
        const c = s.charCodeAt(u);
        if (c === BSLASH && u + 1 < s.length) { t += s[u] + s[u + 1]; u += 2; continue; }
        if (c === close) { ok = true; u++; break; }
        if (c === NL) {
          if (tq === APOS) {
            let w = u + 1;
            while (w < s.length && (s.charCodeAt(w) === SP || s.charCodeAt(w) === TAB)) w++;
            if (w >= s.length || s.charCodeAt(w) === NL) { ok = false; break; }
          }
          t += '\n'; u++; continue;
        }
        if (tq === LPAREN && c === LPAREN) { ok = false; break; }
        t += s[u]; u++;
      }
      if (ok) {
        // The trailing check after the title: only spaces, then a newline
        // or end of input.
        let v = u;
        while (v < s.length && (s.charCodeAt(v) === SP || s.charCodeAt(v) === TAB)) v++;
        if (v >= s.length || s.charCodeAt(v) === NL) {
          title = unescapePunct(t);
          titleEnd = u;
        }
      }
    }
  }
  // If no title was accepted, retry without one: only spaces, then a
  // newline or end of input, after the destination.
  let q2 = title !== null ? titleEnd : afterDest;
  while (q2 < s.length && (s.charCodeAt(q2) === SP || s.charCodeAt(q2) === TAB)) q2++;
  if (q2 < s.length && s.charCodeAt(q2) !== NL) return null;
  const consumed = s.slice(0, q2);
  let nl = 0;
  for (let n = 0; n < consumed.length; n++) if (consumed.charCodeAt(n) === NL) nl++;
  return { label: normalizeLabel(label), href: dest, title, next: i + nl + 1 };
}

// Is the stripped inner line of a blockquote a paragraph continuation line?
function innerIsParaLine(stripped, nextStripped) {
  if (isBlankLine(stripped)) return false;
  if (isParaInterrupt(stripped)) return false;
  if (setextDepth(stripped)) return false;
  if (nextStripped !== undefined && nextStripped !== null) {
    // A table header line is not a paragraph line.
    if (delimCells(nextStripped) && splitCells(stripped).length === delimCells(nextStripped).length) return false;
  }
  return true;
}

// Strip one blockquote marker from a line, the way marked does: the
// whitespace after '>' is expanded to spaces relative to the marker's
// column, then '>' plus one space is removed.
function stripBlockquoteMarker(line) {
  const m = /^( {0,3}>)([ \t]*)/.exec(line);
  if (!m) return null;
  const markerCol = m[1].length;
  let col = markerCol, expanded = '';
  for (let k = 0; k < m[2].length; k++) {
    if (m[2].charCodeAt(k) === TAB) { const n = 4 - (col & 3); expanded += ' '.repeat(n); col += n; }
    else { expanded += ' '; col++; }
  }
  const rest = line.slice(m[0].length);
  return (expanded.length > 0 ? expanded.slice(1) : '') + rest;
}

// Does the (stripped) inner content of a blockquote end with an open
// paragraph, so a lazy line belongs to the chunk (marked's Xe match)? A
// list line counts: the paragraph pattern matches it as a paragraph start
// and the lazy line is pulled into the list by the re-parse. A nested
// blockquote recurses.
function lineEndsPara(s) {
  if (isBlankLine(s)) return false;
  if (isBlockquoteStart(s)) {
    const inner = stripBlockquoteMarker(s);
    return inner !== null ? lineEndsPara(inner) : false;
  }
  if (listMarker(s)) return true;
  if (isParaInterrupt(s)) return false;
  return true;
}

// Parse a blockquote starting at lines[i]. Returns {node, next}.
// Follows marked's group loop: the chunk is collected first (a lazy line
// belongs only while the inner content ends with an open paragraph), then
// groups are parsed (leading lazy lines plus '>' lines); after a group
// whose last block is a nested blockquote or a list, the remaining chunk
// lines are pulled into it by re-parsing it with those lines appended.
function parseBlockquote(lines, i, end, defs) {
  // Collect the chunk: original source lines with a flag per line.
  const chunk = []; // {text, marker}
  let j = i;
  let endsPara = false;
  while (j < end) {
    const line = lines[j];
    const stripped = stripBlockquoteMarker(line);
    if (stripped !== null) {
      chunk.push({ text: stripped, marker: true });
      endsPara = lineEndsPara(stripped);
      j++;
      continue;
    }
    if (isBlankLine(line)) break;
    if (!endsPara) break;
    // A lazy line is paragraph text only: a line starting any block
    // (a list marker of any number, a heading, a fence, an hr, an html
    // block) ends the blockquote chunk in marked's Xe match, even
    // though an ordered list starting with 4 cannot interrupt a
    // paragraph at top level.
    if (isParaInterrupt(line) || listMarker(line)) break;
    chunk.push({ text: line, marker: false });
    endsPara = true;
    j++;
  }
  const chunkEnd = j;
  const children = [];
  let pos = 0; // position in the chunk
  while (pos < chunk.length) {
    // Build one group: leading lazy lines + '>' lines.
    const groupInner = [];
    let sawMarker = false;
    let prevLazy = false;
    let k = pos;
    while (k < chunk.length) {
      const c = chunk[k];
      if (c.marker) {
        groupInner.push(c.text);
        sawMarker = true;
        prevLazy = false;
        k++;
      } else if (!sawMarker) {
        let t = c.text;
        if (prevLazy && /^ {0,3}(?:=+|-+)[ \t]*$/.test(t)) t = '    ' + t.replace(/^ {0,3}/, '');
        groupInner.push(t);
        prevLazy = true;
        k++;
      } else {
        break;
      }
    }
    if (groupInner.length === 0) break;
    const gc = parseBlocks(groupInner, 0, groupInner.length, defs, true);
    if (children.length > 0 && gc.length > 0) {
      const prev = children[children.length - 1];
      const first = gc[0];
      if (prev.t === 'para' && first.t === 'para') {
        prev.s += '\n' + first.s;
        if (first.pre) prev.pre = (prev.pre || '') + first.pre;
        gc.shift();
      } else if (prev.t === 'para' && first.t === 'code' && first.indented) {
        // Marked's blockTokens merges an indented code token into a
        // preceding paragraph/text token (appended with a newline).
        prev.s += '\n' + first.s;
        gc.shift();
      }
    }
    children.push(...gc);
    pos = k;
    const last = children.length > 0 ? children[children.length - 1] : null;
    if (!last) break;
    if (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table') break;
    if (last.t === 'blockquote' || last.t === 'list') {
      // Re-parse the nested block/list with the remaining chunk lines
      // appended (their markers stripped), pulling lazy lines inside it.
      if (pos >= chunk.length) break;
      const startIdx = gc.starts[gc.length - 1];
      const srcLines = groupInner.slice(startIdx);
      const restLines = [];
      for (let q = pos; q < chunk.length; q++) restLines.push(chunk[q].text);
      const combined = srcLines.concat(restLines);
      let rep;
      if (last.t === 'blockquote') {
        rep = parseBlockquote(combined, 0, combined.length, defs);
      } else {
        rep = parseList(combined, 0, combined.length, defs);
      }
      children[children.length - 1] = rep.node;
      const consumedRest = Math.max(0, Math.min(restLines.length, rep.next - srcLines.length));
      pos += consumedRest;
      // Continue only if more chunk lines remain and the next one is a
      // '>' line (marked's group loop continues on a blockquote start).
      if (pos >= chunk.length || !chunk[pos].marker) break;
      continue;
    }
    // Last token is a paragraph: continue with the next group.
    if (pos >= chunk.length) break;
  }
  // Only the chunk lines consumed by the groups belong to the blockquote;
  // the rest (e.g. a lazy line after a group that ended in a code block)
  // are left for the outer parser.
  return { node: { t: 'blockquote', children }, next: i + pos };
}

// First non-space/tab column of a line (tabs advance to multiples of 4).
function firstNonSpaceCol(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === SP) { col++; i++; }
    else if (c === TAB) { col += 4 - (col & 3); i++; }
    else break;
  }
  return col;
}
// Does line start a block within R columns of its start (list continuation
// test, marked's nextBulletRegex/hrRegex/fencesBeginRegex/headingBeginRegex/
// htmlBeginRegex/blockquoteBeginRegex at indent R)? Those regexes are built
// through D(), which clamps the indent to max(0, min(3, R-1)). The regexes
// allow only spaces in the indent, so a tab there means no match.
// Marked's fencesBeginRegex (used only for list-item continuation): a line
// starting with ``` or ~~~ (after up to R spaces) ends the item even when
// the "info" contains backticks, i.e. even when it is not a real fence at
// the top level (```inner backticks``` is a paragraph there, but it still
// ends a list item). This is intentionally looser than fenceStart.
function fenceBeginLoose(line) {
  return line.startsWith('```') || line.startsWith('~~~');
}

function isBlockStartAt(line, R) {
  const n = Math.max(0, Math.min(3, R - 1));
  let sp = 0;
  while (sp < line.length && line.charCodeAt(sp) === SP) sp++;
  if (sp > n) return false;
  if (sp < line.length && line.charCodeAt(sp) === TAB) return false;
  const rest = line.slice(sp);
  return !!(atxHeading(rest) || isHr(rest) || fenceBeginLoose(rest) ||
    isBlockquoteStart(rest) || listMarker(rest) || htmlParaInterrupt(rest));
}

// Parse one list item starting at lines[i] with the given marker.
// Returns {lines, next, endedBlank}.
function parseListItem(lines, i, end, marker) {
  const line = lines[i];
  const indent = marker.indent;
  const b = indent + marker.marker.length;
  const contentStart = indent + marker.marker.length;
  const g = line.slice(contentStart);
  // The content's leading whitespace, expanded relative to the marker end.
  const m0 = expandLeadingWs(g, b);
  const ws = m0.search(/[^ ]/);
  const contentBlank = ws < 0;
  let R, d;
  if (contentBlank) { R = b + 1; d = ''; }
  else if (ws > 4) { R = b + 1; d = m0.slice(1); }
  else { R = b + ws; d = m0.slice(ws); }
  const itemLines = [d];
  let j = i + 1;
  // Empty item: blank content followed by a blank line is skipped.
  if (contentBlank && j < end && isBlankLine(lines[j])) {
    itemLines.push('');
    return { lines: itemLines, next: j + 1, endedBlank: true };
  }
  let y = contentBlank;
  let m = d;
  while (j < end) {
    const f = lines[j];
    if (isBlockStartAt(f, R)) break;
    // Continuation lines have their leading whitespace expanded relative
    // to column 0, then are dedented by R (marked's Z.slice(R)).
    const Z = expandLeadingWs(f, 0);
    const firstCol = Z.search(/[^ ]/);
    if (firstCol >= R || firstCol < 0) {
      itemLines.push(Z.slice(R));
    } else {
      // Lazy continuation line.
      if (y || firstNonSpaceCol(m) >= 4 ||
          atxHeading(m) || isHr(m) || fenceBeginLoose(m) || htmlBlockStart(m)) break;
      if (/^ {0,3}(=+|-+) *$/.test(f) && setextDepth(f) && m.trim() !== '' && !isParaInterrupt(m)) {
        itemLines.push('    ' + f.replace(/^ {0,3}/, ''));
      } else {
        itemLines.push(f);
      }
    }
    y = isBlankLine(f);
    m = Z.slice(R);
    j++;
  }
  // Trailing blank lines are not part of the item (marked trims the last
  // item's raw and text): the next pointer rewinds to the first of them
  // so the parent level sees the blank line (a space token there can
  // make the parent list loose). endedBlank records that the item did
  // end with a blank line (marked's doubleBlankLine flag, which makes
  // the list loose when another item follows).
  let trail = 0;
  while (itemLines.length > 1 && isBlankLine(itemLines[itemLines.length - 1])) {
    itemLines.pop();
    trail++;
  }
  const endedBlank = trail > 0;
  return { lines: itemLines, next: j - trail, endedBlank };
}

// Parse a list starting at lines[i]. Returns {node, next}.
function parseList(lines, i, end, defs) {
  const first = listMarker(lines[i]);
  const ordered = first.ordered;
  const delim = first.delim;
  const items = [];
  let j = i;
  let loose = false;
  let prevEndedBlank = false;
  while (j < end) {
    // A blank line between items does not end the list: skip blank lines
    // when looking for the next item marker (marked consumes the blank
    // line into the preceding item's text, then finds the next marker).
    let k = j;
    while (k < end && isBlankLine(lines[k])) k++;
    if (k >= end) break;
    const line = lines[k];
    const m = listMarker(line);
    if (!m || m.ordered !== ordered) break;
    if (ordered && m.delim !== delim) break;
    if (!ordered && m.marker !== first.marker) break;
    if (isHr(line)) break;
    const it = parseListItem(lines, k, end, m);
    // Task marker on the first content line.
    let task = false, checked = false;
    if (/^\[[ xX]\][ \t]+\S/.test(it.lines[0])) {
      task = true;
      checked = it.lines[0].charAt(1) !== ' ';
      it.lines[0] = it.lines[0].replace(/^\[[ xX]\][ \t]+/, '');
    }
    // Loose iff a blank line separates two blocks inside an item
    // (marked's space token with two newlines, from the parsed children:
    // blank lines inside a fenced code block or a nested list do NOT
    // count), or the previous item ended with a blank continuation line
    // (a blank line between the items, marked's doubleBlankLine flag).
    // A blank first content line (an empty item) counts for neither.
    const children = parseBlocks(it.lines, 0, it.lines.length, defs, false);
    const blankMid = children.hasSpace;
    if (prevEndedBlank || blankMid) loose = true;
    prevEndedBlank = it.endedBlank;
    items.push({ task, checked, children });
    j = it.next;
  }
  const cbHtml = (checked) => '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  for (const item of items) {
    if (!item.task) continue;
    if (!loose) {
      item.children.unshift({ t: 'checkbox', checked: item.checked });
    } else if (item.children.length && (item.children[0].t === 'text' || item.children[0].t === 'para')) {
      item.children[0].pre = cbHtml(item.checked);
    } else {
      item.children.unshift({ t: 'para', s: '', pre: cbHtml(item.checked) });
    }
  }
  if (loose) {
    for (const item of items) {
      for (const child of item.children) {
        if (child.t === 'text') child.t = 'para';
      }
    }
  }
  return { node: { t: 'list', ordered, start: first.start, loose, items }, next: j };
}

// Main block parser over lines[start..end). `top` selects paragraph nodes
// (true: top level / blockquote) vs text nodes (false: list items).
// defs is a Map shared across the whole document (definitions are global).
function parseBlocks(lines, start, end, defs, top, endsNL) {
  const out = [];
  const starts = [];
  // Record the line index each node starts at (used by the blockquote
  // group loop to re-parse a nested blockquote/list with more lines).
  const push = (node) => { starts.push(i); out.push(node); };
  // A blank line between two nodes is a space token at this level (it
  // makes a list loose); blank lines at the end are the item's trailing
  // blank line. Blank lines inside a block are consumed by that block
  // and never reach here.
  let hasSpace = false;
  let sawBlank = false;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      if (out.length > 0) sawBlank = true;
      i++;
      continue;
    }
    if (sawBlank && out.length > 0) hasSpace = true;
    sawBlank = false;
    const [col] = leadCols(line);
    if (col >= 4) {
      const r = parseIndentedCode(lines, i, end);
      push(r.node); i = r.next; continue;
    }
    const atx = atxHeading(line);
    if (atx) { push({ t: 'heading', depth: atx.depth, s: atx.text }); i++; continue; }
    if (isHr(line)) { push({ t: 'hr' }); i++; continue; }
    const fence = fenceStart(line);
    if (fence) {
      const r = parseFences(lines, i, end, fence);
      push(r.node); i = r.next; continue;
    }
    const hb = htmlBlockStart(line);
    if (hb) {
      const r = parseHtmlBlock(lines, i, end, hb, !!endsNL);
      push(r.node); i = r.next; continue;
    }
    if (isBlockquoteStart(line)) {
      const r = parseBlockquote(lines, i, end, defs);
      push(r.node); i = r.next; continue;
    }
    if (listMarker(line)) {
      const r = parseList(lines, i, end, defs);
      push(r.node); i = r.next; continue;
    }
    const def = tryParseDef(lines, i, end);
    if (def) {
      if (!defs.has(def.label)) defs.set(def.label, { href: def.href, title: def.title });
      i = def.next; continue;
    }
    const tbl = tableAt(lines, i);
    if (tbl) {
      const rows = [];
      let j = i + 2;
      while (j < end) {
        const row = lines[j];
        // A row line ends the table if it is a blank line of spaces
        // only, or an indented code line (4+ leading columns plus a
        // non-newline char). A whitespace-only line that is NOT
        // indented code (a lone tab, or space+tab) is a row of empty
        // cells, because marked's table body regex excludes only
        // ` *\n` and indented code from the body.
        if (isTableRowEnd(row) || (!isBlankLine(row) && isBlockStart(row))) break;
        rows.push(splitCells(row, tbl.header.length).map((s, k) => ({ s, align: tbl.aligns[k] })));
        j++;
      }
      push({
        t: 'table',
        header: tbl.header.map((s, k) => ({ s, align: tbl.aligns[k] })),
        rows,
      });
      i = j; continue;
    }
    // Paragraph (or setext heading) at top level; a single text node
    // inside a list item.
    const para = top ? collectParagraph(lines, i, end, !endsNL) : collectText(lines, i, end);
    const nextLine = para.next < end ? lines[para.next] : null;
    const depth = nextLine !== null ? setextDepth(nextLine) : 0;
    if (depth) {
      push({ t: 'heading', depth, s: para.lines.join('\n').trim() });
      i = para.next + 1;
      continue;
    }
    push({ t: top ? 'para' : 'text', s: para.lines.join('\n') });
    i = para.next;
  }
  out.starts = starts;
  out.hasSpace = hasSpace;
  out.endsBlank = sawBlank;
  return out;
}

// ---- rendering ----------------------------------------------------------
function renderBlocks(nodes, out) {
  for (const n of nodes) {
    switch (n.t) {
      case 'para': out.push('<p>' + (n.pre || '') + inline(n.s, renderBlocks._defs) + '</p>\n'); break;
      case 'text': out.push((n.pre || '') + inline(n.s, renderBlocks._defs)); break;
      case 'heading': out.push('<h' + n.depth + '>' + inline(n.s, renderBlocks._defs) + '</h' + n.depth + '>\n'); break;
      case 'hr': out.push('<hr>\n'); break;
      case 'code': {
        const lang = n.lang ? n.lang.match(/^\S*/)[0] : '';
        const body = n.s ? escapeHtml(n.s.replace(/\n$/, '') + '\n', true) : '';
        out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang, false) + '"' : '') + '>' + body + '</code></pre>\n');
        break;
      }
      case 'html': out.push(n.s); break;
      case 'blockquote':
        out.push('<blockquote>\n');
        renderBlocks(n.children, out);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const startAttr = n.ordered && n.start !== 1 ? ' start="' + n.start + '"' : '';
        out.push('<' + tag + startAttr + '>\n');
        for (const item of n.items) {
          out.push('<li>');
          renderBlocks(item.children, out);
          out.push('</li>\n');
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'checkbox':
        out.push('<input ' + (n.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
        break;
      case 'table': {
        let h = '';
        for (const c of n.header) {
          h += '<th' + (c.align ? ' align="' + c.align + '"' : '') + '>' + inline(c.s, renderBlocks._defs) + '</th>\n';
        }
        let b = '';
        for (const row of n.rows) {
          let cells = '';
          for (const c of row) {
            cells += '<td' + (c.align ? ' align="' + c.align + '"' : '') + '>' + inline(c.s, renderBlocks._defs) + '</td>\n';
          }
          b += '<tr>\n' + cells + '</tr>\n';
        }
        out.push('<table>\n<thead>\n<tr>\n' + h + '</tr>\n</thead>\n' +
          (b ? '<tbody>' + b + '</tbody>' : '') + '</table>\n');
        break;
      }
    }
  }
}

export function parse(markdown) {
  _docInLink = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const endsNL = src.endsWith('\n');
  const lines = src.split('\n');
  // A trailing '\n' leaves a phantom empty element; drop it so the last
  // line is a real line (the html-block trailing-newline rule needs to
  // know whether the source ends with a newline, carried by endsNL).
  if (endsNL) lines.pop();
  const defs = new Map();
  const nodes = parseBlocks(lines, 0, lines.length, defs, true, endsNL);
  renderBlocks._defs = defs;
  const out = [];
  renderBlocks(nodes, out);
  return out.join('');
}
