// Split text (a Google Doc saved as plain text, a CSV/TSV file, or a paste) into cloze notes.
// No DOM here: the import screen is importer.js.
import { clozeNumbers, stripCloze } from './cloze.js?v=a368a4df';

// Spreadsheet-style separators: a cell that starts with " runs to the closing " (write "" for a
// literal quote), so it can hold the separator and line breaks, like in a CSV/TSV file.
const CELL_SEPS = { tab: '\t', comma: ',', semicolon: ';' };

// Split text into the raw pieces between separators.
// sep: 'line' | 'blank' | 'tab' | 'comma' | 'semicolon' | 'custom' (splits on `custom`).
// lineBreaks: for tab/comma/semicolon/custom, a line break also ends a piece.
export function splitText(text, { sep = 'line', custom = '', lineBreaks = false } = {}) {
  const t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?|[\u2028\u2029]/g, '\n');
  if (CELL_SEPS[sep]) return splitCells(t, CELL_SEPS[sep], lineBreaks);
  if (sep === 'blank') return t.split(/\n(?:[ \t\u00a0]*\n)+/);
  if (sep === 'custom') {
    const parts = custom ? t.split(custom) : [t];
    return lineBreaks ? parts.flatMap((p) => p.split('\n')) : parts;
  }
  return t.split('\n');
}

function splitCells(t, sep, lineBreaks) {
  const ends = (i) => i >= t.length || t[i] === sep || (lineBreaks && t[i] === '\n');
  const out = [];
  let i = 0;
  for (;;) {
    let j = i;
    while (t[j] === ' ') j++;
    if (t[j] === '"') {
      let val = '';
      let close = -1;
      for (let k = j + 1; ;) {
        const q = t.indexOf('"', k);
        if (q < 0) break;
        val += t.slice(k, q);
        if (t[q + 1] === '"') { val += '"'; k = q + 2; continue; }
        close = q + 1;
        break;
      }
      if (close >= 0) {
        while (t[close] === ' ') close++;
        if (ends(close)) {
          out.push(val);
          if (close >= t.length) return out;
          i = close + 1;
          continue;
        }
      }
      // No closing quote right before a separator: read the quote as ordinary text.
    }
    let end = i;
    while (!ends(end)) end++;
    out.push(t.slice(i, end));
    if (end >= t.length) return out;
    i = end + 1;
  }
}

// List markers that Google Docs and other editors put at the start of a line.
const BULLET = /^(?:[*•●○◦▪■□►‣⁃∙·–—-]|\d{1,3}[.)])\s+/;

// Tidy one piece: trim it, turn Google Docs' soft line breaks (\v) into line breaks, and
// optionally drop a leading bullet or number.
export function cleanPiece(raw, stripBullets = true) {
  const t = raw.replace(/\v/g, '\n').trim();
  return stripBullets ? t.replace(BULLET, '').trim() : t;
}

// What counts as the same note when skipping duplicates.
export const dupKey = (text) => text.replace(/\s+/g, ' ').trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Other ways people mark clozes: 'brackets' [x], 'braces' {x}, 'double' {{x}}, or 'custom'
// (`open` x `close`). For brackets and braces the whole run is matched, so {{x}} isn't read as {x}.
function markerRegex(markers, open, close) {
  if (markers === 'brackets') return { re: /(\[+)([^[\]\n]+)(\]+)/g, size: 1 };
  if (markers === 'braces') return { re: /(\{+)([^{}\n]+)(\}+)/g, size: 1 };
  if (markers === 'double') return { re: /(\{+)([^{}\n]+)(\}+)/g, size: 2 };
  if (markers === 'custom' && open && close) return { re: new RegExp(`(${escapeRe(open)})([^\\n]+?)(${escapeRe(close)})`, 'g'), size: 0 };
  return null;
}

// Turn marked parts like [answer] into clozes: {{c1::…}}, {{c2::…}}, … in order, or all {{c1::…}}
// (one card) when `together`. Notes that already have {{c1::…}} clozes are left as they are, so
// brackets there (pronunciation guides, [sic]) stay plain text.
export function convertMarkers(text, { markers = 'none', open = '', close = '', together = false } = {}) {
  const m = markerRegex(markers, open, close);
  if (!m || clozeNumbers(text).length) return text;
  let n = 0;
  return text.replace(m.re, (all, a, body, b) => {
    const answer = body.trim();
    // Leave empty marks, the wrong number of brackets, and mistyped clozes like {{c1:x}} alone.
    if (!answer || (m.size && (a.length !== m.size || b.length !== m.size)) || /^c\d+:/i.test(answer)) return all;
    return `{{c${together ? 1 : ++n}::${answer}}}`;
  });
}

// [something] or {something}: possibly clozes marked another way.
const MARKED = /\[[ \t]*[^\s\]][^\]\n]*\]|\{[ \t]*[^\s}][^}\n]*\}/;

// Turn text into note drafts: { text, cards, skip, warn }, one per non-empty piece, with marked
// parts already turned into clozes (see convertMarkers).
// skip says why a piece won't be imported: 'nocloze'; 'marked' (no cloze, but has [ ] or { } and
// no marker style is chosen); 'broken' (a mistyped {{c1::…}}, or stray {{ or }}); 'indeck' (its
// dupKey is in `existing`, the notes already in the target decks) or 'repeat' (same as an earlier
// piece). warn: imported, but has a stray {{ or }} outside its clozes.
export function parseNotes(text, { stripBullets = true, skipDupes = true, markers = 'none', open = '', close = '', together = false, ...split } = {}, existing = new Set()) {
  const seen = new Set();
  const out = [];
  for (const raw of splitText(text, split)) {
    const piece = cleanPiece(raw, stripBullets);
    if (!piece) continue;
    const t = convertMarkers(piece, { markers, open, close, together });
    const cards = clozeNumbers(t).length;
    const stray = /\{\{|\}\}/.test(cards ? stripCloze(t) : t);
    let skip = null;
    if (!cards) {
      if (/\{\{\s*c\d/i.test(t)) skip = 'broken';
      else if (markers === 'none' && MARKED.test(t)) skip = 'marked';
      else skip = stray ? 'broken' : 'nocloze';
    } else if (skipDupes) {
      const key = dupKey(t);
      if (existing.has(key)) skip = 'indeck';
      else if (seen.has(key)) skip = 'repeat';
      seen.add(key);
    }
    out.push({ text: t, cards, skip, warn: cards > 0 && stray });
  }
  return out;
}
