// Tossup practice sets: the set picker, "Save to set" from anywhere, and the undo popup.
import { h, toast, modal, promptDialog } from './util.js?v=4b7a325a';
import { db, save, isSaved, toggleSaved, setIdsOf, createTossupSet, getTossupSet } from './store.js?v=4b7a325a';

// Checkbox list of tossup sets with a "new set" button. Resolves to chosen ids, or null if cancelled.
export function pickSets(title, selectedIds = [], okLabel = 'Save') {
  return new Promise((resolve) => {
    const chosen = new Set(selectedIds);
    let done = false;
    const el = h('div', { class: 'deck-picker' });
    const paint = () => el.replaceChildren(
      ...db.tossupSets.map((t) => h('label', { class: `deck-chip${chosen.has(t.id) ? ' on' : ''}` },
        h('input', { type: 'checkbox', checked: chosen.has(t.id), onChange: (e) => { chosen[e.target.checked ? 'add' : 'delete'](t.id); paint(); } }),
        t.name)),
      h('button', { type: 'button', class: 'btn tiny ghost', onClick: async () => {
        const name = await promptDialog('New set name', '', 'Create');
        if (!name) return;
        chosen.add(createTossupSet(name).id);
        paint();
      } }, '＋ New set'));
    paint();
    const finish = (v) => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal(title, h('div', { class: 'stack' },
      el,
      h('div', { class: 'row end gap-s' },
        h('button', { class: 'btn', onClick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => finish(db.tossupSets.map((t) => t.id).filter((id) => chosen.has(id))) }, okLabel))),
      { onClose: () => { if (!done) { done = true; resolve(null); } } });
  });
}

let popup = null;

// Bottom-right "Saved to Set!" notice with a 10-second countdown and an Undo button.
function showUndoPopup(names, undo) {
  popup?.dismiss();
  const SECONDS = 10;
  let left = SECONDS;
  const count = h('span', { class: 'set-popup-count muted small' }, `${left}s`);
  const bar = h('div', { class: 'set-popup-bar' }, h('div', { style: `animation-duration:${SECONDS}s` }));
  const dismiss = () => {
    clearInterval(tick);
    el.remove();
    if (popup?.el === el) popup = null;
  };
  const el = h('div', { class: 'set-popup', role: 'status' },
    h('div', { class: 'row gap-s' },
      h('div', { class: 'grow' },
        h('div', { class: 'set-popup-title' }, 'Saved to Set!'),
        h('div', { class: 'muted small' }, names.join(', '))),
      count,
      h('button', { class: 'btn small', onClick: () => { undo(); dismiss(); toast('Undone'); } }, 'Undo'),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => dismiss() }, '×')),
    bar);
  const tick = setInterval(() => {
    left--;
    count.textContent = `${left}s`;
    if (left <= 0) dismiss();
  }, 1000);
  document.body.append(el);
  popup = { el, dismiss };
}

// Save a tossup (if it isn't already) and put it in the sets the user picks.
// onChange runs after the save and again after an undo, so callers can repaint buttons.
export async function saveToSet(q, { onChange } = {}) {
  const wasSaved = isSaved(q._id);
  const prev = wasSaved ? [...setIdsOf(db.saved.find((s) => s.qid === q._id))] : [];
  const ids = await pickSets(wasSaved ? 'Sets for this tossup' : 'Save to set', prev, 'Save');
  if (!ids) return;
  const added = ids.filter((id) => !prev.includes(id));
  if (!wasSaved && !ids.length) return;
  if (!wasSaved) toggleSaved(q, 'tossup');
  const item = db.saved.find((s) => s.qid === q._id);
  item.sets = [...new Set(ids)];
  save();
  onChange?.();
  if (!added.length) { toast('Sets updated'); return; }
  showUndoPopup(added.map((id) => getTossupSet(id)?.name).filter(Boolean), () => {
    if (!wasSaved) {
      db.saved = db.saved.filter((s) => s.qid !== q._id);
    } else {
      const s = db.saved.find((x) => x.qid === q._id);
      if (s) s.sets = prev;
    }
    save();
    onChange?.();
  });
}

export function saveToSetButton(q, { onChange } = {}) {
  return h('button', { class: 'btn small', title: 'Save this tossup into a practice set', onClick: () => saveToSet(q, { onChange }) }, '＋ Save to set');
}
