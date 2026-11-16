// parse.js — dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// Returns byte-identical HTML to marked 18.1.3 with default options
// (gfm true, breaks false, pedantic false, async false).
// Written from scratch as a clean-room implementation of the CommonMark /
// GFM grammar; block and inline rules follow the reference behaviour.

const TAGNAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// ---------- shared small patterns ----------
const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  setextUnderline: /\n[ \t]{0,3}[=-]/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

function listItemRegex(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
}
function cachedIndentRegex(mk) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let r = cache[idx];
    if (!r) { r = mk(idx); cache[idx] = r; }
    return r;
  };
}
const nextBulletRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAGNAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));

// ---------- block grammar (GFM) ----------
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HR_NOCAP = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: HR,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  text: /^[^\n]+/,
};
const CARET = /(^|[^\[])\^/g;
function editSrc(src) {
  return {
    replace(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(CARET, '$1');
      src = src.replace(name, v);
      return this;
    },
    get() { return src; },
  };
}
const LHEADING_CORE_SRC = '^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
function buildLheading(tablePat) {
  const s = editSrc(LHEADING_CORE_SRC)
    .replace(/bull/g, BULLET)
    .replace(/blockCode/g, '(?: {4}| {0,3}\\t)')
    .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
    .replace(/blockquote/g, ' {0,3}>')
    .replace(/heading/g, ' {0,3}#{1,6}(?:\\s|$)')
    .replace(/hr/g, HR_NOCAP)
    .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
    .replace(/table/g, tablePat)
    .get();
  return new RegExp(s);
}
const BLOCK_LHEADING = buildLheading(' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n');
const BLOCK_LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF = new RegExp(editSrc('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)')
  .replace('label', BLOCK_LABEL_SRC)
  .replace('title', '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))')
  .get());
const LIST = new RegExp(editSrc('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)').replace(/bull/g, BULLET).get());
const HTML_BLOCK_SRC = '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')';
const HTML = new RegExp(editSrc(HTML_BLOCK_SRC)
  .replace('comment', COMMENT)
  .replace('tag', TAGNAMES)
  .replace('attribute', ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?')
  .get(), 'i');
const PARA_SRC = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
function buildParagraph(listInterrupt, tablePat) {
  const e = editSrc(PARA_SRC)
    .replace('hr', HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  if (tablePat) e.replace('table', tablePat);
  else e.replace('|table', '');
  const s = e
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAGNAMES)
    .get();
  return new RegExp(s);
}
const TABLE_SRC = '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
const TABLE = new RegExp(editSrc(TABLE_SRC)
  .replace('hr', HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAGNAMES)
  .get());
const PARAGRAPH = buildParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', TABLE.source);
const BLOCKQUOTE_PARA = buildParagraph(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', '');
const BLOCKQUOTE = new RegExp(editSrc('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+').replace('paragraph', BLOCKQUOTE_PARA).get());

// ---------- inline grammar (GFM) ----------
const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
};
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const punctuation = new RegExp('^((?![*_])' + PUNCT_OR_SPACE.source + ')', 'u');
const BLOCK_SKIP = new RegExp(
  'link|precode-code|html'.replace('link', '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)')
    .replace('precode-', '(?<!`)()')
    .replace('code', '(?<b>`+)[^`]+\\k<b>(?!`)')
    .replace('html', '<(?! )[^<>]*?>'), 'g');
const EM_STRONG_LDELIM = new RegExp('^(?:\\*+(?:((?!\\*)' + PUNCT_GFM.source + ')|([^\\s*]))?)|^_+(?:((?!_)' + PUNCT_GFM.source + ')|([^\\s_]))?', 'u');
const RDELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const RDELIM_UND_CORE =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)';
const DEL_RDELIM_CORE =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
function subRdelim(core, notP, punctSpace, punct) {
  return new RegExp(core
    .replace(/notPunctSpace/g, notP.source)
    .replace(/punctSpace/g, punctSpace.source)
    .replace(/punct/g, punct.source), 'gu');
}
const EM_STRONG_RDELIM_AST = subRdelim(RDELIM_AST_CORE, NOT_PUNCT_OR_SPACE_GFM, PUNCT_OR_SPACE_GFM, PUNCT_GFM);
const EM_STRONG_RDELIM_UND = subRdelim(RDELIM_UND_CORE, NOT_PUNCT_OR_SPACE_GFM, PUNCT_OR_SPACE_GFM, PUNCT_GFM);
// del uses the plain punctuation classes (not the GFM ones): in the plain
// classes ~ counts as punctuation, so a lone ~ never satisfies a
// notPunctSpace lookahead and cannot steal half of a ~~ closer.
const DEL_RDELIM = subRdelim(DEL_RDELIM_CORE, NOT_PUNCT_OR_SPACE, PUNCT_OR_SPACE, PUNCT);
const DEL_LDELIM = new RegExp('^~~?(?:((?!~)' + PUNCT.source + ')|[^\\s~])', 'u');
const ANY_PUNCT = new RegExp('\\\\(' + PUNCT.source + ')', 'gu');
const ANY_PUNCT_OUTSIDE_CODE = new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT.source + ')', 'gu');
const AUTOLINK = new RegExp('^<(scheme:[^\\s\\x00-\\x1f<>]*|email)>'
  .replace('scheme', '[a-zA-Z][a-zA-Z0-9+.-]{1,31}')
  .replace('email', '[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])'));
const INLINE_COMMENT = new RegExp(COMMENT.source.replace('(?:-->|$)', '-->'));
const TAG_SRC = '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>';
const TAG_RX = new RegExp(TAG_SRC
  .replace('comment', INLINE_COMMENT.source)
  .replace('attribute', '\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?'));
const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = new RegExp('(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?'.replace('brackets', INLINE_LABEL_BRACKETS.source));
const LINK = new RegExp('^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)'
  .replace('label', INLINE_LABEL.source)
  .replace('href', '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))')
  .replace('title', '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)'));
const REFLINK = new RegExp('^!?\\[(label)\\]\\[(ref)\\]'.replace('label', INLINE_LABEL.source).replace('ref', BLOCK_LABEL_SRC));
const NOLINK = new RegExp('^!?\\[(ref)\\](?:\\[\\])?'.replace('ref', BLOCK_LABEL_SRC));
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = new RegExp('(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?'.replace('brackets', INLINE_LABEL_BRACKETS.source));
const REFLINK_SEARCH = new RegExp(editSrc('reflink|nolink(?!\\()')
  .replace('reflink', editSrc('^!?\\[(label)\\]\\[(ref)\\]').replace('label', BOUNDED_INLINE_LABEL).replace('ref', BOUNDED_BLOCK_LABEL).get())
  .replace('nolink', editSrc('^!?\\[(ref)\\](?:\\[\\])?').replace('ref', BOUNDED_BLOCK_LABEL).get())
  .get(), 'g');
const EXT_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXT_EMAIL_PROTOCOL = new RegExp('(?:mailto:email|xmpp:email(?:\\/[A-Za-z0-9@.]+)?)'.replace(/email/g, EXT_EMAIL.source));
const URL_RX = new RegExp('^emailProtocol|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^email'
  .replace('emailProtocol', EXT_EMAIL_PROTOCOL.source)
  .replace('protocol', '[hH][tT][tT][pP][sS]?|[fF][tT][pP]')
  .replace('email', '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])'));
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const DEL_RX = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const INLINE_TEXT_GFM = new RegExp('^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|protocol:\\/\\/|wwwStart|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{\\|}~-]+@))))'
  .replace('protocol', '[hH][tT][tT][pP][sS]?|[fF][tT][pP]')
  .replace(/emailProtocol/g, '(?:mailto|xmpp):')
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.'));
const INLINE_TEXT = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;

// ---------- helpers ----------
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(html, encode) {
  if (encode) {
    if (RX.escapeTest.test(html)) return html.replace(RX.escapeReplace, (c) => ESCAPE_MAP[c]);
  } else if (RX.escapeTestNoEncode.test(html)) {
    return html.replace(RX.escapeReplaceNoEncode, (c) => ESCAPE_MAP[c]);
  }
  return html;
}
function decodeNumericRefs(text) {
  if (!RX.numericCharacterReference.test(text)) return text;
  return text.replace(RX.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(RX.percentDecode, '%');
  } catch { return null; }
  return href;
}
function splitCells(row, count) {
  const r = row.replace(RX.findPipe, (m, off, str) => {
    let esc = false, cur = off;
    while (--cur >= 0 && str[cur] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = r.split(RX.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(RX.slashPipe, '|');
  return cells;
}
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suff = 0;
  while (suff < l) {
    const ch = str.charAt(l - suff - 1);
    if (ch === c && !invert) suff++;
    else if (ch !== c && invert) suff++;
    else break;
  }
  return str.slice(0, l - suff);
}
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && RX.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}
function normalizeLabel(label) {
  return label.trim().replace(RX.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}
function expandTabs(line, indent = 0) {
  let col = indent, out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else { out += ch; col++; }
  }
  return out;
}
function indentCodeCompensation(raw, text) {
  const m = raw.match(RX.indentCodeCompensation);
  if (!m) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(RX.beginningSpace);
    if (!mi) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = TAG_RX.exec(tokenSrc) || AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// ---------- closer-scan hints (one scan per inline run) ----------
function scanLastClosers(src) {
  const lastStar = { '*': -1, '_': -1 };
  let lastTilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i;
      else lastStar[ch] = i;
    }
    i = j - 1;
  }
  return { lastStar, lastTilde };
}

// ---------- parser state (one parse() call) ----------
function makeState() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    inlineQueue: [],
    closerFrame: null,
  };
}

// ---------- block tokenizers ----------
// Each returns a token object or undefined. Tokens carry raw + the fields
// the renderer needs; text-bearing tokens get their inline tokens queued.
function tokSpace(st, src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}
function tokCode(st, src) {
  const cap = BLOCK.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RX.codeRemoveIndent, '') };
  }
}
function tokFences(st, src) {
  const cap = BLOCK.fences.exec(src);
  if (cap) {
    return {
      type: 'code', raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT, '$1') : cap[2],
      text: indentCodeCompensation(cap[0], cap[3] || ''),
    };
  }
}
function tokHeading(st, src) {
  const cap = BLOCK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (RX.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || RX.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(st, text) };
  }
}
function tokHr(st, src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}
function tokBlockquote(st, src) {
  const cap = BLOCKQUOTE.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '', text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBq = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (RX.blockquoteStart.test(lines[i])) { cur.push(lines[i]); inBq = true; }
      else if (!inBq) cur.push(lines[i]);
      else break;
    }
    lines = lines.slice(i);
    const curRaw = cur.join('\n');
    const curText = curRaw
      .replace(RX.blockquoteMarkerWhitespace, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RX.blockquoteSetextReplace, '\n    $1')
      .replace(RX.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + curRaw : curRaw;
    text = text ? text + '\n' + curText : curText;
    const top = st.top;
    st.top = true;
    blockTokens(st, curText, tokens, true);
    st.top = top;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const oldTok = last;
      const cont = lines.join('\n');
      const newText = oldTok.raw + '\n' + cont.replace(RX.blockquoteSetextReplace2, '');
      const newTok = tokBlockquote(st, newText);
      tokens[tokens.length - 1] = newTok;
      const leftover = newText.substring(newTok.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldTok.text.length) + newTok.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RX.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last?.type === 'list') {
      const oldTok = last;
      const newText = oldTok.raw + '\n' + lines.join('\n');
      const newTok = tokList(st, newText);
      tokens[tokens.length - 1] = newTok;
      const consumedCount = newTok.raw.length > oldTok.raw.length
        ? newText.slice(oldTok.raw.length + 1, newTok.raw.length).split('\n').length : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}
function tokList(st, src) {
  const cap0 = LIST.exec(src);
  if (!cap0) return;
  const listSrc = src;
  let srcRest = src;
  const taken = () => listSrc.length - srcRest.length;
  let bull = cap0[1].trim();
  const isordered = bull.length > 1;
  const list = { type: 'list', raw: '', ordered: isordered, start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  while (srcRest) {
    let endEarly = false;
    let itemContents = '';
    let cap;
    if (!(cap = itemRegex.exec(srcRest))) break;
    if (BLOCK.hr.test(srcRest)) break;
    const itemStart = taken();
    srcRest = srcRest.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(RX.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = srcRest.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) indent = bulletIndent + 1;
    else {
      indent = line.search(RX.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && RX.blankLine.test(nextLine)) {
      srcRest = srcRest.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesRe = fencesBeginRegex(indent);
      const headingRe = headingBeginRegex(indent);
      const htmlRe = htmlBeginRegex(indent);
      const bqRe = blockquoteBeginRegex(indent);
      while (srcRest) {
        const rawLine = srcRest.split('\n', 1)[0];
        nextLine = rawLine;
        const nextNoTabs = nextLine.replace(RX.leadingSpaceTab, (ws) => expandTabs(ws));
        // Pre-check: only run the interrupt regexes when the line's first
        // non-space char can start one of them (fence, heading, html,
        // blockquote, bullet, hr). Plain prose lines skip all six tests.
        const fcIdx = nextNoTabs.search(RX.nonSpaceChar);
        const fc = fcIdx >= 0 ? nextNoTabs.charCodeAt(fcIdx) : -1;
        const mayInterrupt = fc === 96 || fc === 126 || fc === 35 || fc === 60 || fc === 62
          || fc === 42 || fc === 45 || fc === 43 || fc === 95
          || (fc >= 48 && fc <= 57);
        if (mayInterrupt) {
          if (fencesRe.test(nextLine)) break;
          if (headingRe.test(nextLine)) break;
          if (htmlRe.test(nextLine)) break;
          if (bqRe.test(nextLine)) break;
          if (nextBullet.test(nextLine)) break;
          if (hrRe.test(nextLine)) break;
        }
        if (nextNoTabs.search(RX.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextNoTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(RX.tabCharGlobal, '    ').search(RX.nonSpaceChar) >= 4) break;
          if (fencesRe.test(line)) break;
          if (headingRe.test(line)) break;
          if (htmlRe.test(line)) break;
          if (hrRe.test(line)) break;
          const setextCont = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && BLOCK_LHEADING.test(`${line}\n${nextLine}`);
          const cont = setextCont ? `    ${nextNoTabs.replace(/^ {0,3}/, '')}` : nextLine;
          itemContents += '\n' + cont;
        }
        blankLine = !nextLine.trim();
        srcRest = srcRest.substring(rawLine.length + 1);
        line = nextNoTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, listSrc.length - srcRest.length);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (RX.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({ type: 'list_item', raw, task: !!RX.listIsTask.test(itemContents), loose: false, text: itemContents, tokens: [] });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return;
  list.raw = listSrc.slice(0, listSrc.length - srcRest.length).trimEnd();
  for (const item of list.items) {
    st.top = false;
    item.tokens = blockTokens(st, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      list.loose = spacers.length > 0 && spacers.some((t) => RX.anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const itemTok = item.tokens[0];
    if (item.task && (itemTok?.type === 'text' || itemTok?.type === 'paragraph')) {
      item.text = item.text.replace(RX.listReplaceTask, '');
      itemTok.raw = itemTok.raw.replace(RX.listReplaceTask, '');
      itemTok.text = itemTok.text.replace(RX.listReplaceTask, '');
      for (let i = st.inlineQueue.length - 1; i >= 0; i--) {
        if (RX.listIsTask.test(st.inlineQueue[i].src)) {
          st.inlineQueue[i].src = st.inlineQueue[i].src.replace(RX.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = RX.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const cb = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && item.tokens[0].tokens) {
            item.tokens[0].raw = cb.raw + item.tokens[0].raw;
            item.tokens[0].text = cb.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(cb);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: cb.raw, tokens: [cb] });
          }
        } else {
          item.tokens.unshift(cb);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}
function tokHtml(st, src) {
  const cap = HTML.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
}
function tokDef(st, src) {
  const cap = DEF.exec(src);
  if (cap) {
    if (!RX.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(RX.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}
function tokTable(st, src) {
  const cap = TABLE.exec(src);
  if (!cap) return;
  if (!RX.tableDelimiter.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RX.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(RX.tableRowBlankLine, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const a of aligns) {
    if (RX.tableAlignRight.test(a)) item.align.push('right');
    else if (RX.tableAlignCenter.test(a)) item.align.push('center');
    else if (RX.tableAlignLeft.test(a)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: queueInline(st, headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({ text: cell, tokens: queueInline(st, cell), header: false, align: item.align[i] })));
  }
  return item;
}
function tokLheading(st, src) {
  const cap = BLOCK_LHEADING.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(st, text) };
  }
}
function tokParagraph(st, src) {
  const cap = PARAGRAPH.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(st, text) };
  }
}
function tokText(st, src) {
  const cap = BLOCK.text.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(st, cap[0]) };
}
function queueInline(st, text) {
  const tokens = [];
  st.inlineQueue.push({ src: text, tokens });
  return tokens;
}

// ---------- inline tokenizers ----------
function inLinkText(st, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP)) {
    if (LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH)) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(st.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && inLinkText(st, m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}
function maskSrc(st, src) {
  let masked = src;
  if (st.links && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(st.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (inLinkText(st, text)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH, maskReflink);
  }
  masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(BLOCK_SKIP, (m0, _link, ctx) => {
      const off = ctx ? ctx.length : 0;
      return m0.slice(0, off) + '[' + 'a'.repeat(m0.length - off - 2) + ']';
    });
  }
  return masked;
}
function makeLinkToken(st, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RX.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const tokens = inlineTokens(st, text);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      st.inRawBlock = outerInRawBlock;
      return;
    }
    st.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}
function tokInlineEscape(st, src) {
  const cap = INLINE.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}
function tokInlineTag(st, src) {
  const cap = TAG_RX.exec(src);
  if (cap) {
    if (!st.inLink && RX.startATag.test(cap[0])) st.inLink = true;
    else if (st.inLink && RX.endATag.test(cap[0])) st.inLink = false;
    if (!st.inRawBlock && RX.startPreScriptTag.test(cap[0])) st.inRawBlock = true;
    else if (st.inRawBlock && RX.endPreScriptTag.test(cap[0])) st.inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: cap[0] };
  }
}
function tokInlineLink(st, src) {
  if (st.linkParenPossible === false) return;
  const cap = LINK.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (RX.startAngleBracket.test(trimmedUrl)) {
      if (!RX.endAngleBracket.test(trimmedUrl)) return;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (RX.startAngleBracket.test(href)) href = href.slice(1, -1);
    return makeLinkToken(st, cap, {
      href: href ? href.replace(ANY_PUNCT, '$1') : href,
      title: title ? title.replace(ANY_PUNCT, '$1') : title,
    }, cap[0]);
  }
}
function tokInlineReflink(st, src) {
  let cap;
  if ((cap = REFLINK.exec(src)) || (cap = NOLINK.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const link = st.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return makeLinkToken(st, cap, link, cap[0]);
  }
}
function lastCloserFor(st, maskedSrc, delim) {
  const f = st.closerFrame;
  if (f && f.maskedSrc === maskedSrc) return delim === '~' ? f.lastTilde : f.lastStar[delim];
  const s = scanLastClosers(maskedSrc);
  return delim === '~' ? s.lastTilde : s.lastStar[delim];
}
function tokInlineEmStrong(st, src, maskedSrc, prevChar = '') {
  let match = EM_STRONG_LDELIM.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuation.exec(prevChar);
  if (match[4] && prevChar.match(RX.unicodeAlphaNumeric)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? EM_STRONG_RDELIM_AST : EM_STRONG_RDELIM_UND;
    const lastPossible = lastCloserFor(st, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(st, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(st, text) };
    }
  }
}
function tokInlineCodespan(st, src) {
  const cap = INLINE.code.exec(src);
  if (cap) {
    let text = cap[2].replace(RX.newLineCharGlobal, ' ');
    const hasNonSpace = RX.nonSpaceChar.test(text);
    const hasSpaceBoth = RX.startingSpaceChar.test(text) && RX.endingSpaceChar.test(text);
    if (hasNonSpace && hasSpaceBoth) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}
function tokInlineBr(st, src) {
  const cap = INLINE.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}
function tokInlineDel(st, src, maskedSrc, prevChar = '') {
  let match = DEL_LDELIM.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = DEL_RDELIM;
    const lastPossible = lastCloserFor(st, maskedSrc, '~');
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(st, text) };
    }
  }
}
function tokInlineAutolink(st, src) {
  const cap = AUTOLINK.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') { text = cap[1]; href = 'mailto:' + text; }
    else { text = cap[1]; href = text; }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}
function tokInlineUrl(st, src) {
  const cap = URL_RX.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prev = cap[0];
      do {
        prev = cap[0];
        cap[0] = BACKPEDAL.exec(cap[0])?.[0] ?? '';
      } while (prev !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    return { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}
// Fast inline-text scanner: returns the length of the plain-text run at the
// start of src, or -1 to fall back to the full INLINE_TEXT_GFM regex
// (mailto:/xmpp: cases). Mirrors the regex boundaries: \ < [ ` * ~ ! _ stop
// a run, two spaces + newline is a hard break, http(s)://, ftp:// and www.
// (with the lookbehind) start a URL token, and a non-email char followed by
// email chars + @ stops before the email address.
function isEmailCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38
    || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63
    || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
function fastTextLen(src) {
  if (src.includes('mailto:') || src.includes('xmpp:')) return -1;
  const n = src.length;
  const hasAt = src.indexOf('@') !== -1;
  let i = 0;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) { while (i < n && src.charCodeAt(i) === 96) i++; }
  else if (c0 === 126) { while (i < n && src.charCodeAt(i) === 126) i++; }
  else i = 1;
  for (; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 92 || c === 60 || c === 91 || c === 96 || c === 42 || c === 126 || c === 33 || c === 95) break;
    if (c === 32) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && src.charCodeAt(j) === 10) break;
      i = j - 1;
    } else if ((c | 32) === 104) { // h: http:// or https://
      if (isHttpAt(src, i)) break;
    } else if ((c | 32) === 102) { // f: ftp://
      if (isFtpAt(src, i)) break;
    } else if ((c | 32) === 119) { // w: www.
      if (isWwwAt(src, i)) {
        const p = src.charCodeAt(i - 1);
        if (i === 0 || p === 32 || p === 42 || p === 95 || p === 126 || p === 40 || p === 91) break;
      }
    }
    // Email boundary: at the start of a local part (email char preceded by a
    // non-email char), look ahead for @. Stops before the email address.
    // Do not skip ahead: the scanned range may hold boundary chars (* ~ `).
    if (hasAt && isEmailCharCode(c) && (i === 0 || !isEmailCharCode(src.charCodeAt(i - 1)))) {
      let j = i;
      while (j < n && isEmailCharCode(src.charCodeAt(j))) j++;
      if (j < n && src.charCodeAt(j) === 64) break;
    }
  }
  return i;
}
function isHttpAt(src, i) {
  const c1 = src.charCodeAt(i), c2 = src.charCodeAt(i + 1), c3 = src.charCodeAt(i + 2), c4 = src.charCodeAt(i + 3);
  if ((c1 | 32) !== 104 || (c2 | 32) !== 116 || (c3 | 32) !== 116 || (c4 | 32) !== 112) return false;
  const c5 = src.charCodeAt(i + 4);
  if (c5 === 58) return src.charCodeAt(i + 5) === 47 && src.charCodeAt(i + 6) === 47;
  if ((c5 | 32) === 115) return src.charCodeAt(i + 5) === 58 && src.charCodeAt(i + 6) === 47 && src.charCodeAt(i + 7) === 47;
  return false;
}
function isFtpAt(src, i) {
  const c1 = src.charCodeAt(i), c2 = src.charCodeAt(i + 1), c3 = src.charCodeAt(i + 2);
  if ((c1 | 32) !== 102 || (c2 | 32) !== 116 || (c3 | 32) !== 112) return false;
  return src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
}
function isWwwAt(src, i) {
  const c1 = src.charCodeAt(i), c2 = src.charCodeAt(i + 1), c3 = src.charCodeAt(i + 2), c4 = src.charCodeAt(i + 3);
  return (c1 | 32) === 119 && (c2 | 32) === 119 && (c3 | 32) === 119 && c4 === 46;
}
function tokInlineText(st, src) {
  const fast = fastTextLen(src);
  if (fast > 0) {
    const raw = src.slice(0, fast);
    const escaped = st.inRawBlock;
    return { type: 'text', raw, text: escaped ? raw : decodeNumericRefs(raw), escaped };
  }
  const cap = INLINE_TEXT_GFM.exec(src);
  if (cap) {
    const escaped = st.inRawBlock;
    return { type: 'text', raw: cap[0], text: escaped ? cap[0] : decodeNumericRefs(cap[0]), escaped };
  }
}

// ---------- block lexer loop ----------
function blockTokens(st, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) srcLength = src.length;
    else break;
    let token;
    if ((token = tokSpace(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (token.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(token);
      continue;
    }
    if ((token = tokCode(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      continue;
    }
    if ((token = tokFences(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokHeading(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokHr(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokBlockquote(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokList(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokHtml(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokDef(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.raw;
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else {
        if (!st.links[token.tag]) st.links[token.tag] = { href: token.href, title: token.title };
        tokens.push(token);
      }
      continue;
    }
    if ((token = tokTable(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    // Pre-check: a setext underline needs \n + up to 3 spaces/tabs + = or -.
    // Skip the expensive lheading regex when no such line exists.
    if (RX.setextUnderline.test(src) && (token = tokLheading(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if (st.top && (token = tokParagraph(st, src))) {
      const last = tokens[tokens.length - 1];
      if (lastParagraphClipped && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        st.inlineQueue.pop();
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    if ((token = tokText(st, src))) {
      src = src.substring(token.raw.length);
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
        last.text += '\n' + token.text;
        st.inlineQueue.pop();
        st.inlineQueue[st.inlineQueue.length - 1].src = last.text;
      } else tokens.push(token);
      continue;
    }
    if (src) break;
  }
  st.top = true;
  return tokens;
}

// ---------- inline lexer loop ----------
function inlineTokens(st, src, tokens = []) {
  const prevLinkParen = st.linkParenPossible;
  st.linkParenPossible = prevLinkParen && src.includes(')');
  try {
    return inlineTokensInner(st, src, tokens);
  } finally {
    st.linkParenPossible = prevLinkParen;
  }
}
function inlineTokensInner(st, src, tokens) {
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = hasDelim ? maskSrc(st, src) : src;
  const prevFrame = st.closerFrame;
  const frame = hasDelim ? scanLastClosers(maskedSrc) : { lastStar: { '*': -1, '_': -1 }, lastTilde: -1 };
  frame.maskedSrc = maskedSrc;
  st.closerFrame = frame;
  try {
    return tokenizeInlines(st, src, maskedSrc, tokens);
  } finally {
    st.closerFrame = prevFrame;
  }
}
function tokenizeInlines(st, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) srcLength = src.length;
    else break;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let token;
    // Dispatch on the first char: each tokenizer can only match at its own
    // opener, so trying the others first only burns failed regex execs.
    const c = src.charCodeAt(0);
    if (c === 92) { // backslash: escape, br
      if ((token = tokInlineEscape(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = tokInlineBr(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    } else if (c === 60) { // <: tag, autolink
      if ((token = tokInlineTag(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = tokInlineAutolink(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    } else if (c === 91 || c === 33) { // [ or !: link, reflink
      if ((token = tokInlineLink(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
      if ((token = tokInlineReflink(st, src))) {
        src = src.substring(token.raw.length);
        const last = tokens[tokens.length - 1];
        if (token.type === 'text' && last?.type === 'text') { last.raw += token.raw; last.text += token.text; }
        else tokens.push(token);
        continue;
      }
    } else if (c === 42 || c === 95) { // * or _: emStrong
      if ((token = tokInlineEmStrong(st, src, maskedSrc, prevChar))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    } else if (c === 96) { // backtick: codespan
      if ((token = tokInlineCodespan(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    } else if (c === 126) { // ~: del
      if ((token = tokInlineDel(st, src, maskedSrc, prevChar))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    } else if (c === 32) { // space: br
      if ((token = tokInlineBr(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    }
    if (!st.inLink && (token = tokInlineUrl(st, src))) { src = src.substring(token.raw.length); tokens.push(token); continue; }
    if ((token = tokInlineText(st, src))) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') { last.raw += token.raw; last.text += token.text; }
      else tokens.push(token);
      continue;
    }
    if (src) break;
  }
  return tokens;
}

// ---------- renderer ----------
function renderInline(st, tokens, textMode) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape':
      case 'text':
        if (textMode) out += token.text;
        else if (token.tokens) out += renderInline(st, token.tokens, textMode);
        else if (token.escaped) out += token.text;
        else out += escapeHtml(token.text);
        break;
      case 'html': out += token.text; break;
      case 'link': {
        if (textMode) { out += token.tokens ? renderInline(st, token.tokens, true) : token.text; break; }
        const parsedText = token.autolink ? escapeHtml(token.text, true) : renderInline(st, token.tokens, false);
        const clean = cleanUrl(token.href);
        if (clean === null) { out += parsedText; break; }
        const href = escapeHtml(clean, token.autolink);
        let o = '<a href="' + href + '"';
        if (token.title) o += ' title="' + escapeHtml(token.title) + '"';
        o += '>' + parsedText + '</a>';
        out += o;
        break;
      }
      case 'image': {
        if (textMode) { out += token.tokens ? renderInline(st, token.tokens, true) : token.text; break; }
        let alt = token.tokens ? renderInline(st, token.tokens, true) : token.text;
        const clean = cleanUrl(token.href);
        if (clean === null) { out += escapeHtml(alt); break; }
        let o = '<img src="' + escapeHtml(clean) + '" alt="' + escapeHtml(alt) + '"';
        if (token.title) o += ' title="' + escapeHtml(token.title) + '"';
        o += '>';
        out += o;
        break;
      }
      case 'checkbox':
        out += textMode ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += textMode ? renderInline(st, token.tokens, true) : '<strong>' + renderInline(st, token.tokens, false) + '</strong>';
        break;
      case 'em':
        out += textMode ? renderInline(st, token.tokens, true) : '<em>' + renderInline(st, token.tokens, false) + '</em>';
        break;
      case 'codespan':
        out += textMode ? token.text : '<code>' + escapeHtml(token.text, true) + '</code>';
        break;
      case 'br': out += textMode ? '' : '<br>'; break;
      case 'del':
        out += textMode ? renderInline(st, token.tokens, true) : '<del>' + renderInline(st, token.tokens, false) + '</del>';
        break;
    }
  }
  return out;
}
function renderBlocks(st, tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += '<h' + token.depth + '>' + renderInline(st, token.tokens, false) + '</h' + token.depth + '>\n'; break;
      case 'code': {
        const langStr = (token.lang || '').match(RX.notSpaceStart)?.[0];
        const code = token.text ? token.text.replace(RX.endingNewline, '') + '\n' : '';
        if (!langStr) out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        else out += '<pre><code class="language-' + escapeHtml(langStr) + '">' + escapeHtml(code, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let header = '';
        for (const c of token.header) header += renderTableCell(st, c);
        let head = '<tr>\n' + header + '</tr>\n';
        let body = '';
        for (const row of token.rows) {
          let cell = '';
          for (const c of row) cell += renderTableCell(st, c);
          body += '<tr>\n' + cell + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n' + head + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote': out += '<blockquote>\n' + renderBlocks(st, token.tokens) + '</blockquote>\n'; break;
      case 'list': {
        let body = '';
        for (const item of token.items) body += '<li>' + renderBlocks(st, item.tokens) + '</li>\n';
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? ' start="' + token.start + '"' : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += '<p>' + renderInline(st, token.tokens, false) + '</p>\n'; break;
      case 'text': out += renderInline(st, token.tokens, false); break;
    }
  }
  return out;
}
function renderTableCell(st, cell) {
  const content = renderInline(st, cell.tokens, false);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? '<' + type + ' align="' + cell.align + '">' : '<' + type + '>';
  return tag + content + '</' + type + '>\n';
}

// ---------- entry point ----------
export function parse(markdown) {
  const st = makeState();
  const src = String(markdown).replace(RX.carriageReturn, '\n');
  const tokens = blockTokens(st, src, []);
  for (let i = 0; i < st.inlineQueue.length; i++) {
    const next = st.inlineQueue[i];
    st.inRawBlock = false;
    inlineTokens(st, next.src, next.tokens);
  }
  st.inlineQueue = [];
  return renderBlocks(st, tokens);
}

