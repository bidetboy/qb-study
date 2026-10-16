// Anki-style cloze syntax: {{c1::answer}} or {{c1::answer::hint}}
import { esc } from './util.js?v=5da9d5ed';

const RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(text) {
  return [...new Set([...String(text).matchAll(RE)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

const nl = (s) => esc(s).replace(/\n/g, '<br>');

// mode: 'front' hides cloze n, 'back' reveals it highlighted, 'preview' highlights every cloze.
export function renderCloze(text, n, mode) {
  let out = '';
  let last = 0;
  for (const m of String(text).matchAll(RE)) {
    out += nl(text.slice(last, m.index));
    const [, num, ans, hint] = m;
    if (mode === 'preview') out += `<span class="cloze-mark" data-n="${num}">${nl(ans)}</span>`;
    else if (Number(num) !== n) out += nl(ans);
    else if (mode === 'front') out += `<span class="cloze">[${hint ? nl(hint) : '…'}]</span>`;
    else out += `<span class="cloze">${nl(ans)}</span>`;
    last = m.index + m[0].length;
  }
  return out + nl(String(text).slice(last));
}

export function stripCloze(text) {
  return String(text).replace(RE, (_, n, ans) => ans);
}

// Wrap the textarea's selection in a cloze. sameNumber reuses the highest existing number.
export function wrapSelection(ta, sameNumber = false) {
  const nums = clozeNumbers(ta.value);
  const max = nums.length ? nums[nums.length - 1] : 0;
  const n = sameNumber ? Math.max(1, max) : max + 1;
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e);
  const open = `{{c${n}::`;
  ta.value = value.slice(0, s) + open + sel + '}}' + value.slice(e);
  const caret = sel ? s + open.length + sel.length + 2 : s + open.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// Alt+C → new cloze, Alt+Shift+C → same number. Ctrl/Cmd+Shift+C (+Alt) also works where the browser allows it.
export function clozeKeyHandler(e) {
  if (e.code !== 'KeyC') return;
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    wrapSelection(e.target, e.shiftKey);
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
    wrapSelection(e.target, e.altKey);
  }
}
