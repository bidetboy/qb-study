// DOM + misc helpers shared by every view.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'value') el.value = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Questions from the API contain light HTML (<b>, <u>, <i>). Keep only formatting tags.
const ALLOWED = new Set(['B', 'I', 'U', 'EM', 'STRONG', 'BR', 'SUB', 'SUP', 'SPAN']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html ?? ''}</div>`, 'text/html');
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        if (DROP.has(child.tagName)) { child.remove(); continue; }
        clean(child);
        if (ALLOWED.has(child.tagName)) for (const a of [...child.attributes]) child.removeAttribute(a.name);
        else child.replaceWith(...child.childNodes);
      } else if (child.nodeType !== 3) child.remove();
    }
  };
  const root = doc.body.firstChild;
  clean(root);
  return root.innerHTML;
}

export function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = sanitizeHtml(html);
  return d.textContent;
}

export function toast(msg, kind = 'info') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc, true);
    onClose?.();
  };
  const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' },
        h('h3', null, title),
        h('button', { class: 'icon-btn', onClick: close, 'aria-label': 'Close' }, '×')),
      h('div', { class: 'modal-body' }, body)));
  document.addEventListener('keydown', onEsc, true);
  document.body.append(overlay);
  return { close, el: overlay };
}

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal('Confirm', h('div', null,
      h('p', null, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onClick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn danger', onClick: () => finish(true) }, okLabel))),
      { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

export function promptDialog(title, initial = '', okLabel = 'Save') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value: initial });
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal(title, h('form', { onSubmit: (e) => { e.preventDefault(); finish(input.value.trim() || null); } },
      input,
      h('div', { class: 'row end', style: 'margin-top:12px' },
        h('button', { type: 'button', class: 'btn', onClick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn primary' }, okLabel))),
      { onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { input.focus(); input.select(); });
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function todayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(t) {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function download(filename, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); });
}

export const CATEGORIES = {
  'Literature': ['American Literature', 'British Literature', 'Classical Literature', 'European Literature', 'World Literature', 'Other Literature'],
  'History': ['American History', 'Ancient History', 'European History', 'World History', 'Other History'],
  'Science': ['Biology', 'Chemistry', 'Physics', 'Other Science'],
  'Fine Arts': ['Visual Fine Arts', 'Auditory Fine Arts', 'Other Fine Arts'],
  'Religion': ['Religion'],
  'Mythology': ['Mythology'],
  'Philosophy': ['Philosophy'],
  'Social Science': ['Social Science'],
  'Current Events': ['Current Events'],
  'Geography': ['Geography'],
  'Other Academic': ['Other Academic'],
  'Pop Culture': ['Movies', 'Music', 'Sports', 'Television', 'Video Games', 'Other Pop Culture'],
};

export const DIFFICULTIES = {
  1: 'Middle school', 2: 'Easy HS', 3: 'Regular HS', 4: 'Hard HS', 5: 'National HS',
  6: 'Easy college', 7: 'Medium college', 8: 'Regionals', 9: 'Nationals', 10: 'Open',
};
