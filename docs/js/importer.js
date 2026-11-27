// Import screen: make cloze notes from a text file or pasted text, split by a separator you choose.
import { h, toast, debounce } from './util.js?v=a368a4df';
import { db, save, createDeck, getDeck, notesInDeck, addNotes } from './store.js?v=a368a4df';
import { renderCloze, clozeNumbers, clozeAnswers } from './cloze.js?v=a368a4df';
import { deckPicker, deckNames } from './convert.js?v=a368a4df';
import { parseNotes, dupKey } from './delimited.js?v=a368a4df';

const QUOTES = 'Text inside "double quotes" stays together.';
const SEPS = [
  ['line', 'New line', 'Each line is one note. Empty lines are ignored.'],
  ['blank', 'Blank line', 'Notes are separated by empty lines, so one note can run over several lines.'],
  ['tab', 'Tab', `Like a .tsv file from a spreadsheet: every cell is a note. ${QUOTES}`],
  ['comma', 'Comma', `Like a .csv file from a spreadsheet: every cell is a note. ${QUOTES}`],
  ['semicolon', 'Semicolon', `A semicolon ends each note. ${QUOTES}`],
  ['custom', 'Custom', 'Type the exact text that sits between your notes, like --- or ||. Spaces count.'],
];
// Whether a line break also ends a note, for the separators where you can choose.
const LINE_BREAKS = { tab: true, comma: true, semicolon: true, custom: false };

// Other ways a doc can mark clozes. delimited.js turns them into {{c1::…}}.
const MARKERS = [
  ['none', 'Only {{c1::…}}', 'Clozes are written {{c1::answer}}, with c2, c3, … for more cards from the same note.'],
  ['brackets', '[ … ]', 'Each [part in square brackets] becomes a cloze.'],
  ['braces', '{ … }', 'Each {part in curly braces} becomes a cloze.'],
  ['double', '{{ … }}', 'Each {{part in double braces}} without a c-number becomes a cloze.'],
  ['custom', 'Custom', 'Type what comes right before and right after each cloze, like << and >>.'],
];
const KEEP = ' Notes that already use {{c1::…}} are left as they are, so brackets in them stay plain text.';

const SKIPPED = {
  nocloze: 'Skipped: no cloze',
  marked: 'Skipped: no {{c1::…}} cloze. If [brackets] or {braces} mark your clozes, pick that in step 3',
  broken: 'Skipped: the cloze isn’t written right. Use {{c1::answer}}',
  indeck: 'Skipped: already in the deck',
  repeat: 'Skipped: same as an earlier note',
};

const SHOW_MAX = 200;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fromDocs = 'In Google Docs, use File → Download → Plain text (.txt).';

// What you pasted or loaded. Kept while you visit other pages, cleared after an import.
const draft = { text: '', fileName: '' };

// Read a text file, guessing its encoding, and turn away files that aren't plain text.
async function readTextFile(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  const starts = (...bytes) => bytes.every((x, i) => b[i] === x);
  if (starts(0xff, 0xfe)) return new TextDecoder('utf-16le').decode(b);
  if (starts(0xfe, 0xff)) return new TextDecoder('utf-16be').decode(b);
  const head = new TextDecoder().decode(b.subarray(0, 64)).trimStart().toLowerCase();
  if (starts(0x50, 0x4b, 0x03, 0x04)) throw new Error(`That’s a Word document or another zipped file, not plain text. ${fromDocs}`);
  if (head.startsWith('%pdf')) throw new Error(`That’s a PDF, not plain text. ${fromDocs}`);
  if (head.startsWith('{\\rtf')) throw new Error(`That’s a rich text (.rtf) file, not plain text. ${fromDocs}`);
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) throw new Error(`That’s a web page, not plain text. ${fromDocs}`);
  if (b.subarray(0, 4096).includes(0)) throw new Error(`That doesn’t look like a text file. ${fromDocs}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1252').decode(b); }
}

export function renderImport(el, deckId = null) {
  const home = deckId && getDeck(deckId) ? deckId : null;
  const p = db.settings.importer || {};
  const opts = {
    sep: SEPS.some(([k]) => k === p.sep) ? p.sep : 'line',
    custom: p.custom || '',
    lineBreaks: { ...LINE_BREAKS, ...p.lineBreaks },
    stripBullets: p.stripBullets !== false,
    markers: MARKERS.some(([k]) => k === p.markers) ? p.markers : 'none',
    open: p.open || '',
    close: p.close || '',
    together: !!p.together,
    skipDupes: p.skipDupes !== false,
  };
  let target = home ? 'existing' : 'new';
  let parsed = [];
  let view = 'all'; // preview: 'all' pieces, each card ('cards'), or 'skipped'
  let autoName = '';

  /* 1. the text */
  const text = h('textarea', { class: 'input mono', rows: 10, spellcheck: false, value: draft.text,
    placeholder: 'The {{c1::Treaty of Westphalia}} ended the {{c2::Thirty Years’ War}} in {{c3::1648}}.\n{{c1::Virginia Woolf}} wrote {{c2::Mrs Dalloway}}.' });
  text.addEventListener('input', () => { draft.text = text.value; updateSoon(); });
  const fileNote = h('span', { class: 'muted small' });
  const paintFile = () => { fileNote.textContent = draft.fileName ? `Loaded ${draft.fileName}. You can edit the text below.` : 'or paste your notes below'; };
  const found = h('div', { class: 'small muted' });

  const loadFile = async (f) => {
    if (!f) return;
    try { draft.text = text.value = await readTextFile(f); }
    catch (err) { toast(err.message, 'error'); return; }
    draft.fileName = f.name;
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'csv') opts.sep = 'comma';
    if (ext === 'tsv') opts.sep = 'tab';
    const base = f.name.replace(/\.[^.]+$/, '');
    if (!nameInput.value.trim() || nameInput.value === autoName) nameInput.value = autoName = base;
    paintFile();
    paintSep();
    update();
  };
  const fileInput = h('input', { type: 'file', style: 'display:none',
    accept: '.txt,.text,.csv,.tsv,.md,text/plain,text/csv,text/tab-separated-values',
    onChange: (e) => { loadFile(e.target.files[0]); e.target.value = ''; } });

  /* 2. the separator */
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Separator' });
  const sepHint = h('div', { class: 'muted small' });
  const custom = h('input', { class: 'input mono sep-input', placeholder: 'e.g. ---', value: opts.custom, 'aria-label': 'Custom separator',
    onInput: (e) => { opts.custom = e.target.value; updateSoon(); } });
  const lineBox = h('input', { type: 'checkbox', onChange: (e) => { opts.lineBreaks[opts.sep] = e.target.checked; update(); } });
  const lineRow = h('label', { class: 'row gap-s' }, lineBox, 'A line break also starts a new note');
  const paintSep = () => {
    seg.replaceChildren(...SEPS.map(([k, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(opts.sep === k),
      class: `seg${opts.sep === k ? ' on' : ''}`, onClick: () => setSep(k) }, label)));
    sepHint.textContent = SEPS.find(([k]) => k === opts.sep)[2];
    custom.style.display = opts.sep === 'custom' ? '' : 'none';
    lineRow.style.display = opts.sep in LINE_BREAKS ? '' : 'none';
    lineBox.checked = !!opts.lineBreaks[opts.sep];
  };
  const setSep = (k) => {
    opts.sep = k;
    paintSep();
    update();
    if (k === 'custom') custom.focus();
  };
  const bullets = h('label', { class: 'row gap-s' },
    h('input', { type: 'checkbox', checked: opts.stripBullets, onChange: (e) => { opts.stripBullets = e.target.checked; update(); } }),
    'Remove bullets and numbering (•, *, 1.) at the start of each note');

  /* 3. how clozes are marked */
  const markSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'How clozes are marked' });
  const markHint = h('div', { class: 'muted small' });
  const markInput = (key, placeholder, label) => h('input', { class: 'input mono mark-input', placeholder, value: opts[key], 'aria-label': label,
    onInput: (e) => { opts[key] = e.target.value; updateSoon(); } });
  const openIn = markInput('open', '<<', 'Each cloze starts with');
  const closeIn = markInput('close', '>>', 'Each cloze ends with');
  const customMarks = h('div', { class: 'row wrap gap-s' }, 'Starts with', openIn, 'and ends with', closeIn);
  const togetherRow = h('label', { class: 'row gap-s' },
    h('input', { type: 'checkbox', checked: opts.together, onChange: (e) => { opts.together = e.target.checked; update(); } }),
    'Hide all of a note’s marked parts on one card (instead of a card for each)');
  const paintMarks = () => {
    markSeg.replaceChildren(...MARKERS.map(([k, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(opts.markers === k),
      class: `seg${opts.markers === k ? ' on' : ''}`, onClick: () => setMarks(k) }, label)));
    markHint.textContent = MARKERS.find(([k]) => k === opts.markers)[2] + (opts.markers === 'none' ? '' : KEEP);
    customMarks.style.display = opts.markers === 'custom' ? '' : 'none';
    togetherRow.style.display = opts.markers === 'none' ? 'none' : '';
  };
  const setMarks = (k) => {
    opts.markers = k;
    paintMarks();
    update();
    if (k === 'custom') openIn.focus();
  };

  /* 4. where the notes go */
  const nameInput = h('input', { class: 'input', placeholder: 'New deck name', 'aria-label': 'New deck name', onFocus: () => setTarget('new') });
  if (draft.fileName) nameInput.value = autoName = draft.fileName.replace(/\.[^.]+$/, '');
  const picker = deckPicker(home ? [home] : [], () => update());
  const radio = (k) => h('input', { type: 'radio', name: 'import-target', checked: target === k, onChange: () => setTarget(k) });
  const newRadio = radio('new');
  const oldRadio = radio('existing');
  const oldRow = h('label', { class: 'row gap-s' }, oldRadio, 'Decks I already have');
  const paintTarget = () => {
    newRadio.checked = target === 'new';
    oldRadio.checked = target === 'existing';
    oldRow.style.display = db.decks.length ? '' : 'none';
    picker.el.style.display = target === 'existing' ? '' : 'none';
  };
  const setTarget = (k) => {
    if (target === k) return;
    target = k;
    paintTarget();
    update();
  };
  const dupes = h('label', { class: 'row gap-s' },
    h('input', { type: 'checkbox', checked: opts.skipDupes, onChange: (e) => { opts.skipDupes = e.target.checked; update(); } }),
    'Skip duplicates: notes already in the deck, or repeated in the text');

  /* preview */
  const previewHead = h('h3', { class: 'preview-head' }, 'Preview');
  const summary = h('div', { class: 'grow' });
  const go = h('button', { class: 'btn primary', onClick: () => doImport() }, 'Import');
  const viewBar = h('div', { class: 'row wrap gap-s' });
  const list = h('div', { class: 'note-list' });

  const existingKeys = () => {
    const keys = new Set();
    if (opts.skipDupes && target === 'existing') {
      for (const id of picker.value) for (const n of notesInDeck(id)) keys.add(dupKey(n.text));
    }
    return keys;
  };
  // Something still to type before the text can be split, or ''.
  const waiting = () => (opts.sep === 'custom' && !opts.custom ? 'Type the separator your notes use (step 2).'
    : opts.markers === 'custom' && !(opts.open && opts.close) ? 'Type what comes before and after each cloze (step 3).' : '');

  // One piece of text: the note with every cloze highlighted, or why it's skipped.
  const noteRow = (e) => h('div', { class: `note-row import-row${e.skip ? ' skipped' : ''}` },
    h('span', { class: 'import-num muted small' }, e.n),
    h('div', { class: 'grow' },
      h('div', { class: 'note-text', html: renderCloze(e.text, 0, 'preview') }),
      h('div', { class: `small ${e.skip || e.warn ? 'warn' : 'muted'}` },
        e.skip ? SKIPPED[e.skip] : plural(e.cards, 'card') + (e.warn ? ' · check the cloze: there’s a stray {{ or }}' : ''))));

  // One card as it will look when you study it: its cloze hidden, with the answer underneath.
  const cardRow = (e, ord) => h('div', { class: 'note-row import-row' },
    h('span', { class: 'import-num muted small' }, e.n),
    h('div', { class: 'grow' },
      h('div', { class: 'note-text', html: renderCloze(e.text, ord, 'front') }),
      h('div', { class: 'small muted' }, `Card c${ord} · answer: `, h('span', { class: 'cloze' }, clozeAnswers(e.text, ord).join(' · ')))));

  const paintPreview = () => {
    const ok = parsed.filter((e) => !e.skip);
    const skipped = parsed.length - ok.length;
    const cards = ok.reduce((a, e) => a + e.cards, 0);
    const count = (k) => parsed.filter((e) => e.skip === k).length;
    const wait = waiting();
    go.disabled = !ok.length;
    go.textContent = ok.length ? `Import ${plural(ok.length, 'note')}` : 'Import';
    if (!text.value.trim()) {
      summary.replaceChildren(h('span', { class: 'muted' }, 'Choose a file or paste your notes to see a preview.'));
      found.replaceChildren();
    } else if (wait) {
      summary.replaceChildren(h('span', { class: 'warn' }, wait));
      found.replaceChildren(h('span', { class: 'warn' }, wait));
    } else {
      const why = [
        count('nocloze') && `${count('nocloze')} without a cloze`,
        count('marked') && `${count('marked')} using [ ] or { } (see step 3)`,
        count('broken') && `${count('broken')} with a broken cloze`,
        count('indeck') && `${count('indeck')} already in the deck`,
        count('repeat') && `${count('repeat')} repeated`,
      ].filter(Boolean);
      summary.replaceChildren(
        h('b', null, `${plural(ok.length, 'note')} → ${plural(cards, 'card')}`),
        why.length ? h('span', { class: 'muted' }, ` · skipping ${why.join(', ')}`) : '');
      found.replaceChildren(`Found ${plural(ok.length, 'note')} (${plural(cards, 'card')})${skipped ? `, skipped ${skipped}` : ''}. `,
        h('button', { type: 'button', class: 'linkish', onClick: () => previewHead.scrollIntoView({ behavior: 'smooth' }) }, 'Check the preview ↓'));
    }
    if ((view === 'cards' && !cards) || (view === 'skipped' && !skipped)) view = 'all';
    const tab = (k, label) => h('button', { type: 'button', class: `seg${view === k ? ' on' : ''}`, onClick: () => { view = k; paintPreview(); } }, label);
    viewBar.replaceChildren(parsed.length ? h('div', { class: 'segmented' },
      tab('all', `All (${parsed.length})`),
      cards ? tab('cards', `Each card (${cards})`) : '',
      skipped ? tab('skipped', `Skipped (${skipped})`) : '') : '');
    // Rows are built lazily: a long import only renders what's shown.
    const rows = view === 'cards'
      ? ok.flatMap((e) => clozeNumbers(e.text).map((ord) => () => cardRow(e, ord)))
      : parsed.filter((e) => view === 'all' || e.skip).map((e) => () => noteRow(e));
    list.replaceChildren(...rows.slice(0, SHOW_MAX).map((make) => make()),
      rows.length > SHOW_MAX ? h('div', { class: 'muted small' }, `Showing the first ${SHOW_MAX} of ${rows.length}.`) : '');
  };

  const update = () => {
    const { sep, custom: c, stripBullets, skipDupes, markers, open, close, together } = opts;
    parsed = waiting() ? [] : parseNotes(text.value,
      { sep, custom: c, lineBreaks: !!opts.lineBreaks[sep], stripBullets, skipDupes, markers, open, close, together }, existingKeys());
    parsed.forEach((e, i) => { e.n = i + 1; });
    paintPreview();
  };
  const updateSoon = debounce(update, 200);

  const doImport = () => {
    update();
    const ok = parsed.filter((e) => !e.skip);
    if (!ok.length) return toast('Nothing to import: no notes with a cloze', 'error');
    let deckIds;
    if (target === 'new') {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return toast('Give the new deck a name', 'error'); }
      deckIds = [createDeck(name).id];
    } else {
      deckIds = picker.value;
      if (!deckIds.length) return toast('Pick a deck to add the notes to', 'error');
    }
    addNotes(ok.map((e) => e.text), deckIds);
    const { sep, custom: c, lineBreaks, stripBullets, markers, open, close, together, skipDupes } = opts;
    db.settings.importer = { sep, custom: c, lineBreaks: { ...lineBreaks }, stripBullets, markers, open, close, together, skipDupes };
    save();
    draft.text = '';
    draft.fileName = '';
    const cards = ok.reduce((a, e) => a + e.cards, 0);
    toast(`Imported ${plural(ok.length, 'note')} (${plural(cards, 'card')}) into ${deckNames(deckIds)}`);
    location.hash = `#/deck/${deckIds[0]}`;
  };

  // Dropping a file anywhere on the page loads it (instead of the browser opening the file).
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const page = h('div', { class: 'import-page',
    onDragover: (e) => { if (hasFiles(e)) { e.preventDefault(); page.classList.add('dropping'); } },
    onDragleave: (e) => { if (e.target === page || !page.contains(e.relatedTarget)) page.classList.remove('dropping'); },
    onDrop: (e) => { if (!hasFiles(e)) return; e.preventDefault(); page.classList.remove('dropping'); loadFile(e.dataTransfer.files[0]); } },
    home ? h('a', { href: `#/deck/${home}`, class: 'muted small' }, `‹ ${getDeck(home).name}`) : h('a', { href: '#/decks', class: 'muted small' }, '‹ Decks'),
    h('h2', null, 'Import cloze notes'),
    h('p', { class: 'muted' }, 'Already have cloze cards in a Google Doc or another file? Bring them in all at once. Each piece of text between separators becomes one note, with a card for each cloze: {{c1::answer}}, or your own marks like [answer]. Pieces without a cloze, like headings, are skipped. The preview at the bottom shows every card before you import.'),
    h('section', { class: 'panel import-step' },
      h('h3', null, '1. Your notes'),
      h('div', { class: 'row wrap gap-s' }, h('button', { class: 'btn', onClick: () => fileInput.click() }, 'Choose a file…'), fileNote, fileInput),
      h('p', { class: 'muted small' }, 'From Google Docs: File → Download → Plain text (.txt). Or select everything in the doc, copy it, and paste it here.'),
      text, found),
    h('section', { class: 'panel import-step' },
      h('h3', null, '2. What separates one note from the next?'),
      h('div', { class: 'row wrap gap-s' }, seg, custom),
      sepHint, lineRow, bullets),
    h('section', { class: 'panel import-step' },
      h('h3', null, '3. How are your clozes marked?'),
      markSeg, customMarks, markHint, togetherRow),
    h('section', { class: 'panel import-step' },
      h('h3', null, '4. Where should the notes go?'),
      h('div', { class: 'row wrap gap-s' }, h('label', { class: 'row gap-s' }, newRadio, 'A new deck named'), nameInput),
      oldRow, picker.el, dupes),
    previewHead,
    h('div', { class: 'row wrap gap import-bar' }, summary, go),
    viewBar,
    list);

  el.append(page);
  paintFile();
  paintSep();
  paintMarks();
  paintTarget();
  update();
}
