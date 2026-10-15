// QB Reader-style practice: word-by-word tossups with buzzing, and bonuses part by part.
import { h, esc, sanitizeHtml, toast } from './util.js';
import { api, filterParams } from './api.js';
import { db, save, addHistory, toggleSaved, isSaved } from './store.js';
import { checkAnswer } from './judge.js';
import { qMeta, statsBlock, saveButton } from './qview.js';
import { openConverter } from './convert.js';
import { filterPanel, filterSummary } from './filters.js';

const R = {
  type: 'tossup',
  source: { kind: 'random', label: 'Random' },
  queue: [],
  q: null,
  phase: 'idle',
  error: '',
  // tossup
  words: [], powerIdx: -1, idx: 0, timer: null, buzzIdx: null, given: '', prompts: 0, promptText: '', checking: false, entry: null,
  // bonus
  part: 0, revealed: false, guess: '', suggestion: null, results: [],
  session: [],
  showFilters: false,
  pendingStart: false,
};

let els = null; // mounted DOM refs

export function startReader({ type, questions, label }) {
  stopTimer();
  R.type = type;
  R.source = { kind: 'list', label };
  R.queue = [...questions];
  R.q = null;
  R.phase = 'idle';
  if (location.hash === '#/reader' && els) next();
  else { R.pendingStart = true; location.hash = '#/reader'; }
}

function stopTimer() { clearInterval(R.timer); R.timer = null; }

function startTimer() {
  stopTimer();
  R.timer = setInterval(tick, db.settings.readSpeed);
}

function tick() {
  if (R.idx >= R.words.length) {
    stopTimer();
    R.phase = 'waiting';
    paint();
    return;
  }
  R.idx++;
  if (els?.text) els.text.innerHTML = wordsHtml(R.idx);
}

function wordsHtml(upto, buzzAt = null) {
  let out = '';
  for (let i = 0; i < upto && i < R.words.length; i++) {
    if (buzzAt != null && i === buzzAt) out += '<span class="buzz-mark" title="Your buzz">🔔</span> ';
    const w = R.words[i];
    out += (w.includes('(*)') ? `<span class="power">${esc(w)}</span>` : esc(w)) + ' ';
  }
  if (buzzAt != null && buzzAt >= R.words.length) out += '<span class="buzz-mark" title="Your buzz">🔔</span>';
  return out;
}

async function fill() {
  if (R.queue.length || R.source.kind !== 'random') return;
  const p = {
    number: 10,
    ...filterParams(db.settings.filters),
    powermarkOnly: R.type === 'tossup' && db.settings.powermarkOnly ? true : undefined,
    standardOnly: db.settings.standardOnly ? true : undefined,
  };
  R.queue = R.type === 'tossup' ? await api.randomTossups(p) : await api.randomBonuses(p);
}

async function next() {
  stopTimer();
  R.phase = 'loading';
  paint();
  try {
    await fill();
  } catch (e) {
    R.phase = 'error';
    R.error = e.message;
    paint();
    return;
  }
  if (!R.queue.length) {
    R.phase = R.source.kind === 'random' ? 'error' : 'end';
    R.error = 'No questions match these filters.';
    paint();
    return;
  }
  R.q = R.queue.shift();
  R.entry = null;
  if (R.type === 'tossup') {
    R.words = String(R.q.question_sanitized ?? '').split(/\s+/).filter(Boolean);
    R.powerIdx = R.words.findIndex((w) => w.includes('(*)'));
    R.idx = 0;
    R.buzzIdx = null;
    R.given = '';
    R.prompts = 0;
    R.promptText = '';
    R.judgedLocally = false;
    R.checking = false;
    R.phase = 'reading';
    paint();
    startTimer();
  } else {
    R.part = 0;
    R.revealed = false;
    R.guess = '';
    R.suggestion = null;
    R.checking = false;
    R.results = [];
    R.phase = 'bonus';
    paint();
  }
}

/* ---------- tossup actions ---------- */

function buzz() {
  if (!['reading', 'paused', 'waiting'].includes(R.phase)) return;
  stopTimer();
  R.buzzIdx = R.idx;
  R.phase = 'buzzed';
  paint();
}

function togglePause() {
  if (R.phase === 'reading') { stopTimer(); R.phase = 'paused'; paint(); }
  else if (R.phase === 'paused') { R.phase = 'reading'; paint(); startTimer(); }
}

function tossupPoints(correct) {
  if (correct == null) return 0;
  if (correct) return R.powerIdx >= 0 && R.buzzIdx <= R.powerIdx ? 15 : 10;
  return R.buzzIdx < R.words.length ? -5 : 0;
}

async function submitAnswer(given) {
  if (R.checking) return;
  const q = R.q;
  R.given = given;
  R.checking = true;
  paint();
  const r = await checkAnswer(given, q.answer);
  if (R.q !== q || R.phase !== 'buzzed') return;
  R.checking = false;
  R.judgedLocally = !!r.local;
  if (r.directive === 'prompt' && R.prompts < 3) {
    R.prompts++;
    R.promptText = r.directedPrompt || 'Can you be more specific?';
    paint();
    return;
  }
  finishTossup(r.directive === 'accept');
}

function finishTossup(correct) {
  stopTimer();
  const buzzed = R.buzzIdx != null;
  const points = buzzed ? tossupPoints(correct) : 0;
  R.entry = addHistory({
    type: 'tossup', qid: R.q._id, category: R.q.category, subcategory: R.q.subcategory, difficulty: R.q.difficulty,
    set: R.q.set?.name, answer: R.q.answer_sanitized, given: R.given, buzzed,
    correct: buzzed ? correct : null, points,
    celerity: buzzed ? 1 - R.buzzIdx / Math.max(1, R.words.length) : 0,
  });
  R.session.push(R.entry);
  R.phase = 'answered';
  paint();
}

function overrideTossup() {
  const e = R.entry;
  if (!e || !e.buzzed) return;
  e.correct = !e.correct;
  e.points = tossupPoints(e.correct);
  save();
  paint();
}

/* ---------- bonus actions ---------- */

async function revealPart(guess = '') {
  if (R.phase !== 'bonus' || R.revealed || R.checking) return;
  const q = R.q;
  const part = R.part;
  R.guess = guess;
  R.suggestion = null;
  R.promptText = '';
  if (guess.trim()) {
    R.checking = true;
    paint();
    const r = await checkAnswer(guess, q.answers?.[part]);
    if (R.q !== q || R.part !== part) return;
    R.checking = false;
    if (r.directive === 'prompt') R.promptText = r.directedPrompt || 'more specific answer needed';
    R.suggestion = r.directive === 'accept';
  }
  R.revealed = true;
  paint();
}

function markPart(correct) {
  if (R.phase !== 'bonus' || !R.revealed) return;
  R.results.push(correct);
  R.revealed = false;
  R.guess = '';
  R.suggestion = null;
  R.part++;
  if (R.part >= (R.q.parts?.length || 0)) {
    const points = R.results.reduce((s, ok, i) => s + (ok ? (R.q.values?.[i] ?? 10) : 0), 0);
    R.entry = addHistory({
      type: 'bonus', qid: R.q._id, category: R.q.category, subcategory: R.q.subcategory, difficulty: R.q.difficulty,
      set: R.q.set?.name, parts: [...R.results], points,
    });
    R.session.push(R.entry);
    R.phase = 'answered';
  }
  paint();
}

function overrideBonusPart(i) {
  const e = R.entry;
  if (!e) return;
  e.parts[i] = !e.parts[i];
  e.points = e.parts.reduce((s, ok, j) => s + (ok ? (R.q.values?.[j] ?? 10) : 0), 0);
  R.results = [...e.parts];
  save();
  paint();
}

/* ---------- rendering ---------- */

function sessionLine() {
  const tus = R.session.filter((e) => e.type === 'tossup');
  const bs = R.session.filter((e) => e.type === 'bonus');
  const pts = tus.reduce((s, e) => s + e.points, 0);
  const c = (p) => tus.filter((e) => e.points === p).length;
  const bits = [];
  if (tus.length) bits.push(`${tus.length} TU · ${pts} pts · ${c(15)}/${c(10)}/${c(-5)} (15/10/-5) · PPTU ${(pts / tus.length).toFixed(1)}`);
  if (bs.length) bits.push(`${bs.length} bonuses · PPB ${(bs.reduce((s, e) => s + e.points, 0) / bs.length).toFixed(1)}`);
  return bits.join('   |   ') || 'Session stats appear here.';
}

function actionsRow() {
  return h('div', { class: 'row wrap gap-s' },
    saveButton(R.q, R.type),
    h('button', { class: 'btn small', onClick: () => openConverter(R.q, R.type, { results: R.type === 'bonus' ? R.entry?.parts : null }), title: 'C' }, '＋ Make cards'));
}

function paintTossup(stage) {
  const q = R.q;
  const p = R.phase;
  const meta = h('div', { class: 'q-meta' },
    p === 'answered' ? qMeta(q) : (db.settings.showCategory ? [q.category, q.subcategory].filter(Boolean).join(' / ') : ''));
  const text = h('div', { class: 'q-text reading', html: wordsHtml(p === 'answered' ? R.words.length : R.idx, p === 'answered' ? R.buzzIdx : (p === 'buzzed' ? R.idx : null)) });
  els.text = ['reading', 'paused'].includes(p) ? text : null;
  stage.append(meta, text);

  if (p === 'buzzed') {
    const input = h('input', { class: 'input big', placeholder: R.prompts ? 'Answer the prompt…' : 'Your answer, then Enter', autocomplete: 'off', value: R.checking ? R.given : '', disabled: R.checking });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitAnswer(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); finishTossup(false); }
    });
    stage.append(h('div', { class: 'answer-box' }, input,
      R.prompts > 0 && h('div', { class: 'warn' }, `Prompt on “${R.given}”: ${R.promptText}`),
      h('div', { class: 'muted small' }, R.checking ? 'Checking…' : 'Enter to submit · Esc to give up')));
    if (!R.checking) input.focus();
  }

  if (p === 'answered') {
    const e = R.entry;
    const verdict = !e.buzzed ? h('span', { class: 'verdict none' }, 'No buzz')
      : e.correct ? h('span', { class: 'verdict ok' }, `Correct  +${e.points}`)
      : h('span', { class: 'verdict bad' }, `Incorrect  ${e.points}`);
    stage.append(
      h('div', { class: 'result' },
        h('div', { class: 'row wrap gap-s' }, verdict,
          e.buzzed && h('span', { class: 'muted' }, `You said: “${e.given || '—'}”`),
          e.buzzed && R.judgedLocally && h('span', { class: 'muted small', title: 'QB Reader check-answer was unreachable' }, '(judged offline)'),
          e.buzzed && h('button', { class: 'btn tiny ghost', onClick: overrideTossup, title: 'O' }, e.correct ? 'Actually I was wrong' : 'Actually I was right')),
        h('div', { class: 'q-answer' }, h('span', { class: 'label' }, 'ANSWER: '), h('span', { html: sanitizeHtml(q.answer) }))),
      actionsRow(),
      statsBlock(q, 'tossup'));
  }

  const btns = h('div', { class: 'row wrap gap-s controls' });
  if (['reading', 'paused', 'waiting'].includes(p)) {
    btns.append(
      h('button', { class: 'btn primary', onClick: buzz }, 'Buzz', h('kbd', null, 'Space')),
      p !== 'waiting' ? h('button', { class: 'btn', onClick: togglePause }, p === 'paused' ? 'Resume' : 'Pause', h('kbd', null, 'P')) : '',
      h('button', { class: 'btn', onClick: () => finishTossup(null) }, 'Reveal', h('kbd', null, 'R')),
      h('button', { class: 'btn ghost', onClick: next }, 'Skip', h('kbd', null, 'N')));
  }
  if (p === 'answered') btns.append(h('button', { class: 'btn primary', onClick: next }, 'Next', h('kbd', null, 'Space / N')));
  stage.append(btns);
}

function paintBonus(stage) {
  const q = R.q;
  const done = R.phase === 'answered';
  stage.append(
    h('div', { class: 'q-meta' }, done ? qMeta(q) : (db.settings.showCategory ? [q.category, q.subcategory].filter(Boolean).join(' / ') : '')),
    h('div', { class: 'q-text', html: sanitizeHtml(q.leadin) }));
  const results = done ? R.entry.parts : R.results;
  (q.parts || []).forEach((part, i) => {
    if (!done && i > R.part) return;
    const box = h('div', { class: 'bonus-part' }, h('div', { class: 'q-text', html: `<span class="label">[${q.values?.[i] ?? 10}]</span> ` + sanitizeHtml(part) }));
    const finished = i < results.length;
    if (finished || (i === R.part && R.revealed)) {
      box.append(h('div', { class: 'q-answer' }, h('span', { class: 'label' }, 'ANSWER: '), h('span', { html: sanitizeHtml(q.answers?.[i]) })));
    }
    if (finished) {
      box.append(h('div', { class: 'row gap-s' },
        h('span', { class: `verdict ${results[i] ? 'ok' : 'bad'}` }, results[i] ? '✓ Got it' : '✗ Missed'),
        done && h('button', { class: 'btn tiny ghost', onClick: () => overrideBonusPart(i) }, 'Flip')));
    } else if (i === R.part && !R.revealed) {
      const input = h('input', { class: 'input', placeholder: R.checking ? 'Checking…' : 'Type your answer (optional), Enter to reveal', autocomplete: 'off', value: R.checking ? R.guess : '', disabled: R.checking });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); revealPart(input.value); } });
      box.append(h('div', { class: 'row gap-s' }, input, h('button', { class: 'btn', onClick: () => revealPart(input.value) }, 'Reveal', h('kbd', null, 'Enter'))));
      if (!R.checking) queueMicrotask(() => input.focus());
    } else if (i === R.part && R.revealed) {
      if (R.guess) box.append(h('div', { class: 'muted small' }, `You said “${R.guess}” — judged `, h('b', null, R.suggestion ? 'correct' : 'incorrect'),
        R.promptText && ` (would prompt: ${R.promptText})`));
      box.append(h('div', { class: 'row gap-s' },
        h('button', { class: `btn ${R.suggestion !== false ? 'primary' : ''}`, onClick: () => markPart(true) }, '✓ Got it', h('kbd', null, 'Y')),
        h('button', { class: `btn ${R.suggestion === false ? 'primary' : ''}`, onClick: () => markPart(false) }, '✗ Missed', h('kbd', null, 'N')),
        R.guess && h('span', { class: 'muted small' }, 'Enter accepts the verdict')));
    }
    stage.append(box);
  });
  if (done) {
    stage.append(
      h('div', { class: 'result' }, h('span', { class: 'verdict ok' }, `${R.entry.points} points`)),
      actionsRow(),
      statsBlock(q, 'bonus'),
      h('div', { class: 'row controls' }, h('button', { class: 'btn primary', onClick: next }, 'Next', h('kbd', null, 'Space'))));
  } else {
    stage.append(h('div', { class: 'row controls' }, h('button', { class: 'btn ghost', onClick: next }, 'Skip bonus')));
  }
}

function paint() {
  if (!els) return;
  const { stage, session, sourceLabel } = els;
  stage.replaceChildren();
  els.text = null;
  sourceLabel.replaceChildren(h('span', null,
    R.source.kind === 'random' ? `Random · ${filterSummary(db.settings.filters)}` : `${R.source.label} · ${R.queue.length} left`,
    R.source.kind !== 'random' && h('button', { class: 'btn tiny ghost', onClick: () => { R.source = { kind: 'random', label: 'Random' }; R.queue = []; next(); } }, 'Back to random')));
  session.textContent = sessionLine();

  if (R.phase === 'idle') {
    stage.append(h('div', { class: 'empty' }, h('p', null, 'Ready when you are.'), h('button', { class: 'btn primary', onClick: next }, 'Start', h('kbd', null, 'Space'))));
  } else if (R.phase === 'loading') {
    stage.append(h('div', { class: 'empty muted' }, 'Loading questions…'));
  } else if (R.phase === 'error') {
    stage.append(h('div', { class: 'empty' }, h('p', { class: 'warn' }, R.error), h('button', { class: 'btn', onClick: next }, 'Try again')));
  } else if (R.phase === 'end') {
    stage.append(h('div', { class: 'empty' }, h('p', null, `Finished “${R.source.label}”.`),
      h('button', { class: 'btn primary', onClick: () => { R.source = { kind: 'random', label: 'Random' }; next(); } }, 'Continue with random questions')));
  } else if (R.type === 'tossup') paintTossup(stage);
  else paintBonus(stage);
}

export function renderReader(main) {
  const typeBtns = ['tossup', 'bonus'].map((t) => h('button', {
    class: `seg ${R.type === t ? 'on' : ''}`,
    onClick: () => {
      if (R.type === t) return;
      stopTimer();
      R.type = t;
      R.queue = [];
      R.source = { kind: 'random', label: 'Random' };
      typeBtns.forEach((b, i) => b.classList.toggle('on', ['tossup', 'bonus'][i] === t));
      speedWrap.style.display = t === 'tossup' ? '' : 'none';
      next();
    },
  }, t === 'tossup' ? 'Tossups' : 'Bonuses'));

  const speedOut = h('span', { class: 'muted small' });
  const setSpeedLabel = () => { speedOut.textContent = `${Math.round(60000 / db.settings.readSpeed)} wpm`; };
  setSpeedLabel();
  const speed = h('input', {
    type: 'range', min: 60, max: 600, step: 10, value: String(660 - db.settings.readSpeed),
    onInput: (e) => {
      db.settings.readSpeed = 660 - Number(e.target.value);
      setSpeedLabel();
      save();
      if (R.timer) startTimer();
    },
  });
  const speedWrap = h('label', { class: 'row gap-s', style: R.type === 'tossup' ? '' : 'display:none' }, 'Speed', speed, speedOut);

  const filterBox = h('div', { class: 'panel', style: R.showFilters ? '' : 'display:none' });
  const applyFilters = () => { save(); R.queue = R.source.kind === 'random' ? [] : R.queue; paint(); };
  filterBox.append(
    filterPanel(db.settings.filters, applyFilters),
    h('div', { class: 'row wrap gap', style: 'margin-top:10px' },
      h('label', null, h('input', { type: 'checkbox', checked: db.settings.powermarkOnly, onChange: (e) => { db.settings.powermarkOnly = e.target.checked; applyFilters(); } }), ' Powermarked tossups only'),
      h('label', null, h('input', { type: 'checkbox', checked: db.settings.standardOnly, onChange: (e) => { db.settings.standardOnly = e.target.checked; applyFilters(); } }), ' Standard sets only'),
      h('label', null, h('input', { type: 'checkbox', checked: db.settings.showCategory, onChange: (e) => { db.settings.showCategory = e.target.checked; save(); paint(); } }), ' Show category while reading')),
    h('div', { class: 'muted small' }, 'Filter changes apply from the next question.'));

  const sourceLabel = h('div', { class: 'row gap-s muted small' });
  const stage = h('section', { class: 'stage' });
  const session = h('div', { class: 'session muted small' });

  main.append(
    h('div', { class: 'row between wrap gap' },
      h('div', { class: 'segmented' }, typeBtns),
      speedWrap,
      h('button', { class: 'btn small', onClick: () => { R.showFilters = !R.showFilters; filterBox.style.display = R.showFilters ? '' : 'none'; } }, '⚙ Filters')),
    filterBox,
    sourceLabel,
    stage,
    session,
    h('div', { class: 'muted small keys' }, 'Keys: Space buzz/next · P pause · R reveal · N skip/next · S save · C make cards · O override verdict · Y/N mark bonus part'));

  els = { stage, session, sourceLabel, text: null };

  if (R.pendingStart) { R.pendingStart = false; next(); }
  else {
    if (R.phase === 'reading') { R.phase = 'paused'; }
    paint();
  }

  return {
    cleanup() {
      stopTimer();
      if (R.phase === 'reading') R.phase = 'paused';
      els = null;
    },
    // Returns true when the key was used as a shortcut, so the caller stops the browser from also
    // typing it (otherwise e.g. "n" lands in the next bonus part's freshly focused answer box).
    onKey(e, typing) {
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      const bonusMarking = R.type === 'bonus' && R.phase === 'bonus' && R.revealed;
      if (k === ' ') {
        if (['idle', 'answered', 'end'].includes(R.phase)) next();
        else if (R.type === 'tossup') buzz();
        else if (R.phase === 'bonus' && !R.revealed) revealPart('');
        return true; // never let Space scroll the page or type into a new box
      }
      if (k === 'enter' && bonusMarking && R.suggestion != null) { markPart(R.suggestion); return true; }
      if (bonusMarking && (k === 'y' || k === '1')) { markPart(true); return true; }
      if (bonusMarking && (k === 'n' || k === '0')) { markPart(false); return true; }
      if (k === 'n') { next(); return true; }
      if (k === 'p') { togglePause(); return true; }
      if (k === 'r' && R.type === 'tossup' && ['reading', 'paused', 'waiting'].includes(R.phase)) { finishTossup(null); return true; }
      if (k === 'o' && R.phase === 'answered' && R.type === 'tossup') { overrideTossup(); return true; }
      if (k === 's' && R.q) { const on = toggleSaved(R.q, R.type); toast(on ? 'Saved' : 'Removed from saved'); paint(); return true; }
      if (k === 'c' && R.q && R.phase === 'answered') { openConverter(R.q, R.type, { results: R.type === 'bonus' ? R.entry?.parts : null }); return true; }
      return false;
    },
  };
}

export { isSaved };
