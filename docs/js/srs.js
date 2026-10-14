// Anki-like SM-2 scheduler. Grades: 1 Again, 2 Hard, 3 Good, 4 Easy.
const MIN = 60_000;
export const DAY = 86_400_000;
const LEARN = [1, 10];    // minutes
const RELEARN = [10];     // minutes

export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const reviewDue = (now, days) => startOfDay(now) + Math.max(1, Math.round(days)) * DAY;

function graduate(c, days, now) {
  c.state = 'review';
  c.step = 0;
  c.interval = days;
  c.due = reviewDue(now, days);
}

export function answer(card, grade, now = Date.now()) {
  const c = { ...card, reps: (card.reps || 0) + 1, lastReview: now };
  if (c.state === 'new' || c.state === 'learning') {
    c.state = 'learning';
    if (grade === 1) { c.step = 0; c.due = now + LEARN[0] * MIN; }
    else if (grade === 2) c.due = now + (c.step === 0 ? (LEARN[0] + (LEARN[1] ?? LEARN[0])) / 2 : LEARN[c.step]) * MIN;
    else if (grade === 3) {
      c.step += 1;
      if (c.step >= LEARN.length) graduate(c, 1, now);
      else c.due = now + LEARN[c.step] * MIN;
    } else graduate(c, 4, now);
  } else if (c.state === 'review') {
    if (grade === 1) {
      c.lapses = (c.lapses || 0) + 1;
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.interval = Math.max(1, Math.round(c.interval * 0.5));
      c.state = 'relearning';
      c.step = 0;
      c.due = now + RELEARN[0] * MIN;
    } else {
      const late = Math.max(0, (now - c.due) / DAY);
      const hard = Math.max(c.interval + 1, Math.round(c.interval * 1.2));
      const good = Math.max(hard + 1, Math.round((c.interval + late / 2) * c.ease));
      const easy = Math.max(good + 1, Math.round((c.interval + late) * c.ease * 1.3));
      if (grade === 2) c.ease = Math.max(1.3, c.ease - 0.15);
      if (grade === 4) c.ease += 0.15;
      c.interval = grade === 2 ? hard : grade === 3 ? good : easy;
      c.due = reviewDue(now, c.interval);
    }
  } else { // relearning
    if (grade === 1) { c.step = 0; c.due = now + RELEARN[0] * MIN; }
    else if (grade === 2) c.due = now + RELEARN[0] * 1.5 * MIN;
    else {
      if (grade === 4) c.interval += 1;
      c.state = 'review';
      c.step = 0;
      c.due = reviewDue(now, c.interval);
    }
  }
  return c;
}

export function fmtSpan(ms) {
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))}m`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}h`;
  return fmtDays(ms / DAY);
}

export function fmtDays(d) {
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

export function previewLabels(card, now = Date.now()) {
  return [1, 2, 3, 4].map((g) => {
    const r = answer(card, g, now);
    return r.state === 'review' ? fmtDays(r.interval) : fmtSpan(r.due - now);
  });
}
