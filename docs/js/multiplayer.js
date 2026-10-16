// Multiplayer tossup rooms over Supabase Realtime (broadcast + presence) — no database tables.
// One browser in the room (the host) runs the game and broadcasts the whole room state; everyone
// else sends it buzzes, answers and chat. If the host leaves, the longest-present player takes over.
import { h, esc, sanitizeHtml, uid, promptDialog, toast } from './util.js?v=232d3239';
import { api, filterParams } from './api.js?v=232d3239';
import { db, save, addHistory } from './store.js?v=232d3239';
import { authEnabled, currentUser, usernameOf, openChannel, closeChannel } from './auth.js?v=232d3239';
import { checkAnswer } from './judge.js?v=232d3239';
import { qMeta, saveButton } from './qview.js?v=232d3239';
import { filterPanel, filterSummary } from './filters.js?v=232d3239';
import { openConverter } from './convert.js?v=232d3239';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ANSWER_MS = 10000; // time to answer after buzzing (reset by a prompt)
const DEAD_MS = 5000;    // time to buzz after the last word
const LOG_MAX = 80;

const newCode = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => CODE_ALPHABET[b % 32]).join('');
const normCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
const NAME_MAX = 24;
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
// Display name in rooms: the saved nickname, or the account username when none is set.
const displayName = (username) => cleanName(db.settings.mpName) || username;
const inviteLink = (code) => `${location.href.split('#')[0]}#/play/${code}`;

export function renderPlay(main, code) {
  if (!authEnabled) {
    main.append(h('h2', null, 'Multiplayer'), h('p', { class: 'muted' }, 'Multiplayer needs accounts, which aren’t set up for this copy of the app (see README → Accounts & sync).'));
    return null;
  }
  return code ? renderRoom(main, normCode(code)) : renderLobby(main);
}

function renderLobby(main) {
  const nick = h('input', { class: 'input', placeholder: 'Your username', maxlength: NAME_MAX, value: db.settings.mpName || '', autocomplete: 'off',
    onChange: () => { db.settings.mpName = cleanName(nick.value); nick.value = db.settings.mpName; save(); } });
  const input = h('input', { class: 'input mono', placeholder: 'Room code', autocapitalize: 'characters', spellcheck: false, autocomplete: 'off' });
  main.append(
    h('h2', null, 'Multiplayer'),
    h('p', { class: 'muted' }, 'Play tossups live with friends: everyone hears the same question, first to buzz answers. 15 for a power, 10 for a correct answer, −5 for an interrupt neg.'),
    h('div', { class: 'panel stack' },
      h('b', null, 'Display name'),
      h('div', { class: 'row gap-s wrap' }, nick, h('span', { class: 'muted small' }, 'What other players see. Leave blank to use your username.'))),
    h('div', { class: 'panel stack' },
      h('b', null, 'Start a room'),
      h('p', { class: 'muted small' }, 'You’ll be the host: you pick the categories, difficulty and reading speed. Share the link or code so others can join.'),
      h('div', null, h('button', { class: 'btn primary', onClick: () => (location.hash = `#/play/${newCode()}`) }, 'Create room'))),
    h('form', { class: 'panel stack', onSubmit: (e) => {
      e.preventDefault();
      const c = normCode(input.value);
      if (c.length >= 4) location.hash = `#/play/${c}`;
    } },
      h('b', null, 'Join a room'),
      h('div', { class: 'row gap-s' }, input, h('button', { class: 'btn' }, 'Join'))));
  setTimeout(() => input.focus());
  return null;
}

function renderRoom(main, code) {
  const me = { id: null, name: '', username: '', sid: uid() };
  const joinedAt = Date.now();
  let ch = null;
  let closed = false;
  let S = null;              // room state; authoritative on the host, a copy everywhere else
  let isHost = false;
  let present = new Map();   // presence session id -> { id, name, joinedAt }
  let knownUsers = new Set(); // host: user ids seen in the room, for join/leave messages
  let words = [], powerIdx = -1, wordsFor = null;
  let localIdx = 0, readTimer = null;
  let hostTimeout = null, deadline = null; // host: answer / dead-air timer
  let localDeadline = null, uiTimer = null;
  let queue = [];            // host: prefetched tossups
  let typedBy = {};          // user id -> live answer text
  let lastTypingSent = 0;
  const recorded = new Set();
  let answerInput = null, answerKey = null, answerPrompts = 0;

  /* ---------- layout ---------- */

  const status = h('div', { class: 'muted small' });
  const hostBar = h('div');
  const stage = h('section', { class: 'stage mp-stage' });
  const board = h('div', { class: 'panel scoreboard' });
  const logList = h('div', { class: 'mp-log' });
  const chatInput = h('input', { class: 'input small', placeholder: 'Chat…', maxlength: 300, autocomplete: 'off' });
  const chatForm = h('form', { class: 'row gap-s', onSubmit: (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !S) return;
    act('chat', { text });
    chatInput.value = '';
  } }, chatInput);
  const els = { text: null, typing: null, countdown: null };
  const nameBtn = h('button', { class: 'btn small', title: 'Change your display name', onClick: () => rename() });

  async function rename() {
    if (!me.id) return;
    const v = await promptDialog(`Display name (blank = ${me.username})`, me.name, 'Save');
    if (v == null || closed) return;
    const name = cleanName(v) || me.username;
    db.settings.mpName = name === me.username ? '' : name;
    save();
    if (name === me.name) return;
    me.name = name;
    nameBtn.textContent = `Name: ${name} ✎`;
    await ch?.track({ id: me.id, name: me.name, joinedAt });
    act('rename');
    toast(`You’re now “${name}”`);
  }

  main.append(
    h('div', { class: 'row between wrap gap' },
      h('div', null, h('a', { href: '#/play', class: 'muted small' }, '‹ Multiplayer'),
        h('h2', null, 'Room ', h('span', { class: 'room-code' }, code))),
      h('div', { class: 'row gap-s wrap' },
        nameBtn,
        h('button', { class: 'btn small', onClick: (e) => navigator.clipboard?.writeText(inviteLink(code)).then(() => { e.target.textContent = 'Link copied'; }) }, 'Copy invite link'),
        h('a', { class: 'btn small ghost', href: '#/play' }, 'Leave'))),
    hostBar,
    status,
    h('div', { class: 'mp' },
      stage,
      h('aside', { class: 'mp-side' }, board, h('div', { class: 'panel mp-chat' }, logList, chatForm))),
    h('div', { class: 'muted small keys' }, 'Keys: Space buzz / next · Enter submit answer · Esc give up'));

  /* ---------- question text ---------- */

  const setWords = () => {
    if (wordsFor === S?.qNum) return;
    wordsFor = S?.qNum;
    words = String(S?.q?.question_sanitized ?? '').split(/\s+/).filter(Boolean);
    powerIdx = words.findIndex((w) => w.includes('(*)'));
  };

  const marks = () => [...(S.buzzes || []), ...(S.buzz ? [S.buzz] : [])];

  function wordsHtml(upto) {
    const ms = marks();
    const mark = (b) => `<span class="buzz-mark ${b.points < 0 ? 'neg' : ''}" title="${esc(b.name)} buzzed">🔔 ${esc(b.name)}</span> `;
    let out = '';
    for (let i = 0; i < upto && i < words.length; i++) {
      for (const b of ms) if (b.idx === i) out += mark(b);
      const w = words[i];
      out += (w.includes('(*)') ? `<span class="power">${esc(w)}</span>` : esc(w)) + ' ';
    }
    const end = Math.min(upto, words.length);
    for (const b of ms) if (b.idx >= end) out += mark(b); // buzz on the last word shown so far
    return out;
  }

  function stopReading() { clearInterval(readTimer); readTimer = null; }

  function startReading() {
    stopReading();
    readTimer = setInterval(() => {
      if (localIdx >= words.length) {
        stopReading();
        if (isHost && S.phase === 'reading') {
          S.phase = 'waiting';
          setHostTimer(DEAD_MS, deadAir);
          publish();
        }
        return;
      }
      localIdx++;
      if (els.text) els.text.innerHTML = wordsHtml(localIdx);
    }, S.settings.speed);
  }

  /* ---------- networking ---------- */

  function send(event, payload) {
    ch?.send({ type: 'broadcast', event, payload });
  }

  // Everyone's actions go through here; the host applies them directly.
  function act(type, data = {}) {
    const msg = { ...data, type, from: me.id, name: me.name };
    if (isHost) handle(msg);
    else send('act', msg);
  }

  function publish() {
    if (!isHost || closed) return;
    S.v++;
    if (S.phase === 'reading') S.idx = localIdx;
    S.remainMs = deadline ? Math.max(0, deadline - Date.now()) : null;
    localDeadline = deadline;
    send('state', S);
    afterState();
  }

  // Two hosts can exist briefly (people opening a room at the same moment, or a network split).
  // The room further into the game wins, then the lower session id; the loser quietly yields.
  const outranks = (x, y) => x.qNum > y.qNum || (x.qNum === y.qNum && x.hostSid < y.hostSid);

  function receive(next) {
    if (isHost) {
      if (next.hostSid === me.sid) return;
      if (!outranks(next, S)) { publish(); return; } // show the rival host our state so it yields
      isHost = false;
      clearHostTimer();
      stopReading();
    } else if (S && next.hostSid === S.hostSid && next.v <= S.v) return; // out-of-order message
    S = next;
    setWords();
    localDeadline = S.remainMs != null ? Date.now() + S.remainMs : null;
    if (S.phase === 'reading') {
      localIdx = S.idx;
      if (!readTimer) startReading();
    } else {
      stopReading();
      localIdx = S.phase === 'answered' ? words.length : S.idx;
    }
    afterState();
  }

  function afterState() {
    if (S.phase === 'answered' && !recorded.has(S.qNum)) {
      recorded.add(S.qNum);
      const mine = S.buzzes.find((b) => b.id === me.id);
      if (mine) {
        addHistory({
          type: 'tossup', qid: S.q._id, category: S.q.category, subcategory: S.q.subcategory, difficulty: S.q.difficulty,
          set: S.q.set?.name, answer: S.q.answer_sanitized, given: mine.given, buzzed: true,
          correct: mine.correct, points: mine.points, celerity: 1 - mine.idx / Math.max(1, words.length), mode: 'multiplayer',
        });
      }
    }
    paint();
  }

  /* ---------- host logic ---------- */

  function setHostTimer(ms, fn) {
    clearTimeout(hostTimeout);
    deadline = Date.now() + ms;
    hostTimeout = setTimeout(() => { hostTimeout = null; deadline = null; if (isHost) fn(); }, ms);
  }
  function clearHostTimer() { clearTimeout(hostTimeout); hostTimeout = null; deadline = null; }

  function log(text, kind = 'event', name = '') {
    S.log.push({ t: Date.now(), kind, text, name });
    if (S.log.length > LOG_MAX) S.log.splice(0, S.log.length - LOG_MAX);
  }

  function score(id, name) {
    const s = (S.scores[id] ||= { name, pts: 0, p15: 0, p10: 0, n5: 0 });
    if (name) s.name = name;
    return s;
  }

  const presentUsers = () => new Set([...present.values()].map((p) => p.id));

  function handle(m) {
    if (!S) return;
    if (m.type === 'buzz') {
      if (!['reading', 'waiting'].includes(S.phase) || S.locked.includes(m.from)) return;
      stopReading();
      S.idx = localIdx;
      S.phase = 'buzz';
      S.buzz = { id: m.from, name: m.name, idx: localIdx, prompts: 0, prompt: '', checking: false, given: '' };
      typedBy[m.from] = '';
      score(m.from, m.name);
      setHostTimer(ANSWER_MS, () => resolveBuzz(false, typedBy[m.from] || ''));
      publish();
    } else if (m.type === 'answer') {
      if (S.phase !== 'buzz' || S.buzz.id !== m.from || S.buzz.checking) return;
      judgeAnswer(String(m.text ?? '').slice(0, 200));
    } else if (m.type === 'next') {
      if (['answered', 'idle', 'error'].includes(S.phase)) loadNext();
    } else if (m.type === 'skip') {
      if (m.from === me.id && ['reading', 'waiting'].includes(S.phase)) { log(`${m.name} skipped the question`); finish(); }
    } else if (m.type === 'rename') {
      const name = cleanName(m.name);
      const old = S.scores[m.from]?.name;
      if (!name || name === old) return;
      score(m.from, name);
      if (S.buzz?.id === m.from) S.buzz.name = name;
      if (m.from === me.id) S.hostName = name;
      log(`${old || 'Someone'} is now ${name}`);
      publish();
    } else if (m.type === 'chat') {
      const text = String(m.text ?? '').trim().slice(0, 300);
      if (text) { log(text, 'chat', m.name); publish(); }
    }
  }

  async function judgeAnswer(text) {
    const b = S.buzz;
    b.checking = true;
    b.given = text;
    clearHostTimer();
    publish();
    const r = await checkAnswer(text, S.q.answer);
    if (!isHost || S.buzz !== b) return;
    b.checking = false;
    if (r.directive === 'prompt' && b.prompts < 2) {
      b.prompts++;
      b.prompt = r.directedPrompt || 'Can you be more specific?';
      setHostTimer(ANSWER_MS, () => resolveBuzz(false, typedBy[b.id] || text));
      publish();
      return;
    }
    resolveBuzz(r.directive === 'accept', text);
  }

  function resolveBuzz(correct, given) {
    clearHostTimer();
    const b = S.buzz;
    if (!b) return;
    const points = correct ? (powerIdx >= 0 && b.idx <= powerIdx ? 15 : 10) : (b.idx < words.length ? -5 : 0);
    const s = score(b.id, b.name);
    s.pts += points;
    if (points === 15) s.p15++;
    else if (points === 10) s.p10++;
    else if (points === -5) s.n5++;
    S.buzzes.push({ id: b.id, name: b.name, idx: b.idx, given, correct, points });
    log(correct ? `${b.name} got it (+${points})` : `${b.name}: “${given || '—'}” ${points ? `(${points})` : '— wrong'}`);
    S.buzz = null;
    if (correct) return finish();
    S.locked.push(b.id);
    if (![...presentUsers()].some((id) => !S.locked.includes(id))) return finish();
    if (localIdx >= words.length) {
      S.phase = 'waiting';
      setHostTimer(DEAD_MS, deadAir);
    } else {
      S.phase = 'reading';
      startReading();
    }
    publish();
  }

  function deadAir() {
    if (S.phase !== 'waiting') return;
    log('Nobody got it');
    finish();
  }

  function finish() {
    clearHostTimer();
    stopReading();
    S.buzz = null;
    S.phase = 'answered';
    S.idx = words.length;
    localIdx = words.length;
    publish();
  }

  async function loadNext() {
    clearHostTimer();
    stopReading();
    S.phase = 'loading';
    publish();
    try {
      if (!queue.length) {
        queue = await api.randomTossups({
          number: 10,
          ...filterParams(S.settings.filters),
          standardOnly: S.settings.standardOnly ? true : undefined,
        });
      }
    } catch (e) {
      if (!isHost) return;
      S.phase = 'error';
      S.error = e.message;
      publish();
      return;
    }
    if (!isHost) return;
    if (!queue.length) {
      S.phase = 'error';
      S.error = 'No questions match these filters.';
      publish();
      return;
    }
    S.q = queue.shift();
    S.qNum++;
    S.idx = 0;
    S.buzz = null;
    S.buzzes = [];
    S.locked = [];
    S.phase = 'reading';
    typedBy = {};
    setWords();
    localIdx = 0;
    publish();
    startReading();
  }

  function becomeHost(prev) {
    isHost = true;
    if (prev) {
      S = prev;
      S.hostSid = me.sid;
      S.hostName = me.name;
      log(`${me.name} is now the host`);
    } else {
      S = {
        v: 0, code, hostSid: me.sid, hostName: me.name,
        settings: { speed: db.settings.readSpeed, filters: structuredClone(db.settings.filters || {}), standardOnly: !!db.settings.standardOnly },
        phase: 'idle', q: null, qNum: 0, idx: 0, buzz: null, buzzes: [], locked: [], scores: {}, log: [], error: '', remainMs: null,
      };
      log(`${me.name} opened the room`);
    }
    knownUsers = presentUsers();
    for (const p of present.values()) score(p.id, p.name);
    setWords();
    queue = [];
    if (S.phase === 'reading') { if (!readTimer) startReading(); }
    else if (S.phase === 'buzz') {
      S.buzz.checking = false; // an answer sent to the old host may have been lost
      const id = S.buzz.id;
      setHostTimer(ANSWER_MS, () => resolveBuzz(false, typedBy[id] || ''));
    } else if (S.phase === 'waiting') setHostTimer(S.remainMs ?? DEAD_MS, deadAir);
    else if (S.phase === 'loading') { loadNext(); return; }
    publish();
  }

  /* ---------- presence ---------- */

  const earliest = () => [...present.entries()].sort(([a, x], [b, y]) => x.joinedAt - y.joinedAt || (a < b ? -1 : 1))[0]?.[0];

  function onPresence() {
    if (!S) return paint();
    if (isHost) {
      const now = presentUsers();
      let changed = false;
      for (const p of present.values()) {
        if (!knownUsers.has(p.id)) { score(p.id, p.name); log(`${p.name} joined`); changed = true; }
      }
      // Announce a departure only if they're still gone a few seconds later (ignores brief reconnects).
      for (const id of knownUsers) {
        if (now.has(id)) continue;
        setTimeout(() => {
          if (!isHost || closed || presentUsers().has(id) || !knownUsers.has(id)) return;
          knownUsers.delete(id);
          log(`${S.scores[id]?.name || 'Someone'} left`);
          publish();
        }, 5000);
      }
      for (const id of now) knownUsers.add(id);
      if (changed) publish();
      else paint();
    } else if (!present.has(S.hostSid) && earliest() === me.sid) {
      becomeHost(S);
    } else paint();
  }

  // Joining: wait for the host's state; take over only if nobody else is here (or nobody answers).
  function checkStart(tries = 0) {
    if (closed || S) return;
    const others = [...present.keys()].filter((sid) => sid !== me.sid);
    if (!others.length || (tries >= 3 && earliest() === me.sid)) { becomeHost(null); return; }
    if (tries) send('hello', {});
    setTimeout(() => checkStart(tries + 1), 1500);
  }

  async function connect() {
    const user = await currentUser().catch(() => null);
    if (closed) return;
    if (!user) { status.textContent = 'Log in to play multiplayer.'; return; }
    me.id = user.id;
    me.username = usernameOf(user);
    me.name = displayName(me.username);
    nameBtn.textContent = `Name: ${me.name} ✎`;
    ch = await openChannel(`qb-room-${code}`, { broadcast: { self: false }, presence: { key: me.sid } });
    if (closed) { closeChannel(ch); return; }
    ch.on('broadcast', { event: 'state' }, ({ payload }) => receive(payload))
      .on('broadcast', { event: 'act' }, ({ payload }) => { if (isHost) handle(payload); })
      .on('broadcast', { event: 'hello' }, () => { if (isHost) publish(); })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        typedBy[payload.id] = String(payload.text ?? '').slice(0, 200);
        if (els.typing && S?.buzz?.id === payload.id) els.typing.textContent = typedBy[payload.id] || '…';
      })
      .on('presence', { event: 'sync' }, () => {
        present = new Map(Object.entries(ch.presenceState()).map(([sid, metas]) => [sid, metas[0]]));
        onPresence();
      })
      .subscribe(async (st) => {
        if (closed) return;
        if (st === 'SUBSCRIBED') {
          await ch.track({ id: me.id, name: me.name, joinedAt });
          send('hello', {});
          setTimeout(() => checkStart(), 1200);
        } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') {
          status.textContent = 'Lost connection to the room — trying again…';
        }
      });
  }

  /* ---------- rendering ---------- */

  let hostBarFor = null;
  function paintHostBar() {
    if (hostBarFor === isHost) return;
    hostBarFor = isHost;
    hostBar.replaceChildren();
    if (!isHost) return;
    const speedOut = h('span', { class: 'muted small' });
    const label = () => { speedOut.textContent = `${Math.round(60000 / S.settings.speed)} wpm`; };
    label();
    const speed = h('input', {
      type: 'range', min: 60, max: 600, step: 10, value: String(660 - S.settings.speed),
      onInput: (e) => { S.settings.speed = 660 - Number(e.target.value); label(); },
      onChange: () => { if (readTimer) startReading(); publish(); },
    });
    const filterBox = h('div', { class: 'panel', style: 'display:none' },
      filterPanel(S.settings.filters, () => { queue = []; publish(); }),
      h('div', { class: 'row wrap gap', style: 'margin-top:10px' },
        h('label', null, h('input', { type: 'checkbox', checked: S.settings.standardOnly, onChange: (e) => { S.settings.standardOnly = e.target.checked; queue = []; publish(); } }), ' Standard sets only')),
      h('div', { class: 'muted small' }, 'Changes apply from the next question.'));
    hostBar.append(
      h('div', { class: 'row wrap gap' },
        h('span', { class: 'pill tossup' }, 'You’re the host'),
        h('label', { class: 'row gap-s' }, 'Speed', speed, speedOut),
        h('button', { class: 'btn small', onClick: () => { filterBox.style.display = filterBox.style.display ? '' : 'none'; } }, '⚙ Filters'),
        h('button', { class: 'btn small ghost', onClick: () => act('skip') }, 'Skip question')),
      filterBox);
  }

  function paintBoard() {
    const online = presentUsers();
    const rows = Object.entries(S.scores).sort(([, a], [, b]) => b.pts - a.pts || a.name.localeCompare(b.name));
    board.replaceChildren(
      h('div', { class: 'label' }, `Players · ${online.size} here`),
      h('table', { class: 'board-table' },
        h('tbody', null, rows.map(([id, s]) => h('tr', { class: online.has(id) ? '' : 'offline' },
          h('td', null, h('span', { class: 'dot' }), ' ', s.name, id === me.id && h('span', { class: 'muted small' }, ' (you)'),
            [...present.entries()].some(([sid, p]) => sid === S.hostSid && p.id === id) && h('span', { title: 'Host' }, ' ★'),
            S.locked.includes(id) && h('span', { class: 'muted small', title: 'Already buzzed on this question' }, ' 🔒')),
          h('td', { class: 'num pts' }, s.pts),
          h('td', { class: 'num muted small', title: '15s / 10s / negs' }, `${s.p15}/${s.p10}/${s.n5}`))))));
  }

  function paintLog() {
    const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 30;
    logList.replaceChildren(...S.log.map((e) => e.kind === 'chat'
      ? h('div', { class: 'chat' }, h('b', null, e.name), ' ', e.text)
      : h('div', { class: 'event muted small' }, e.text)));
    if (atBottom || logList.dataset.init !== '1') { logList.scrollTop = logList.scrollHeight; logList.dataset.init = '1'; }
  }

  function answerBox() {
    const b = S.buzz;
    const key = `${S.qNum}:${S.buzzes.length}`;
    if (answerKey !== key) {
      answerKey = key;
      answerPrompts = 0;
      answerInput = h('input', { class: 'input big', placeholder: 'Your answer, then Enter', autocomplete: 'off', spellcheck: false });
      answerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); act('answer', { text: answerInput.value }); }
        if (e.key === 'Escape') { e.preventDefault(); act('answer', { text: '' }); }
      });
      answerInput.addEventListener('input', () => {
        typedBy[me.id] = answerInput.value;
        const now = Date.now();
        if (now - lastTypingSent > 250) { lastTypingSent = now; send('typing', { id: me.id, text: answerInput.value }); }
      });
    }
    if (b.prompts !== answerPrompts) { answerPrompts = b.prompts; answerInput.value = ''; }
    answerInput.disabled = b.checking;
    answerInput.placeholder = b.prompts ? 'Answer the prompt…' : 'Your answer, then Enter';
    if (!b.checking) queueMicrotask(() => answerInput.focus());
    els.countdown = h('span');
    return h('div', { class: 'answer-box' }, answerInput,
      b.prompts > 0 && h('div', { class: 'warn' }, `Prompt on “${b.given}”: ${b.prompt}`),
      h('div', { class: 'muted small' }, b.checking ? 'Checking…' : h('span', null, 'Enter to submit · Esc to give up · ', els.countdown)));
  }

  function paintStage() {
    els.text = els.typing = els.countdown = null;
    stage.replaceChildren();
    const p = S.phase;
    if (p === 'idle') {
      stage.append(h('div', { class: 'empty' },
        h('p', null, 'Waiting to start. Invite people with the link or the code ', h('b', { class: 'room-code' }, code), '.'),
        h('button', { class: 'btn primary', onClick: () => act('next') }, 'Start', h('kbd', null, 'Space'))));
      return;
    }
    if (p === 'loading') { stage.append(h('div', { class: 'empty muted' }, 'Loading question…')); return; }
    if (p === 'error') {
      stage.append(h('div', { class: 'empty' }, h('p', { class: 'warn' }, S.error), h('button', { class: 'btn', onClick: () => act('next') }, 'Try again')));
      return;
    }

    const q = S.q;
    const done = p === 'answered';
    stage.append(
      h('div', { class: 'q-meta' }, `Tossup ${S.qNum} · `, done ? qMeta(q) : (db.settings.showCategory ? [q.category, q.subcategory].filter(Boolean).join(' / ') : '')),
      els.text = h('div', { class: 'q-text reading', html: wordsHtml(done ? words.length : localIdx) }));
    if (done) els.text = null;

    const locked = S.locked.includes(me.id);
    if (p === 'buzz') {
      if (S.buzz.id === me.id) stage.append(answerBox());
      else {
        els.typing = h('span', { class: 'live-answer' }, typedBy[S.buzz.id] || '…');
        els.countdown = h('span', { class: 'muted small' });
        stage.append(h('div', { class: 'answer-box' },
          h('div', null, h('b', null, S.buzz.name), ' buzzed: ', els.typing),
          S.buzz.prompts > 0 && h('div', { class: 'warn small' }, `Prompted: ${S.buzz.prompt}`),
          S.buzz.checking ? h('div', { class: 'muted small' }, 'Checking…') : els.countdown));
      }
    }

    if (done) {
      const verdicts = S.buzzes.length
        ? S.buzzes.map((b) => h('div', { class: 'row wrap gap-s' },
            h('span', { class: `verdict ${b.correct ? 'ok' : 'bad'}` }, `${b.name} ${b.points > 0 ? '+' : ''}${b.points}`),
            h('span', { class: 'muted' }, `“${b.given || '—'}”`)))
        : [h('span', { class: 'verdict none' }, 'Nobody got it')];
      stage.append(
        h('div', { class: 'result stack' }, verdicts,
          h('div', { class: 'q-answer' }, h('span', { class: 'label' }, 'ANSWER: '), h('span', { html: sanitizeHtml(q.answer) }))),
        h('div', { class: 'row wrap gap-s' },
          saveButton(q, 'tossup'),
          h('button', { class: 'btn small', onClick: () => openConverter(q, 'tossup') }, '＋ Make cards')));
    }

    const btns = h('div', { class: 'row wrap gap-s controls' });
    if (p === 'reading' || p === 'waiting') {
      btns.append(h('button', { class: 'btn primary big', disabled: locked, onClick: () => act('buzz') }, 'Buzz', h('kbd', null, 'Space')));
      if (locked) btns.append(h('span', { class: 'muted small' }, 'You’ve buzzed on this one.'));
      if (p === 'waiting') btns.append(els.countdown = h('span', { class: 'muted small' }));
    }
    if (done) btns.append(h('button', { class: 'btn primary', onClick: () => act('next') }, 'Next', h('kbd', null, 'Space / N')));
    stage.append(btns);
  }

  function tickCountdown() {
    if (!els.countdown) return;
    const s = localDeadline ? Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000)) : null;
    if (s == null) { els.countdown.textContent = ''; return; }
    els.countdown.textContent = S?.phase === 'waiting' ? `${s}s to buzz` : `${s}s left`;
  }

  function paint() {
    if (closed) return;
    if (!S) {
      stage.replaceChildren(h('div', { class: 'empty muted' }, 'Joining room…'));
      return;
    }
    status.textContent = `Random tossups · ${filterSummary(S.settings.filters)} · ${Math.round(60000 / S.settings.speed)} wpm · host: ${S.hostName}`;
    paintHostBar();
    paintStage();
    paintBoard();
    paintLog();
    tickCountdown();
  }

  paint();
  uiTimer = setInterval(tickCountdown, 250);
  connect().catch((e) => { status.textContent = `Could not join the room: ${e.message}`; });

  return {
    cleanup() {
      closed = true;
      stopReading();
      clearHostTimer();
      clearInterval(uiTimer);
      closeChannel(ch);
    },
    onKey(e, typing) {
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !S) return false;
      const k = e.key.toLowerCase();
      if (k === ' ') {
        if (['reading', 'waiting'].includes(S.phase) && !S.locked.includes(me.id)) act('buzz');
        else if (['answered', 'idle', 'error'].includes(S.phase)) act('next');
        return true;
      }
      if (k === 'n' && S.phase === 'answered') { act('next'); return true; }
      return false;
    },
  };
}
