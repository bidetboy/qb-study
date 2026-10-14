// Thin client for https://www.qbreader.org/api (database + question-stats endpoints).
const BASE = 'https://www.qbreader.org/api';

function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return sp.toString();
}

async function get(path, params) {
  const q = qs(params);
  const res = await fetch(`${BASE}${path}${q ? '?' + q : ''}`);
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  try { return JSON.parse(text); } catch { throw new Error(text || 'Unexpected response'); }
}

let setListCache = null;

export const api = {
  randomTossups: (p) => get('/random-tossup', p).then((d) => d.tossups || []),
  randomBonuses: (p) => get('/random-bonus', p).then((d) => d.bonuses || []),
  query: (p) => get('/query', p),
  packet: (setName, packetNumber) => get('/packet', { setName, packetNumber }),
  numPackets: (setName) => get('/num-packets', { setName }).then((d) => d.numPackets),
  setList: async () => (setListCache ??= await get('/set-list').then((d) => d.setList || [])),
  tossup: (id) => get('/tossup', { id }).then((d) => d.tossup),
  bonus: (id) => get('/bonus', { id }).then((d) => d.bonus),
  frequencyList: (p) => get('/frequency-list', p).then((d) => d.frequencyList || []),
  tossupStats: (id) => get('/question-stats/tossup', { _id: id }).then((d) => d.stats ?? null),
  bonusStats: (id) => get('/question-stats/bonus', { _id: id }).then((d) => d.stats ?? null),
  checkAnswer: (answerline, givenAnswer) => get('/check-answer', { answerline, givenAnswer }),
};

// Turn the shared filter object into API params.
export function filterParams(f = {}) {
  const subs = f.subcategories || [];
  const cats = [...new Set(subs.map((s) => categoryOf(s)).filter(Boolean))];
  return {
    categories: cats,
    subcategories: subs,
    difficulties: f.difficulties || [],
    minYear: f.minYear || undefined,
    maxYear: f.maxYear || undefined,
  };
}

import { CATEGORIES } from './util.js';
export function categoryOf(sub) {
  for (const [cat, subs] of Object.entries(CATEGORIES)) if (subs.includes(sub)) return cat;
  return null;
}
