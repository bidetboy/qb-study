// Search (query + lookup by ID), Packets, Frequency lists, Saved questions, and Stats.
import { h, toast, confirmDialog, download, fmtDate, CATEGORIES, shuffle } from './util.js';
import { api, filterParams } from './api.js';
import { db, save } from './store.js';
import { questionCard } from './qview.js';
import { openConverter } from './convert.js';
import { startReader } from './reader.js';
import { filterPanel, difficultyChips } from './filters.js';

const practice = (q, type) => startReader({ type, questions: [q], label: 'Single question' });
const cardActions = { cards: openConverter, practice };

/* ================= Search ================= */

const S = {
  queryString: '', questionType: 'all', searchType: 'all', setName: '',
  exactPhrase: false, ignoreWordOrder: false, regex: false, caseSensitive: false, randomize: false,
  filters: { subcategories: [], difficulties: [], minYear: '', maxYear: '' },
  tossupPage: 1, bonusPage: 1, perPage: 25, result: null, loading: false,
};

export function searchFor(queryString, searchType = 'answer') {
  Object.assign(S, { queryString, searchType, tossupPage: 1, bonusPage: 1, result: null });
  location.hash = '#/search';
  setTimeout(() => runSearch());
}

let searchEls = null;

async function runSearch() {
  if (!searchEls) return;
  S.loading = true;
  paintResults();
  try {
    S.result = await api.query({
      queryString: S.queryString,
      questionType: S.questionType,
      searchType: S.searchType,
      setName: S.setName,
      exactPhrase: S.exactPhrase || undefined,
      ignoreWordOrder: S.ignoreWordOrder || undefined,
      regex: S.regex || undefined,
      caseSensitive: S.caseSensitive || undefined,
      randomize: S.randomize || undefined,
      maxReturnLength: S.perPage,
      tossupPagination: S.tossupPage,
      bonusPagination: S.bonusPage,
      ...filterParams(S.filters),
    });
  } catch (e) {
    S.result = { error: e.message };
  }
  S.loading = false;
  paintResults();
}

function pager(kind, count) {
  const pages = Math.max(1, Math.ceil(count / S.perPage));
  const key = kind === 'tossup' ? 'tossupPage' : 'bonusPage';
  if (pages <= 1) return null;
  return h('div', { class: 'row gap-s pager' },
    h('button', { class: 'btn tiny', disabled: S[key] <= 1, onClick: () => { S[key]--; runSearch(); } }, '‹ Prev'),
    h('span', { class: 'muted small' }, `Page ${S[key]} of ${pages}`),
    h('button', { class: 'btn tiny', disabled: S[key] >= pages, onClick: () => { S[key]++; runSearch(); } }, 'Next ›'));
}

function paintResults() {
  const box = searchEls?.results;
  if (!box) return;
  box.replaceChildren();
  if (S.loading) return box.append(h('div', { class: 'empty muted' }, 'Searching…'));
  const r = S.result;
  if (!r) return;
  if (r.error) return box.append(h('div', { class: 'empty warn' }, r.error));
  for (const [kind, data] of [['tossup', r.tossups], ['bonus', r.bonuses]]) {
    if (!data || (S.questionType !== 'all' && S.questionType !== kind)) continue;
    const arr = data.questionArray || [];
    box.append(h('section', { class: 'results-section' },
      h('div', { class: 'row between wrap' },
        h('h3', null, `${kind === 'tossup' ? 'Tossups' : 'Bonuses'} `, h('span', { class: 'muted' }, `(${data.count})`)),
        h('div', { class: 'row gap-s' },
          arr.length > 0 && h('button', { class: 'btn small', onClick: () => startReader({ type: kind, questions: arr, label: `Search: ${S.queryString || 'results'} (page)` }) }, `▶ Practice this page`),
          pager(kind, data.count))),
      arr.length ? arr.map((q) => questionCard(q, kind, cardActions)) : h('p', { class: 'muted' }, 'No matches.'),
      pager(kind, data.count)));
  }
}

export function renderSearch(main) {
  const qInput = h('input', { class: 'input big grow', placeholder: 'Search questions and answers…', value: S.queryString, onInput: (e) => (S.queryString = e.target.value) });
  const sel = (key, opts) => h('select', { class: 'input', onChange: (e) => (S[key] = e.target.value) },
    opts.map(([v, l]) => h('option', { value: v, selected: S[key] === v }, l)));
  const chk = (key, label) => h('label', null, h('input', { type: 'checkbox', checked: S[key], onChange: (e) => (S[key] = e.target.checked) }), ' ', label);

  const setInput = h('input', { class: 'input', placeholder: 'Set name (optional)', list: 'set-list', value: S.setName, onInput: (e) => (S.setName = e.target.value) });
  const datalist = h('datalist', { id: 'set-list' });
  api.setList().then((sets) => datalist.append(...sets.map((s) => h('option', { value: s })))).catch(() => {});

  const advanced = h('details', { class: 'panel' }, h('summary', null, 'Filters & options'),
    h('div', { class: 'row wrap gap', style: 'margin:10px 0' },
      chk('exactPhrase', 'Exact phrase'), chk('ignoreWordOrder', 'Ignore word order'), chk('regex', 'Regex'),
      chk('caseSensitive', 'Case sensitive'), chk('randomize', 'Randomize order'),
      h('label', { class: 'row gap-s' }, 'Per page', h('select', { class: 'input', onChange: (e) => (S.perPage = Number(e.target.value)) },
        [10, 25, 50].map((n) => h('option', { value: n, selected: S.perPage === n }, n))))),
    filterPanel(S.filters));

  const results = h('div');
  searchEls = { results };

  // Lookup by ID (GET /tossup, GET /bonus)
  const idInput = h('input', { class: 'input', placeholder: 'Question ID' });
  const idType = h('select', { class: 'input' }, h('option', { value: 'tossup' }, 'Tossup'), h('option', { value: 'bonus' }, 'Bonus'));
  const idResult = h('div');
  const lookup = async (e) => {
    e.preventDefault();
    const id = idInput.value.trim();
    if (!id) return;
    idResult.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    try {
      const q = idType.value === 'tossup' ? await api.tossup(id) : await api.bonus(id);
      idResult.replaceChildren(q ? questionCard(q, idType.value, cardActions) : h('div', { class: 'warn' }, 'Not found'));
    } catch (err) {
      idResult.replaceChildren(h('div', { class: 'warn' }, err.message));
    }
  };

  main.append(
    h('h2', null, 'Search the database'),
    h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); S.tossupPage = 1; S.bonusPage = 1; runSearch(); } },
      h('div', { class: 'row gap-s' }, qInput, h('button', { class: 'btn primary' }, 'Search')),
      h('div', { class: 'row wrap gap-s' },
        sel('searchType', [['all', 'Question & answer'], ['question', 'Question text'], ['answer', 'Answer line']]),
        sel('questionType', [['all', 'Tossups & bonuses'], ['tossup', 'Tossups'], ['bonus', 'Bonuses']]),
        setInput, datalist),
      advanced),
    results,
    h('details', { class: 'panel', style: 'margin-top:24px' }, h('summary', null, 'Open a question by ID'),
      h('form', { class: 'row gap-s wrap', style: 'margin-top:10px', onSubmit: lookup }, idType, idInput, h('button', { class: 'btn' }, 'Open')),
      idResult));

  paintResults();
  setTimeout(() => qInput.focus());
  return { cleanup() { searchEls = null; } };
}

/* ================= Packets ================= */

const P = { setName: '', numPackets: null, packetNumber: null, data: null, error: '' };

export function renderPackets(main) {
  const datalist = h('datalist', { id: 'set-list-p' });
  const setInput = h('input', { class: 'input grow', list: 'set-list-p', placeholder: 'Start typing a set name, e.g. 2024 ACF Regionals', value: P.setName });
  const allSets = h('div', { class: 'set-browser' });
  const packetsBox = h('div');
  const view = h('div');

  api.setList().then((sets) => {
    datalist.append(...sets.map((s) => h('option', { value: s })));
    const byYear = {};
    for (const s of sets) (byYear[s.slice(0, 4)] ||= []).push(s);
    allSets.replaceChildren(h('details', { class: 'panel' }, h('summary', null, `Browse all ${sets.length} sets`),
      Object.keys(byYear).sort().reverse().map((y) => h('div', { class: 'year-group' }, h('b', null, y), ' ',
        byYear[y].map((s) => h('button', { class: 'linkish', onClick: () => { setInput.value = s; loadSet(); } }, s.replace(/^\d{4} /, '')))))));
  }).catch((e) => allSets.replaceChildren(h('div', { class: 'warn' }, e.message)));

  const paintPacket = () => {
    view.replaceChildren();
    if (P.error) return view.append(h('div', { class: 'warn' }, P.error));
    if (!P.data) return;
    const { tossups = [], bonuses = [] } = P.data;
    const label = `${P.setName} · Packet ${P.packetNumber}`;
    view.append(
      h('div', { class: 'row wrap gap-s', style: 'margin:12px 0' },
        h('h3', { class: 'grow' }, label, P.data.packet?.name && h('span', { class: 'muted' }, ` (${P.data.packet.name})`)),
        h('button', { class: 'btn primary small', disabled: !tossups.length, onClick: () => startReader({ type: 'tossup', questions: tossups, label: `${label} tossups` }) }, `▶ Play ${tossups.length} tossups`),
        h('button', { class: 'btn small', disabled: !bonuses.length, onClick: () => startReader({ type: 'bonus', questions: bonuses, label: `${label} bonuses` }) }, `▶ Play ${bonuses.length} bonuses`)),
      h('details', { open: true }, h('summary', null, h('b', null, `Tossups (${tossups.length})`)), tossups.map((q) => questionCard(q, 'tossup', cardActions))),
      h('details', null, h('summary', null, h('b', null, `Bonuses (${bonuses.length})`)), bonuses.map((q) => questionCard(q, 'bonus', cardActions))));
  };

  const loadPacket = async (n) => {
    P.packetNumber = n;
    P.error = '';
    P.data = null;
    paintPackets();
    view.replaceChildren(h('div', { class: 'muted' }, 'Loading packet…'));
    try { P.data = await api.packet(P.setName, n); } catch (e) { P.error = e.message; }
    paintPackets();
    paintPacket();
  };

  const paintPackets = () => {
    packetsBox.replaceChildren();
    if (P.numPackets == null) return;
    if (!P.numPackets) return packetsBox.append(h('div', { class: 'warn' }, `No packets found for “${P.setName}”. Check the exact set name.`));
    packetsBox.append(h('div', { class: 'row wrap gap-s', style: 'margin-top:12px' },
      h('span', { class: 'muted' }, `${P.numPackets} packets:`),
      Array.from({ length: P.numPackets }, (_, i) => h('button', { class: `btn tiny ${P.packetNumber === i + 1 ? 'on' : ''}`, onClick: () => loadPacket(i + 1) }, String(i + 1)))));
  };

  const loadSet = async (e) => {
    e?.preventDefault();
    P.setName = setInput.value.trim();
    if (!P.setName) return;
    P.numPackets = null; P.packetNumber = null; P.data = null; P.error = '';
    packetsBox.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    view.replaceChildren();
    try { P.numPackets = await api.numPackets(P.setName); } catch (err) { P.numPackets = 0; }
    paintPackets();
  };

  main.append(
    h('h2', null, 'Packets'),
    h('form', { class: 'row gap-s', onSubmit: loadSet }, setInput, datalist, h('button', { class: 'btn primary' }, 'Load set')),
    allSets, packetsBox, view);
  paintPackets();
  paintPacket();
  if (!P.setName) setInput.focus();
}

/* ================= Frequency list ================= */

const F = { level: 'subcategory', category: 'Literature', subcategory: 'American Literature', questionType: 'all', limit: 50, difficulties: [], list: null, error: '' };

export function renderFrequency(main) {
  const out = h('div');
  const catSel = h('select', { class: 'input' });
  const fill = () => {
    catSel.replaceChildren(...(F.level === 'category'
      ? Object.keys(CATEGORIES).map((c) => h('option', { value: c, selected: c === F.category }, c))
      : Object.entries(CATEGORIES).map(([c, subs]) => h('optgroup', { label: c }, subs.map((s) => h('option', { value: s, selected: s === F.subcategory }, s))))));
  };
  catSel.addEventListener('change', () => { F[F.level] = catSel.value; });
  fill();

  const diffBox = difficultyChips(F.difficulties);

  const run = async (e) => {
    e?.preventDefault();
    out.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    try {
      F.list = await api.frequencyList({
        [F.level]: F[F.level], questionType: F.questionType === 'all' ? undefined : F.questionType, limit: F.limit, difficulties: F.difficulties,
      });
      F.error = '';
    } catch (err) { F.error = err.message; F.list = null; }
    paint();
  };

  const paint = () => {
    out.replaceChildren();
    if (F.error) return out.append(h('div', { class: 'warn' }, F.error));
    if (!F.list) return;
    const max = Math.max(1, ...F.list.map((x) => x.count));
    out.append(h('table', { class: 'table freq' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Answer'), h('th', null, 'Count'), h('th', null, ''))),
      h('tbody', null, F.list.map((x, i) => h('tr', null,
        h('td', { class: 'muted' }, i + 1),
        h('td', null, x.answer),
        h('td', null, h('div', { class: 'bar-cell' }, h('div', { class: 'bar', style: `width:${(x.count / max) * 100}%` }), h('span', null, x.count))),
        h('td', { class: 'row gap-s end' },
          h('button', { class: 'btn tiny', onClick: () => searchFor(x.answer, 'answer') }, 'Find questions'),
          h('button', { class: 'btn tiny ghost', onClick: () => practiceAnswer(x.answer) }, '▶ Practice')))))));
  };

  const practiceAnswer = async (answer) => {
    try {
      const r = await api.query({ queryString: answer, searchType: 'answer', questionType: 'tossup', maxReturnLength: 50, randomize: true });
      const qs = r.tossups?.questionArray || [];
      if (!qs.length) return toast('No tossups found for that answer');
      startReader({ type: 'tossup', questions: shuffle(qs), label: `Answer: ${answer}` });
    } catch (e) { toast(e.message, 'error'); }
  };

  main.append(
    h('h2', null, 'Frequency lists'),
    h('p', { class: 'muted' }, 'The most common answers in the database — a great checklist for what to learn next.'),
    h('form', { class: 'stack', onSubmit: run },
      h('div', { class: 'row wrap gap-s' },
        h('select', { class: 'input', onChange: (e) => { F.level = e.target.value; fill(); } },
          h('option', { value: 'subcategory', selected: F.level === 'subcategory' }, 'By subcategory'),
          h('option', { value: 'category', selected: F.level === 'category' }, 'By category')),
        catSel,
        h('select', { class: 'input', onChange: (e) => (F.questionType = e.target.value) },
          [['all', 'Tossups & bonuses'], ['tossup', 'Tossups'], ['bonus', 'Bonuses']].map(([v, l]) => h('option', { value: v, selected: F.questionType === v }, l))),
        h('label', { class: 'row gap-s' }, 'Top', h('input', { class: 'input year', type: 'number', min: 1, max: 400, value: F.limit, onChange: (e) => (F.limit = Number(e.target.value) || 50) })),
        h('button', { class: 'btn primary' }, 'Show')),
      diffBox),
    out);
  paint();
}

/* ================= Saved ================= */

const V = { text: '', type: 'all', tag: '', category: '' };

export function renderSaved(main) {
  const list = h('div');
  const tagSel = h('select', { class: 'input' });
  const catSel = h('select', { class: 'input', onChange: (e) => { V.category = e.target.value; paint(); } },
    h('option', { value: '' }, 'All categories'), Object.keys(CATEGORIES).map((c) => h('option', { value: c, selected: V.category === c }, c)));

  const filtered = () => db.saved.filter((s) =>
    (V.type === 'all' || s.type === V.type) &&
    (!V.tag || s.tags?.includes(V.tag)) &&
    (!V.category || s.data.category === V.category) &&
    (!V.text || JSON.stringify([s.data.question_sanitized, s.data.answer_sanitized, s.data.leadin_sanitized, s.data.parts_sanitized, s.data.answers_sanitized, s.note, s.tags]).toLowerCase().includes(V.text.toLowerCase())));

  const paintTags = () => {
    const tags = [...new Set(db.saved.flatMap((s) => s.tags || []))].sort();
    tagSel.replaceChildren(h('option', { value: '' }, 'All tags'), ...tags.map((t) => h('option', { value: t, selected: V.tag === t }, t)));
  };
  tagSel.addEventListener('change', () => { V.tag = tagSel.value; paint(); });

  const paint = () => {
    paintTags();
    const items = filtered();
    const tus = items.filter((s) => s.type === 'tossup').map((s) => s.data);
    const bs = items.filter((s) => s.type === 'bonus').map((s) => s.data);
    list.replaceChildren(
      h('div', { class: 'row wrap gap-s', style: 'margin:12px 0' },
        h('span', { class: 'muted grow' }, `${items.length} of ${db.saved.length} saved`),
        h('button', { class: 'btn small primary', disabled: !tus.length, onClick: () => startReader({ type: 'tossup', questions: shuffle(tus), label: 'Saved tossups' }) }, `▶ Practice ${tus.length} tossups`),
        h('button', { class: 'btn small', disabled: !bs.length, onClick: () => startReader({ type: 'bonus', questions: shuffle(bs), label: 'Saved bonuses' }) }, `▶ Practice ${bs.length} bonuses`),
        h('button', { class: 'btn small ghost', onClick: () => download('qb-saved-questions.json', JSON.stringify(items, null, 2)) }, 'Export')),
      ...(items.length ? items.map((s) => {
        const tagsInput = h('input', { class: 'input small', placeholder: 'tags, comma separated', value: (s.tags || []).join(', '),
          onChange: (e) => { s.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); save(); paintTags(); } });
        const noteInput = h('textarea', { class: 'input small', rows: 1, placeholder: 'Personal note…', value: s.note || '',
          onChange: (e) => { s.note = e.target.value; save(); } });
        const card = questionCard(s.data, s.type, { ...cardActions, extra: h('button', { class: 'btn small ghost', onClick: async () => { if (await confirmDialog('Remove this saved question?', 'Remove')) { db.saved = db.saved.filter((x) => x !== s); save(); paint(); } } }, 'Remove') });
        // replace the save toggle (redundant here) with tag + note editors
        card.querySelector('.btn').remove();
        card.append(h('div', { class: 'row wrap gap-s saved-meta' }, h('span', { class: 'muted small' }, `Saved ${fmtDate(s.savedAt)}`), tagsInput, noteInput));
        return card;
      }) : [h('div', { class: 'empty muted' }, db.saved.length ? 'Nothing matches these filters.' : 'No saved questions yet. Press S (or ☆ Save) in the reader, search or packets.')]));
  };

  main.append(
    h('h2', null, 'Saved questions'),
    h('div', { class: 'row wrap gap-s' },
      h('input', { class: 'input grow', placeholder: 'Filter saved…', value: V.text, onInput: (e) => { V.text = e.target.value; paint(); } }),
      h('select', { class: 'input', onChange: (e) => { V.type = e.target.value; paint(); } },
        [['all', 'All types'], ['tossup', 'Tossups'], ['bonus', 'Bonuses']].map(([v, l]) => h('option', { value: v, selected: V.type === v }, l))),
      catSel, tagSel),
    list);
  paint();
}

/* ================= Stats ================= */

export function renderStats(main) {
  const tus = db.history.filter((e) => e.type === 'tossup');
  const bs = db.history.filter((e) => e.type === 'bonus');

  const tuRows = Object.keys(CATEGORIES).map((cat) => {
    const list = tus.filter((e) => e.category === cat);
    if (!list.length) return null;
    const c = (p) => list.filter((e) => e.points === p).length;
    const pts = list.reduce((s, e) => s + e.points, 0);
    const correct = list.filter((e) => e.correct);
    const cel = correct.length ? correct.reduce((s, e) => s + e.celerity, 0) / correct.length : 0;
    return h('tr', null, h('td', null, cat), h('td', null, list.length), h('td', null, c(15)), h('td', null, c(10)), h('td', null, c(-5)),
      h('td', null, `${Math.round((correct.length / list.length) * 100)}%`), h('td', null, (pts / list.length).toFixed(2)), h('td', null, cel.toFixed(2)));
  }).filter(Boolean);

  const bRows = Object.keys(CATEGORIES).map((cat) => {
    const list = bs.filter((e) => e.category === cat);
    if (!list.length) return null;
    const parts = [0, 1, 2].map((i) => list.filter((e) => e.parts?.[i]).length);
    return h('tr', null, h('td', null, cat), h('td', null, list.length),
      h('td', null, (list.reduce((s, e) => s + e.points, 0) / list.length).toFixed(2)),
      h('td', null, parts.map((p) => `${Math.round((p / list.length) * 100)}%`).join(' / ')));
  }).filter(Boolean);

  const recent = [...db.history].reverse().slice(0, 100);
  const openQ = async (e) => {
    try {
      const q = e.type === 'tossup' ? await api.tossup(e.qid) : await api.bonus(e.qid);
      startReader({ type: e.type, questions: [q], label: 'From history' });
    } catch (err) { toast(err.message, 'error'); }
  };

  main.append(h('div', null,
    h('div', { class: 'row between wrap' }, h('h2', null, 'Reader stats'),
      db.history.length > 0 && h('button', { class: 'btn small ghost', onClick: async () => { if (await confirmDialog('Clear all reader history? Card review data is not affected.', 'Clear')) { db.history = []; save(); location.reload(); } } }, 'Clear history')),
    !db.history.length && h('div', { class: 'empty muted' }, 'Play some questions in the Reader and your stats will appear here.'),
    tuRows.length > 0 && h('section', null, h('h3', null, `Tossups (${tus.length})`),
      h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Category', 'Heard', '15', '10', '-5', 'Correct', 'PPTU', 'Avg celerity'].map((t) => h('th', null, t)))), h('tbody', null, tuRows))),
    bRows.length > 0 && h('section', null, h('h3', null, `Bonuses (${bs.length})`),
      h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Category', 'Heard', 'PPB', 'Part conversion'].map((t) => h('th', null, t)))), h('tbody', null, bRows))),
    recent.length > 0 && h('section', null, h('h3', null, 'Recent'),
      h('table', { class: 'table' }, h('tbody', null, recent.map((e) => h('tr', null,
        h('td', { class: 'muted small' }, fmtDate(e.ts)),
        h('td', null, h('span', { class: `pill ${e.type}` }, e.type)),
        h('td', null, e.category),
        h('td', null, e.type === 'tossup' ? (e.answer || '').split(/[\[(]/)[0] : (e.set || '')),
        h('td', null, e.type === 'tossup' ? (e.buzzed ? (e.correct ? `+${e.points}` : String(e.points)) : '—') : `${e.points}`),
        h('td', null, h('button', { class: 'btn tiny ghost', onClick: () => openQ(e) }, 'Replay')))))))));
}
