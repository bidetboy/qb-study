// Turn QB Reader questions into cloze notes.
import { h, modal, toast, htmlToText, promptDialog } from './util.js?v=232d3239';
import { db, save as saveDb, addNote, createDeck } from './store.js?v=232d3239';
import { clozeNumbers, wrapSelection, clozeKeyHandler, renderCloze } from './cloze.js?v=232d3239';
import { mainAnswer, qMeta } from './qview.js?v=232d3239';

const ABBREV = /(?:\b(?:St|Mr|Mrs|Ms|Dr|Jr|Sr|vs|ca|No|Mt|Ft|Gen|Col|Lt|Sgt|Rev|Op|Vol|ed|U\.S|e\.g|i\.e|cf|al)|\b[A-Z])\.$/;

export function splitClues(text) {
  const raw = String(text).replace(/\s*\(\*\)/g, '').match(/[^.!?]+(?:[.!?]+["”’')\]]*|$)/g) || [];
  const out = [];
  for (const piece of raw) {
    if (!piece.trim()) continue;
    const prev = out[out.length - 1];
    if (prev != null && (ABBREV.test(prev.trimEnd()) || /^\s*[a-z]/.test(piece))) out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out.map((s) => s.trim());
}

function sourceOf(q, type) {
  return { type, id: q._id, set: q.set?.name, packet: q.packet?.number, number: q.number, category: q.category, subcategory: q.subcategory };
}

// Each template returns drafts as { text, part } — part is the bonus part index (null for tossups).
function strategies(q, type) {
  if (type === 'tossup') {
    const ans = mainAnswer(q.answer_sanitized ?? htmlToText(q.answer));
    const full = (q.question_sanitized ?? htmlToText(q.question)).replace(/\(\*\)\s*/g, '');
    const one = (text) => ({ text, part: null });
    return {
      'One card per clue': () => splitClues(full).map((s) => one(`${s}\n→ {{c1::${ans}}}`)),
      'Whole question': () => [one(`${full}\n→ {{c1::${ans}}}`)],
      'Blank (cloze it yourself)': () => [one(`${full}\nANSWER: ${ans}`)],
    };
  }
  const leadin = q.leadin_sanitized ?? htmlToText(q.leadin);
  const parts = q.parts_sanitized ?? (q.parts || []).map(htmlToText);
  const answers = (q.answers_sanitized ?? (q.answers || []).map(htmlToText)).map(mainAnswer);
  return {
    'One card per part': () => parts.map((p, i) => ({ text: `${p}\n→ {{c1::${answers[i]}}}`, part: i })),
    'Per part with lead-in': () => parts.map((p, i) => ({ text: `${leadin}\n${p}\n→ {{c1::${answers[i]}}}`, part: i })),
    'Blank (cloze it yourself)': () => parts.map((p, i) => ({ text: `${p}\nANSWER: ${answers[i]}`, part: i })),
  };
}

// Your per-part results for a bonus: from the reader if given, else your latest play in history.
function bonusResults(q, given) {
  if (Array.isArray(given) && given.length) return given;
  for (let i = db.history.length - 1; i >= 0; i--) {
    const e = db.history[i];
    if (e.type === 'bonus' && e.qid === q._id && Array.isArray(e.parts)) return e.parts;
  }
  return null;
}

export function deckSelect(selectedId) {
  const sel = h('select', { class: 'input' },
    db.decks.map((d) => h('option', { value: d.id, selected: d.id === selectedId }, d.name)),
    h('option', { value: '__new' }, '＋ New deck…'));
  sel.addEventListener('change', async () => {
    if (sel.value !== '__new') return;
    const name = await promptDialog('New deck name', '', 'Create');
    if (!name) { sel.value = db.decks[0]?.id ?? ''; return; }
    const d = createDeck(name);
    sel.insertBefore(h('option', { value: d.id }, d.name), sel.lastChild);
    sel.value = d.id;
  });
  return sel;
}

export function openConverter(q, type, { results = null } = {}) {
  const strats = strategies(q, type);
  const prefs = (db.settings.cardMaker ||= {});
  const templates = (prefs.templates ||= {});
  const partResults = type === 'bonus' ? bonusResults(q, results) : null;
  const extraDefault = `${htmlToText(type === 'tossup' ? q.answer : (q.answers || []).join(' | '))}\n${qMeta(q)}`;
  let drafts = [];
  let lastFocused = null;

  const savedDeck = db.decks.some((d) => d.id === prefs.deckId) ? prefs.deckId : db.decks[0]?.id;
  const deckSel = deckSelect(savedDeck);
  const list = h('div', { class: 'drafts' });
  const extra = h('textarea', { class: 'input', rows: 2, value: extraDefault });
  const count = h('span', { class: 'muted' });

  const updateCount = () => {
    const n = drafts.filter((d) => d.include && clozeNumbers(d.text).length).length;
    count.textContent = `${n} note${n === 1 ? '' : 's'} will be added`;
  };

  const missedOnlyActive = () => type === 'bonus' && prefs.onlyMissed && partResults != null;
  const applyMissedFilter = () => {
    if (!missedOnlyActive()) return;
    for (const d of drafts) if (d.part != null) d.include = partResults[d.part] === false;
  };

  const renderDrafts = () => {
    list.replaceChildren(...drafts.map((d) => {
      const ta = h('textarea', { class: 'input mono', rows: Math.min(8, Math.max(2, Math.ceil(d.text.length / 90) + 1)), value: d.text });
      const prev = h('div', { class: 'preview small', html: renderCloze(d.text, 0, 'preview') });
      const warn = h('div', { class: 'warn small' });
      const sync = () => {
        d.text = ta.value;
        prev.innerHTML = renderCloze(d.text, 0, 'preview');
        warn.textContent = clozeNumbers(d.text).length ? '' : 'No cloze yet — select text and press Alt+C';
        updateCount();
      };
      ta.addEventListener('input', sync);
      ta.addEventListener('focus', () => { lastFocused = ta; });
      ta.addEventListener('keydown', clozeKeyHandler);
      const cb = h('input', { type: 'checkbox', checked: d.include, onChange: (e) => { d.include = e.target.checked; updateCount(); } });
      const result = d.part != null && partResults?.[d.part] != null
        ? h('span', { class: `verdict small ${partResults[d.part] ? 'ok' : 'bad'}` }, `Part ${d.part + 1}: ${partResults[d.part] ? '✓ got it' : '✗ missed'}`)
        : d.part != null ? h('span', { class: 'muted small' }, `Part ${d.part + 1}`) : null;
      sync();
      return h('div', { class: 'draft' }, h('label', { class: 'draft-check' }, cb), h('div', { class: 'grow' }, result, ta, prev, warn));
    }));
    updateCount();
  };

  const use = (name) => {
    drafts = strats[name]().map((d) => ({ ...d, include: true }));
    applyMissedFilter();
    renderDrafts();
    $btns.forEach((b) => b.classList.toggle('on', b.dataset.name === name));
    if (templates[type] !== name) { templates[type] = name; saveDb(); }
  };

  const $btns = Object.keys(strats).map((name) => h('button', { class: 'btn small', 'data-name': name, onClick: () => use(name) }, name));

  // Bonus only: remembered option to pre-select just the parts you missed.
  let missedRow = null;
  if (type === 'bonus') {
    const missedCount = partResults ? partResults.filter((ok) => ok === false).length : 0;
    const note = !partResults
      ? 'Play this bonus in the Reader first to know which parts you missed.'
      : missedCount === 0 ? 'You got every part of this bonus right.' : `You missed ${missedCount} of ${partResults.length} parts.`;
    missedRow = h('label', { class: 'row gap-s wrap missed-only' },
      h('input', { type: 'checkbox', checked: !!prefs.onlyMissed, disabled: !partResults, onChange: (e) => {
        prefs.onlyMissed = e.target.checked;
        saveDb();
        if (prefs.onlyMissed) applyMissedFilter();
        else drafts.forEach((d) => (d.include = true));
        renderDrafts();
      } }),
      h('span', null, 'Only the parts I got wrong'),
      h('span', { class: 'muted small' }, `— ${note}`));
  }

  const save = () => {
    const deckId = deckSel.value;
    if (!deckId || deckId === '__new') return toast('Pick or create a deck first', 'error');
    const chosen = drafts.filter((d) => d.include && clozeNumbers(d.text).length);
    if (!chosen.length) return toast('Nothing to add — each card needs at least one cloze', 'error');
    for (const d of chosen) addNote({ deckId, text: d.text.trim(), extra: extra.value.trim(), source: sourceOf(q, type) });
    prefs.deckId = deckId;
    saveDb();
    toast(`Added ${chosen.length} note${chosen.length === 1 ? '' : 's'} to ${db.decks.find((x) => x.id === deckId)?.name}`);
    m.close();
  };

  const body = h('div', { class: 'stack' },
    h('div', { class: 'muted small' }, qMeta(q)),
    h('div', { class: 'row wrap gap-s' }, h('b', null, 'Template:'), $btns),
    missedRow,
    h('div', { class: 'row wrap gap-s' },
      h('button', { class: 'btn small', onClick: () => lastFocused && wrapSelection(lastFocused) }, '[…] Cloze selection'),
      h('button', { class: 'btn small', onClick: () => lastFocused && wrapSelection(lastFocused, true) }, '[…] Same number'),
      h('button', { class: 'btn small ghost', onClick: () => { drafts.forEach((d) => (d.include = true)); renderDrafts(); } }, 'Select all'),
      h('button', { class: 'btn small ghost', onClick: () => { drafts.forEach((d) => (d.include = false)); renderDrafts(); } }, 'Select none'),
      h('button', { class: 'btn small ghost', onClick: () => { drafts.push({ text: '', part: null, include: true }); renderDrafts(); } }, '＋ Blank draft')),
    list,
    h('label', { class: 'field' }, h('span', null, 'Back extra (shown after reveal)'), extra),
    h('div', { class: 'row between wrap' },
      h('label', { class: 'row gap-s' }, h('span', null, 'Deck'), deckSel),
      h('div', { class: 'row gap-s' }, count, h('button', { class: 'btn primary', onClick: save }, 'Add to deck'))));

  const m = modal('Make cloze cards', body, { wide: true });
  use(strats[templates[type]] ? templates[type] : Object.keys(strats)[0]);
}
