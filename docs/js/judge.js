// Answer judging: QB Reader's /check-answer, with a local matcher as offline fallback.
import { sanitizeHtml } from './util.js?v=5da9d5ed';
import { api } from './api.js?v=5da9d5ed';

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const tol = Math.floor(Math.max(a.length, b.length) * 0.2);
  return tol > 0 && lev(a, b) <= tol;
}

const splitAlts = (s) => s.split(/\s*(?:,\s*or\s+|\bor\b|,|\/)\s*/i).map((x) => x.replace(/["“”]|\bbefore\b.*$|\buntil\b.*$/gi, '').trim()).filter(Boolean);

export function parseAnswerline(html) {
  const clean = sanitizeHtml(html);
  const div = document.createElement('div');
  div.innerHTML = clean;
  const text = div.textContent;
  // Required (underlined/bold) parts come only from the main answer, not from [accept/prompt …] clauses.
  const head = document.createElement('div');
  head.innerHTML = clean.split(/[\[(]/)[0];
  let required = [...head.querySelectorAll('u')].map((e) => e.textContent.trim()).filter(Boolean);
  if (!required.length) required = [...head.querySelectorAll('b, strong')].map((e) => e.textContent.trim()).filter(Boolean);
  const main = text.split(/[\[(]/)[0].trim();
  const accept = [], prompt = [], reject = [];
  const bracket = [...text.matchAll(/[\[(]([^\])]*)[\])]/g)].map((m) => m[1]).join(';');
  for (const raw of bracket.split(';')) {
    const c = raw.trim();
    let m;
    if ((m = c.match(/^(?:do not accept or prompt on|do not accept|reject|don'?t accept)\s+(.*)$/i))) reject.push(...splitAlts(m[1]));
    else if ((m = c.match(/^(?:prompt on|prompt)\s+(.*)$/i))) prompt.push(...splitAlts(m[1]));
    else if ((m = c.match(/^(?:also accept|accept|or)\s+(.*)$/i))) accept.push(...splitAlts(m[1]));
  }
  return { main, required, accept, prompt, reject };
}

// Returns 'accept' | 'prompt' | 'reject'
export function judge(given, answerHtml) {
  const g = normalize(given);
  if (!g) return 'reject';
  const a = parseAnswerline(answerHtml);
  if (a.reject.some((r) => similar(g, normalize(r)))) return 'reject';
  const candidates = [a.main, ...a.main.split(/\s+or\s+/i), ...a.required, a.required.join(' '), ...a.accept].map(normalize).filter(Boolean);
  if (candidates.some((c) => similar(g, c))) return 'accept';
  const words = g.split(' ');
  const req = normalize(a.required.join(' ')).split(' ').filter((w) => w.length > 1);
  if (req.length && req.every((w) => words.some((x) => similar(x, w)))) return 'accept';
  if (a.prompt.some((p) => similar(g, normalize(p)))) return 'prompt';
  return 'reject';
}

// Returns { directive: 'accept' | 'prompt' | 'reject', directedPrompt?, local? }
export async function checkAnswer(given, answerHtml) {
  if (!String(given ?? '').trim()) return { directive: 'reject' };
  try {
    const r = await api.checkAnswer(answerHtml, given);
    if (['accept', 'prompt', 'reject'].includes(r?.directive)) return r;
    throw new Error('Unexpected check-answer response');
  } catch {
    return { directive: judge(given, answerHtml), local: true };
  }
}
