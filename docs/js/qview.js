// Shared rendering for API questions: cards, metadata, stats, and actions.
import { h, sanitizeHtml, toast, DIFFICULTIES } from './util.js?v=5da9d5ed';
import { api } from './api.js?v=5da9d5ed';
import { isSaved, toggleSaved } from './store.js?v=5da9d5ed';

export function qMeta(q) {
  const bits = [
    q.set?.name,
    q.packet?.number != null ? `Packet ${q.packet.number}` : null,
    q.number != null ? `#${q.number}` : null,
    [q.category, q.subcategory, q.alternate_subcategory].filter(Boolean).join(' / '),
    q.difficulty != null ? `Diff ${q.difficulty}${DIFFICULTIES[q.difficulty] ? ` (${DIFFICULTIES[q.difficulty]})` : ''}` : null,
  ];
  return bits.filter(Boolean).join(' · ');
}

export function mainAnswer(answerSanitized) {
  return String(answerSanitized ?? '').split(/\s*[\[(]/)[0].trim();
}

export function saveButton(q, type) {
  const btn = h('button', { class: 'btn small', title: 'Save question (S)' });
  const paint = () => {
    const on = isSaved(q._id);
    btn.textContent = on ? '★ Saved' : '☆ Save';
    btn.classList.toggle('on', on);
  };
  btn.addEventListener('click', () => {
    const on = toggleSaved(q, type);
    toast(on ? 'Saved' : 'Removed from saved');
    paint();
  });
  paint();
  return btn;
}

export function statsBlock(q, type) {
  const box = h('div', { class: 'stats-block muted' }, 'Loading QB Reader stats…');
  (type === 'tossup' ? api.tossupStats(q._id) : api.bonusStats(q._id))
    .then((s) => {
      if (!s) { box.textContent = 'No QB Reader play stats for this question yet.'; return; }
      if (type === 'tossup') {
        const rc = s.resultCounts || {};
        const cel = s.numCorrect ? (s.totalCorrectCelerity / s.numCorrect).toFixed(2) : '–';
        box.replaceChildren(h('b', null, 'QB Reader stats: '),
          `${s.count} plays · ${s.numCorrect} correct · PPTU ${Number(s.pptu).toFixed(2)} · `,
          `15s: ${rc['15'] ?? 0}, 10s: ${rc['10'] ?? 0}, negs: ${rc['-5'] ?? 0} · avg correct celerity ${cel}`);
      } else {
        const conv = (s.partConversion || []).map((x) => s.count ? `${Math.round((x / s.count) * 100)}%` : '–').join(' / ');
        box.replaceChildren(h('b', null, 'QB Reader stats: '),
          `${s.count} plays · PPB ${Number(s.ppb).toFixed(2)} · part conversion ${conv}`);
      }
    })
    .catch((e) => { box.textContent = `Stats unavailable: ${e.message}`; });
  return box;
}

// actions: { practice?: fn, cards?: fn, extra?: [nodes] }
export function questionCard(q, type, actions = {}) {
  const statsSlot = h('div');
  const toolbar = h('div', { class: 'row wrap gap-s' },
    saveButton(q, type),
    actions.cards && h('button', { class: 'btn small', onClick: () => actions.cards(q, type) }, '＋ Make cards'),
    actions.practice && h('button', { class: 'btn small', onClick: () => actions.practice(q, type) }, '▶ Practice'),
    h('button', { class: 'btn small ghost', onClick: (e) => { e.target.remove(); statsSlot.append(statsBlock(q, type)); } }, 'Stats'),
    h('button', { class: 'btn small ghost', title: 'Copy question ID', onClick: () => navigator.clipboard?.writeText(q._id).then(() => toast('ID copied')) }, 'ID'),
    actions.extra);

  const body = type === 'tossup'
    ? [h('div', { class: 'q-text', html: sanitizeHtml(q.question) }),
       h('div', { class: 'q-answer' }, h('span', { class: 'label' }, 'ANSWER: '), h('span', { html: sanitizeHtml(q.answer) }))]
    : [h('div', { class: 'q-text', html: sanitizeHtml(q.leadin) }),
       ...(q.parts || []).map((p, i) => h('div', { class: 'bonus-part' },
         h('div', { class: 'q-text', html: `<span class="label">[${q.values?.[i] ?? 10}]</span> ` + sanitizeHtml(p) }),
         h('div', { class: 'q-answer' }, h('span', { class: 'label' }, 'ANSWER: '), h('span', { html: sanitizeHtml(q.answers?.[i]) }))))];

  return h('article', { class: 'qcard' },
    h('div', { class: 'q-meta' }, h('span', { class: `pill ${type}` }, type), ' ', qMeta(q)),
    body, toolbar, statsSlot);
}
