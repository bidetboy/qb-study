// Entry point: router + deck management, card editor, and study (review) screen.
import { h, $, $$, toast, confirmDialog, promptDialog, download, fmtDate, modal } from './util.js';
import {
  db, loadDb, save, flush, replaceDb, createDeck, getDeck, deleteDeck, addNote, updateNote, deleteNote, getNote,
  deckCounts, nextCard, nextDueTime, gradeCard, undoGrade, reviewsToday, storageMode,
  resetDb, refreshFromCloud, hasUnsaved,
} from './store.js';
import {
  authEnabled, currentUser, signIn, signUp, signOut, usernameOf, changePassword,
  generateRecoveryCode, setRecoveryCode, hasRecoveryCode, resetPassword,
} from './auth.js';
import { renderCloze, stripCloze, clozeNumbers, wrapSelection, clozeKeyHandler } from './cloze.js';
import { previewLabels, fmtSpan } from './srs.js';
import { deckSelect } from './convert.js';
import { renderReader } from './reader.js';
import { renderSearch, renderPackets, renderFrequency, renderSaved, renderStats } from './browse.js';
import { initThemeToggle } from './theme.js';

const main = $('#main');
initThemeToggle($('#theme-toggle'));

/* ================= Decks ================= */

function renderDecks(el) {
  const counts = (id) => deckCounts(id);
  const all = counts('all');
  const row = (id, name, c, isAll = false) => h('tr', null,
    h('td', null, isAll ? h('b', null, name) : h('a', { href: `#/deck/${id}` }, name)),
    h('td', { class: 'num new' }, c.new), h('td', { class: 'num learn' }, c.learn), h('td', { class: 'num due' }, c.review),
    h('td', { class: 'row gap-s end' },
      h('button', { class: 'btn small primary', disabled: !(c.new + c.learn + c.review), onClick: () => (location.hash = `#/study/${id}`) }, 'Study'),
      !isAll && h('button', { class: 'btn small', onClick: () => (location.hash = `#/add/${id}`) }, '＋ Add')));

  const nameInput = h('input', { class: 'input', placeholder: 'New deck name' });
  el.append(
    h('div', { class: 'row between wrap' },
      h('h2', null, 'Decks'),
      h('span', { class: 'muted small' }, `${reviewsToday()} reviews today · ${db.cards.length} cards total`)),
    db.decks.length
      ? h('table', { class: 'table decks' },
          h('thead', null, h('tr', null, h('th', null, 'Deck'), h('th', { class: 'num' }, 'New'), h('th', { class: 'num' }, 'Learn'), h('th', { class: 'num' }, 'Due'), h('th', null, ''))),
          h('tbody', null, db.decks.map((d) => row(d.id, d.name, counts(d.id))), db.decks.length > 1 && row('all', 'All decks', all, true)))
      : h('div', { class: 'empty' },
          h('p', null, 'No decks yet. Create one below, then add your own cloze cards, or turn QB Reader questions into cards from the Reader, Search or Packets pages.')),
    h('form', { class: 'row gap-s', style: 'margin-top:16px', onSubmit: (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      createDeck(name);
      route();
    } }, nameInput, h('button', { class: 'btn primary' }, 'Create deck')),
    settingsPanel());
}

function settingsPanel() {
  const fileInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none', onChange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.decks)) throw new Error('Not a QB Study backup file');
      if (!(await confirmDialog('Replace ALL current data with this backup?', 'Replace'))) return;
      replaceDb(data);
      await flush();
      toast('Backup restored');
      route();
    } catch (err) { toast(err.message, 'error'); }
  } });
  return h('details', { class: 'panel', style: 'margin-top:32px' }, h('summary', null, 'Settings & data'),
    h('div', { class: 'stack', style: 'margin-top:10px' },
      storageMode === 'cloud' && accountSection(),
      h('label', { class: 'row gap-s' }, 'New cards per day (per deck)',
        h('input', { class: 'input year', type: 'number', min: 0, max: 9999, value: db.settings.newPerDay,
          onChange: (e) => { db.settings.newPerDay = Math.max(0, Number(e.target.value) || 0); save(); } })),
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn small', onClick: () => download(`qb-study-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db)) }, 'Export everything (JSON)'),
        h('button', { class: 'btn small', onClick: () => fileInput.click() }, 'Restore from backup…'), fileInput),
      h('p', { class: 'muted small' }, {
        cloud: 'Your progress is saved to your account and syncs across devices when you log in.',
        server: 'Data is saved to data/db.json next to the app, with a daily backup in data/backups/.',
      }[storageMode] ?? 'Your data is stored in this browser on this device only. Export a backup now and then — clearing site data or switching browsers starts fresh.')));
}

function accountSection() {
  const changePw = async () => {
    const pw = await promptDialog('New password (at least 6 characters)', '', 'Next', 'password');
    if (!pw) return;
    const again = await promptDialog('Type the new password again', '', 'Change password', 'password');
    if (again == null) return;
    if (pw !== again) return toast('Passwords do not match', 'error');
    try { await changePassword(pw); toast('Password changed'); } catch (err) { toast(err.message, 'error'); }
  };
  const newCode = async () => {
    if (!(await confirmDialog('Make a new recovery code? Your old code will stop working.', 'Make new code'))) return;
    await issueRecoveryCode('Here is your new recovery code. Your old one no longer works.');
  };
  return h('div', { class: 'stack account-box' },
    h('b', null, 'Account'),
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn small', onClick: changePw }, 'Change password'),
      h('button', { class: 'btn small', onClick: newCode }, 'New recovery code')),
    h('p', { class: 'muted small' }, 'If you forget your password, your recovery code lets you reset it from the login screen.'));
}

/* ================= Deck browser ================= */

function renderDeck(el, id) {
  const deck = getDeck(id);
  if (!deck) { el.append(h('p', null, 'Deck not found. ', h('a', { href: '#/decks' }, 'Back to decks'))); return; }
  let filter = '';
  const list = h('div');
  const c = deckCounts(id);

  const cardInfo = (note) => {
    const cards = db.cards.filter((x) => x.noteId === note.id);
    const now = Date.now();
    return cards.map((x) => {
      const label = x.state === 'new' ? 'new' : x.due <= now ? 'due' : `in ${fmtSpan(x.due - now)}`;
      return h('span', { class: `pill state-${x.state}`, title: `c${x.ord} · ${x.state} · ${x.reps} reviews · ${x.lapses} lapses` }, `c${x.ord} ${label}`);
    });
  };

  const paint = () => {
    const notes = db.notes.filter((n) => n.deckId === id && (!filter || (n.text + ' ' + n.extra).toLowerCase().includes(filter.toLowerCase())))
      .sort((a, b) => b.created - a.created);
    list.replaceChildren(notes.length
      ? h('div', { class: 'note-list' }, notes.map((n) => h('div', { class: 'note-row' },
          h('div', { class: 'grow' },
            h('div', { class: 'note-text', html: renderCloze(n.text, 0, 'preview') }),
            h('div', { class: 'row wrap gap-s small' }, cardInfo(n),
              n.source && h('span', { class: 'muted' }, `from ${n.source.set ?? 'QB Reader'}${n.source.packet != null ? ` P${n.source.packet}` : ''}`))),
          h('div', { class: 'row gap-s' },
            h('button', { class: 'btn tiny', onClick: () => (location.hash = `#/edit/${n.id}`) }, 'Edit'),
            h('button', { class: 'btn tiny ghost', onClick: async () => { if (await confirmDialog('Delete this note and its cards?')) { deleteNote(n.id); paint(); } } }, 'Delete')))))
      : h('div', { class: 'empty muted' }, filter ? 'No notes match.' : 'No cards yet.'));
  };

  el.append(
    h('div', { class: 'row between wrap gap' },
      h('div', null, h('a', { href: '#/decks', class: 'muted small' }, '‹ Decks'), h('h2', null, deck.name)),
      h('div', { class: 'row gap-s wrap' },
        h('span', { class: 'muted' }, h('span', { class: 'new' }, c.new), ' new · ', h('span', { class: 'learn' }, c.learn), ' learn · ', h('span', { class: 'due' }, c.review), ' due'),
        h('button', { class: 'btn primary', disabled: !(c.new + c.learn + c.review), onClick: () => (location.hash = `#/study/${id}`) }, 'Study'),
        h('button', { class: 'btn', onClick: () => (location.hash = `#/add/${id}`) }, '＋ Add card'),
        h('button', { class: 'btn ghost', onClick: async () => { const name = await promptDialog('Rename deck', deck.name); if (name) { deck.name = name; save(); route(); } } }, 'Rename'),
        h('button', { class: 'btn ghost', onClick: () => download(`${deck.name}.json`, JSON.stringify({ deck, notes: db.notes.filter((n) => n.deckId === id) }, null, 2)) }, 'Export'),
        h('button', { class: 'btn ghost danger', onClick: async () => { if (await confirmDialog(`Delete “${deck.name}” and all its cards?`)) { deleteDeck(id); location.hash = '#/decks'; } } }, 'Delete'))),
    h('input', { class: 'input', placeholder: 'Search notes in this deck…', onInput: (e) => { filter = e.target.value; paint(); } }),
    list);
  paint();
}

/* ================= Editor ================= */

function renderEditor(el, { note = null, deckId = null }) {
  const isEdit = !!note;
  const deckSel = deckSelect(note?.deckId ?? deckId ?? db.decks[0]?.id);
  const text = h('textarea', { class: 'input mono', rows: 6, placeholder: 'e.g. The {{c1::Treaty of Westphalia}} ended the {{c2::Thirty Years’ War}} in {{c3::1648}}.', value: note?.text ?? '' });
  const extra = h('textarea', { class: 'input', rows: 3, placeholder: 'Optional extra info shown on the back', value: note?.extra ?? '' });
  const preview = h('div', { class: 'preview' });
  const info = h('div', { class: 'muted small' });
  const sync = () => {
    preview.innerHTML = renderCloze(text.value, 0, 'preview') || '<span class="muted">Preview</span>';
    const n = clozeNumbers(text.value).length;
    info.textContent = n ? `${n} card${n === 1 ? '' : 's'} will be generated` : 'Add at least one cloze: select text and press Alt+C';
  };
  text.addEventListener('input', sync);
  text.addEventListener('keydown', clozeKeyHandler);
  sync();

  const submit = () => {
    if (!db.decks.length || !deckSel.value || deckSel.value === '__new') return toast('Create a deck first', 'error');
    if (!clozeNumbers(text.value).length) return toast('Add at least one cloze deletion', 'error');
    if (isEdit) {
      updateNote(note, { text: text.value.trim(), extra: extra.value.trim(), deckId: deckSel.value });
      toast('Saved');
      history.back();
    } else {
      addNote({ deckId: deckSel.value, text: text.value.trim(), extra: extra.value.trim() });
      toast('Added');
      text.value = '';
      extra.value = '';
      sync();
      text.focus();
    }
  };

  el.append(
    h('a', { href: isEdit ? `#/deck/${note.deckId}` : (deckId ? `#/deck/${deckId}` : '#/decks'), class: 'muted small' }, '‹ Back'),
    h('h2', null, isEdit ? 'Edit note' : 'Add cloze note'),
    h('div', { class: 'stack' },
      h('label', { class: 'row gap-s' }, 'Deck', deckSel),
      h('div', { class: 'row wrap gap-s' },
        h('button', { class: 'btn small', onClick: () => wrapSelection(text) }, '[…] Cloze', h('kbd', null, 'Alt C')),
        h('button', { class: 'btn small', onClick: () => wrapSelection(text, true) }, '[…] Same number', h('kbd', null, 'Alt ⇧ C')),
        h('span', { class: 'muted small' }, 'Hints: {{c1::answer::hint}}')),
      text, info,
      h('div', null, h('div', { class: 'label' }, 'Preview'), preview),
      h('label', { class: 'field' }, h('span', null, 'Back extra'), extra),
      note?.source && h('div', { class: 'muted small' }, `Source: ${[note.source.set, note.source.packet != null && `Packet ${note.source.packet}`, note.source.number != null && `#${note.source.number}`, note.source.id].filter(Boolean).join(' · ')}`),
      h('div', { class: 'row gap-s end' },
        h('span', { class: 'muted small' }, '⌘/Ctrl+Enter to save'),
        h('button', { class: 'btn primary', onClick: submit }, isEdit ? 'Save changes' : 'Add note'))));
  setTimeout(() => text.focus());
  return { onKey(e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { submit(); return true; } return false; } };
}

/* ================= Study ================= */

function renderStudy(el, deckId) {
  const deck = deckId === 'all' ? { name: 'All decks' } : getDeck(deckId);
  if (!deck) { el.append(h('p', null, 'Deck not found.')); return; }
  let card = null;
  let showing = false;
  let undo = null;
  let studied = 0;

  const head = h('div', { class: 'row between wrap' });
  const stage = h('div', { class: 'study-card' });
  const foot = h('div', { class: 'study-foot' });

  const paintHead = () => {
    const c = deckCounts(deckId);
    head.replaceChildren(
      h('div', null, h('a', { href: deckId === 'all' ? '#/decks' : `#/deck/${deckId}`, class: 'muted small' }, '‹ ' + deck.name), h('h2', null, 'Study')),
      h('div', { class: 'row gap-s' },
        h('span', { class: 'count new', title: 'New' }, c.new), h('span', { class: 'count learn', title: 'Learning' }, c.learn), h('span', { class: 'count due', title: 'Due' }, c.review),
        undo && h('button', { class: 'btn tiny ghost', onClick: doUndo }, 'Undo', h('kbd', null, 'U'))));
  };

  const paint = () => {
    paintHead();
    stage.replaceChildren();
    foot.replaceChildren();
    if (!card) {
      const nd = nextDueTime(deckId);
      stage.append(h('div', { class: 'empty' },
        h('h3', null, studied ? 'Nice work — you’re done for now.' : 'Nothing due right now.'),
        nd && nd > Date.now() && h('p', { class: 'muted' }, `Next card due ${fmtDate(nd)}.`),
        h('a', { class: 'btn', href: '#/decks' }, 'Back to decks')));
      return;
    }
    const note = getNote(card.noteId);
    stage.append(h('div', { class: 'card-face', html: renderCloze(note.text, card.ord, showing ? 'back' : 'front') }));
    if (showing && note.extra) stage.append(h('div', { class: 'card-extra', html: renderCloze(note.extra, 0, 'preview') }));
    stage.append(h('div', { class: 'row between muted small card-tools' },
      h('span', null, card.state === 'new' ? 'New card' : `${card.state} · ${card.reps} reviews`),
      h('a', { href: `#/edit/${note.id}` }, 'Edit (E)')));
    if (!showing) {
      foot.append(h('button', { class: 'btn primary big', onClick: () => { showing = true; paint(); } }, 'Show answer', h('kbd', null, 'Space')));
    } else {
      const labels = previewLabels(card);
      foot.append(h('div', { class: 'grades' }, ['Again', 'Hard', 'Good', 'Easy'].map((name, i) =>
        h('button', { class: `btn grade g${i + 1}`, onClick: () => grade(i + 1) },
          h('span', { class: 'small muted' }, labels[i]), h('span', null, name), h('kbd', null, String(i + 1))))));
    }
  };

  const advance = () => {
    card = nextCard(deckId);
    showing = false;
    paint();
  };

  const grade = (g) => {
    if (!card || !showing) return;
    undo = gradeCard(card.id, g);
    studied++;
    advance();
  };

  const doUndo = () => {
    if (!undo) return;
    undoGrade(undo);
    card = db.cards.find((c) => c.id === undo.id);
    showing = true;
    undo = null;
    studied = Math.max(0, studied - 1);
    paint();
  };

  el.append(head, stage, foot);
  advance();

  return {
    onKey(e, typing) {
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'enter') && card && !showing) { showing = true; paint(); return true; }
      if (k === ' ' && showing) { grade(3); return true; }
      if (['1', '2', '3', '4'].includes(k)) { grade(Number(k)); return true; }
      if (k === 'u') { doUndo(); return true; }
      if (k === 'e' && card) { location.hash = `#/edit/${card.noteId}`; return true; }
      return false;
    },
  };
}

/* ================= Router ================= */

const routes = [
  [/^#\/decks$/, (el) => renderDecks(el)],
  [/^#\/deck\/([^/]+)$/, (el, id) => renderDeck(el, id)],
  [/^#\/study\/([^/]+)$/, (el, id) => renderStudy(el, id)],
  [/^#\/add(?:\/([^/]+))?$/, (el, id) => renderEditor(el, { deckId: id })],
  [/^#\/edit\/([^/]+)$/, (el, id) => {
    const note = getNote(id);
    if (!note) { el.append(h('p', null, 'Note not found.')); return; }
    return renderEditor(el, { note });
  }],
  [/^#\/reader$/, (el) => renderReader(el)],
  [/^#\/search$/, (el) => renderSearch(el)],
  [/^#\/packets$/, (el) => renderPackets(el)],
  [/^#\/frequency$/, (el) => renderFrequency(el)],
  [/^#\/saved$/, (el) => renderSaved(el)],
  [/^#\/stats$/, (el) => renderStats(el)],
];

let view = null;

function route() {
  view?.cleanup?.();
  view = null;
  const hash = location.hash || '#/decks';
  main.replaceChildren();
  window.scrollTo(0, 0);
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      view = fn(main, ...m.slice(1).map((x) => (x == null ? x : decodeURIComponent(x)))) || null;
      break;
    }
  }
  if (!view && !routes.some(([re]) => re.test(hash))) { location.hash = '#/decks'; return; }
  const section = hash.split('/')[1];
  const navKey = ['deck', 'study', 'add', 'edit'].includes(section) ? 'decks' : section;
  $$('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${navKey}`));
}

document.addEventListener('keydown', (e) => {
  if ($('.overlay')) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.matches('input, textarea, select') || t.isContentEditable);
  // A view returns true when it used the key as a shortcut; stop the browser's default action so the
  // key isn't also typed into an input the shortcut just focused (or scroll the page, for Space).
  if (view?.onKey?.(e, typing)) e.preventDefault();
});

/* ================= Accounts ================= */

let ready = false;

// Shows a recovery code and resolves once the user confirms they saved it.
function showRecoveryCode(code, intro) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); m.close(); } };
    const ok = h('button', { class: 'btn primary', disabled: true, onClick: finish }, 'Continue');
    const text = `QB Study recovery code\nUsername: ${$('#user-box')?.dataset.username || ''}\nCode: ${code}\n\nUse this on the login screen (Forgot password?) to reset your password. It works once; you will get a new one after using it.\n`;
    const m = modal('Save your recovery code', h('div', { class: 'stack' },
      h('p', null, intro),
      h('div', { class: 'recovery-code' }, code),
      h('div', { class: 'row gap-s wrap' },
        h('button', { class: 'btn small', onClick: () => navigator.clipboard?.writeText(code).then(() => toast('Copied')) }, 'Copy'),
        h('button', { class: 'btn small', onClick: () => download('qb-study-recovery-code.txt', text) }, 'Download .txt')),
      h('p', { class: 'muted small' }, 'This is the only way to get back in if you forget your password. It won’t be shown again.'),
      h('label', { class: 'row gap-s' }, h('input', { type: 'checkbox', onChange: (e) => { ok.disabled = !e.target.checked; } }), 'I saved my recovery code'),
      h('div', { class: 'row end' }, ok)),
      { onClose: () => { if (!done) { done = true; resolve(); } } });
  });
}

async function issueRecoveryCode(intro) {
  const code = generateRecoveryCode();
  try {
    await setRecoveryCode(code);
  } catch (err) {
    toast(`Could not create a recovery code: ${err.message}`, 'error');
    return;
  }
  await showRecoveryCode(code, intro);
}

function renderLogin(message = '') {
  ready = false;
  view?.cleanup?.();
  view = null;
  document.body.classList.add('logged-out');
  $('#user-box').replaceChildren();
  let mode = 'login'; // 'login' | 'signup' | 'reset'
  const username = h('input', { class: 'input', autocomplete: 'username', placeholder: 'Username', autocapitalize: 'none', spellcheck: false });
  const code = h('input', { class: 'input mono', placeholder: 'Recovery code (XXXX-XXXX-XXXX-XXXX)', autocapitalize: 'characters', spellcheck: false, autocomplete: 'off' });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Confirm password' });
  const error = h('div', { class: 'warn small' }, message);
  const submit = h('button', { class: 'btn primary big' });
  const tabs = h('div', { class: 'segmented' });
  const hint = h('p', { class: 'muted small' });
  const forgot = h('button', { type: 'button', class: 'linkish', onClick: () => setMode(mode === 'reset' ? 'login' : 'reset') });

  const setMode = (m) => { mode = m; error.textContent = ''; paint(); };

  const paint = () => {
    tabs.replaceChildren(...[['login', 'Log in'], ['signup', 'Create account']].map(([m, label]) =>
      h('button', { type: 'button', class: `seg ${mode === m ? 'on' : ''}`, onClick: () => setMode(m) }, label)));
    tabs.style.display = mode === 'reset' ? 'none' : '';
    code.style.display = mode === 'reset' ? '' : 'none';
    confirm.style.display = mode === 'login' ? 'none' : '';
    password.placeholder = mode === 'reset' ? 'New password' : 'Password';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    submit.textContent = { login: 'Log in', signup: 'Create account', reset: 'Reset password' }[mode];
    forgot.textContent = mode === 'reset' ? '‹ Back to log in' : 'Forgot password?';
    forgot.style.display = mode === 'signup' ? 'none' : '';
    hint.textContent = {
      login: 'Your decks, cards, saved questions and stats load on any device you log in from.',
      signup: 'Usernames are 3–24 letters, numbers or _. No email needed — you’ll get a recovery code to reset your password if you forget it.',
      reset: 'Enter the recovery code you saved when you created your account (or your latest one from Settings).',
    }[mode];
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (mode !== 'login' && password.value !== confirm.value) { error.textContent = 'Passwords do not match.'; return; }
    submit.disabled = true;
    submit.textContent = 'One moment…';
    try {
      if (mode === 'login') {
        await startApp(await signIn(username.value, password.value));
      } else if (mode === 'signup') {
        const user = await signUp(username.value, password.value);
        await startApp(user, { newAccount: true });
      } else {
        const { user, newCode } = await resetPassword(username.value, code.value, password.value);
        await startApp(user, { skipRecoveryCheck: true });
        toast('Password reset — you’re logged in');
        await showRecoveryCode(newCode, 'Your old recovery code has been used up. Here is your new one:');
      }
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      paint();
    }
  };

  main.replaceChildren(h('div', { class: 'login' },
    h('h2', null, 'QB Study'),
    h('p', { class: 'muted' }, 'Quiz bowl reader + cloze flashcards. Log in to keep your progress across devices.'),
    tabs,
    h('form', { class: 'stack', onSubmit }, username, code, password, confirm, error, submit),
    forgot,
    hint));
  paint();
  username.focus();
}

async function startApp(user, { newAccount = false, skipRecoveryCheck = false } = {}) {
  if (user) {
    main.replaceChildren(h('div', { class: 'empty muted' }, 'Loading your data…'));
    try {
      await loadDb(user);
    } catch (err) {
      return renderLogin(`Could not load your data: ${err.message}`);
    }
    const name = usernameOf(user);
    const box = $('#user-box');
    box.dataset.username = name;
    box.replaceChildren(
      h('span', { class: 'muted small' }, name),
      h('button', { class: 'btn tiny ghost', onClick: logout }, 'Log out'));
  } else {
    await loadDb();
  }
  document.body.classList.remove('logged-out');
  ready = true;
  if (!location.hash || location.hash === '#/login') location.hash = '#/decks';
  else route();

  if (user && newAccount) {
    await issueRecoveryCode('Welcome! If you ever forget your password, this code lets you reset it. Keep it somewhere safe.');
  } else if (user && !skipRecoveryCheck) {
    // Accounts created before recovery codes existed get one now.
    const has = await hasRecoveryCode().catch(() => true);
    if (!has) await issueRecoveryCode('Your account doesn’t have a recovery code yet. Save this one so you can reset your password if you forget it.');
  }
}

async function logout() {
  await flush();
  if (hasUnsaved() && !(await confirmDialog('Some changes have not reached the server yet. Log out anyway?', 'Log out'))) return;
  await signOut();
  resetDb();
  renderLogin();
}

window.addEventListener('hashchange', () => { if (ready) route(); });
window.addEventListener('pagehide', () => flush());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { flush(); return; }
  if (!ready || storageMode !== 'cloud') return;
  try {
    if (await refreshFromCloud()) { toast('Loaded your latest progress from another device'); route(); }
  } catch { /* offline: keep working locally */ }
});

if (authEnabled) {
  const user = await currentUser().catch(() => null);
  if (user) await startApp(user);
  else renderLogin();
} else {
  await startApp(null);
}
