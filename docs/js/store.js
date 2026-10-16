// App state. Persisted to the signed-in user's Supabase row (cloud), the local dev server, or this browser.
import { uid, toast, todayKey } from './util.js?v=232d3239';
import { fetchCloud, pushCloud } from './auth.js?v=232d3239';
import { clozeNumbers } from './cloze.js?v=232d3239';
import { answer as srsAnswer, startOfDay, DAY } from './srs.js?v=232d3239';

const LS_KEY = 'qbstudy-db';
const IDB_NAME = 'qbstudy';
const IDB_STORE = 'kv';

// On localhost the Node server saves to data/db.json; on the hosted site data lives in this browser (IndexedDB).
const isLocalDev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const req = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const defaults = () => ({
  version: 1,
  decks: [],
  notes: [],
  cards: [],
  saved: [],
  history: [],
  dayLog: {},
  settings: {
    newPerDay: 20,
    readSpeed: 200,
    showCategory: true,
    powermarkOnly: false,
    standardOnly: false,
    filters: { subcategories: [], difficulties: [], minYear: '', maxYear: '' },
  },
});

export let db = defaults();
// 'cloud' (signed in), 'server' (local dev), 'idb' (this browser), or 'local' (localStorage fallback)
export let storageMode = isLocalDev ? 'server' : 'idb';

let userId = null;
let lastSync = null; // updated_at of the cloud row we last loaded or wrote
let dirty = false;   // unsaved local changes

function merge(d) {
  const base = defaults();
  return {
    ...base,
    ...d,
    settings: { ...base.settings, ...(d.settings || {}), filters: { ...base.settings.filters, ...(d.settings?.filters || {}) } },
  };
}

function readLocalStorage() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
}

const hasContent = (d) => d && ['decks', 'notes', 'saved', 'history'].some((k) => d[k]?.length);

async function readBrowserData() {
  try { return (await idbGet('db')) || readLocalStorage(); } catch { return readLocalStorage(); }
}

export async function loadDb(user = null) {
  if (user) {
    storageMode = 'cloud';
    userId = user.id;
    const row = await fetchCloud(userId);
    if (row) {
      db = merge(row.data || {});
      lastSync = row.updated_at;
    } else {
      // First sign-in: move anything already saved in this browser into the new account, once.
      const local = await readBrowserData();
      db = merge(hasContent(local) ? local : {});
      dirty = true;
      await flush();
      if (hasContent(local)) {
        try { await idbSet('db', null); } catch {}
        try { localStorage.removeItem(LS_KEY); } catch {}
        toast('Moved the data saved in this browser into your account');
      }
    }
    return;
  }
  if (storageMode === 'server') {
    try {
      const r = await fetch('/api/db');
      if (!r.ok) throw new Error();
      db = merge(await r.json());
      return;
    } catch {
      storageMode = 'idb';
    }
  }
  try {
    db = merge((await idbGet('db')) || readLocalStorage() || {});
    storageMode = 'idb';
  } catch {
    storageMode = 'local';
    db = merge(readLocalStorage() || {});
  }
  // Ask the browser not to evict our data under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
}

export function resetDb() {
  clearTimeout(timer);
  db = defaults();
  userId = null;
  lastSync = null;
  dirty = false;
}

// Pull newer data saved from another device. Returns true if the local copy was replaced.
export async function refreshFromCloud() {
  if (storageMode !== 'cloud' || dirty || !userId) return false;
  const row = await fetchCloud(userId);
  if (!row || (lastSync && row.updated_at <= lastSync) || dirty) return false;
  db = merge(row.data || {});
  lastSync = row.updated_at;
  return true;
}

let timer;
export function save() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, storageMode === 'cloud' ? 1000 : 300);
}

let cloudFailed = false;
export async function flush() {
  clearTimeout(timer);
  if (storageMode === 'cloud') {
    if (!dirty) return;
    try {
      dirty = false;
      lastSync = await pushCloud(userId, JSON.parse(JSON.stringify(db)));
      if (cloudFailed) { cloudFailed = false; toast('Back online — progress saved'); }
    } catch {
      dirty = true;
      if (!cloudFailed) toast('Could not save to your account — will retry', 'error');
      cloudFailed = true;
      timer = setTimeout(flush, 15000);
    }
    return;
  }
  dirty = false;
  if (storageMode === 'idb') {
    try { await idbSet('db', JSON.parse(JSON.stringify(db))); return; }
    catch { storageMode = 'local'; }
  }
  const body = JSON.stringify(db);
  if (storageMode === 'local') {
    try { localStorage.setItem(LS_KEY, body); } catch { toast('Could not save (browser storage full?) — export a backup', 'error'); }
    return;
  }
  try {
    const r = await fetch('/api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error(r.status);
  } catch {
    toast('Save failed — is the server running?', 'error');
  }
}

export const hasUnsaved = () => dirty;

export function replaceDb(data) {
  db = merge(data);
  save();
}

/* ---------- decks & notes ---------- */

export function createDeck(name) {
  const d = { id: uid(), name, created: Date.now() };
  db.decks.push(d);
  save();
  return d;
}

export function getDeck(id) { return db.decks.find((d) => d.id === id); }

export function deleteDeck(id) {
  const noteIds = new Set(db.notes.filter((n) => n.deckId === id).map((n) => n.id));
  db.decks = db.decks.filter((d) => d.id !== id);
  db.notes = db.notes.filter((n) => !noteIds.has(n.id));
  db.cards = db.cards.filter((c) => !noteIds.has(c.noteId));
  save();
}

export function addNote({ deckId, text, extra = '', source = null }) {
  const n = { id: uid(), deckId, text, extra, source, created: Date.now(), modified: Date.now() };
  db.notes.push(n);
  syncCards(n);
  save();
  return n;
}

export function updateNote(note, patch) {
  Object.assign(note, patch, { modified: Date.now() });
  syncCards(note);
  save();
}

export function deleteNote(id) {
  db.notes = db.notes.filter((n) => n.id !== id);
  db.cards = db.cards.filter((c) => c.noteId !== id);
  save();
}

export function getNote(id) { return db.notes.find((n) => n.id === id); }

function syncCards(note) {
  const nums = clozeNumbers(note.text);
  db.cards = db.cards.filter((c) => c.noteId !== note.id || nums.includes(c.ord));
  for (const ord of nums) {
    if (!db.cards.some((c) => c.noteId === note.id && c.ord === ord)) {
      db.cards.push({ id: uid(), noteId: note.id, ord, state: 'new', due: 0, interval: 0, ease: 2.5, step: 0, reps: 0, lapses: 0, created: note.created + ord });
    }
  }
}

/* ---------- study queue ---------- */

function noteDeckMap() {
  const m = new Map();
  for (const n of db.notes) m.set(n.id, n.deckId);
  return m;
}

function cardsIn(deckId) {
  const m = noteDeckMap();
  return db.cards.filter((c) => deckId === 'all' || m.get(c.noteId) === deckId).map((c) => ({ c, deck: m.get(c.noteId) }));
}

function newLeft(deckId) {
  const used = db.dayLog[todayKey()]?.[deckId] || 0;
  return Math.max(0, db.settings.newPerDay - used);
}

const isLearning = (c) => c.state === 'learning' || c.state === 'relearning';

export function deckCounts(deckId, now = Date.now()) {
  const list = cardsIn(deckId);
  const learn = list.filter(({ c }) => isLearning(c) && c.due <= now).length;
  const review = list.filter(({ c }) => c.state === 'review' && c.due <= now).length;
  const newByDeck = {};
  for (const { c, deck } of list) if (c.state === 'new') newByDeck[deck] = (newByDeck[deck] || 0) + 1;
  let fresh = 0;
  for (const [deck, count] of Object.entries(newByDeck)) fresh += Math.min(count, newLeft(deck));
  return { new: fresh, learn, review, total: list.length };
}

let sessionCounter = 0;
export function nextCard(deckId, now = Date.now()) {
  const list = cardsIn(deckId);
  const byDue = (a, b) => a.c.due - b.c.due;
  const learn = list.filter(({ c }) => isLearning(c) && c.due <= now).sort(byDue);
  if (learn.length) return learn[0].c;
  const rev = list.filter(({ c }) => c.state === 'review' && c.due <= now).sort(byDue);
  const fresh = list.filter(({ c, deck }) => c.state === 'new' && newLeft(deck) > 0).sort((a, b) => a.c.created - b.c.created);
  sessionCounter++;
  if (fresh.length && (!rev.length || sessionCounter % 4 === 0)) return fresh[0].c;
  if (rev.length) return rev[0].c;
  const ahead = list.filter(({ c }) => isLearning(c) && c.due <= now + 20 * 60_000).sort(byDue);
  return ahead.length ? ahead[0].c : null;
}

export function nextDueTime(deckId) {
  const list = cardsIn(deckId).filter(({ c }) => c.state !== 'new');
  return list.length ? Math.min(...list.map(({ c }) => c.due)) : null;
}

export function gradeCard(cardId, grade) {
  const i = db.cards.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  const before = db.cards[i];
  if (before.state === 'new') {
    const deckId = getNote(before.noteId)?.deckId;
    const day = (db.dayLog[todayKey()] ||= {});
    day[deckId] = (day[deckId] || 0) + 1;
  }
  db.cards[i] = srsAnswer(before, grade);
  db.reviewLog = db.reviewLog || [];
  db.reviewLog.push({ cardId, grade, ts: Date.now() });
  if (db.reviewLog.length > 20000) db.reviewLog.splice(0, db.reviewLog.length - 20000);
  save();
  return before;
}

export function undoGrade(before) {
  const i = db.cards.findIndex((c) => c.id === before.id);
  if (i < 0) return;
  if (before.state === 'new') {
    const deckId = getNote(before.noteId)?.deckId;
    const day = db.dayLog[todayKey()];
    if (day?.[deckId]) day[deckId]--;
  }
  db.cards[i] = before;
  db.reviewLog?.pop();
  save();
}

export function reviewsToday() {
  const start = startOfDay(Date.now());
  return (db.reviewLog || []).filter((r) => r.ts >= start && r.ts < start + DAY).length;
}

/* ---------- saved questions & history ---------- */

export function isSaved(qid) { return db.saved.some((s) => s.qid === qid); }

export function toggleSaved(q, type) {
  if (isSaved(q._id)) {
    db.saved = db.saved.filter((s) => s.qid !== q._id);
    save();
    return false;
  }
  db.saved.unshift({ qid: q._id, type, data: q, savedAt: Date.now(), tags: [], note: '' });
  save();
  return true;
}

export function addHistory(entry) {
  const e = { id: uid(), ts: Date.now(), ...entry };
  db.history.push(e);
  if (db.history.length > 10000) db.history.splice(0, db.history.length - 10000);
  save();
  return e;
}
