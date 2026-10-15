// Category / difficulty / year filter panel shared by Reader, Search and Frequency views.
import { h, CATEGORIES, DIFFICULTIES, DIFFICULTY_INFO } from './util.js?v=f0eb06de';

export function filterPanel(f, onChange, { years = true } = {}) {
  f.subcategories ||= [];
  f.difficulties ||= [];
  const changed = () => { paint(); onChange?.(); };
  const root = h('div', { class: 'filters' });

  const toggle = (arr, v, on) => {
    const i = arr.indexOf(v);
    if (on && i < 0) arr.push(v);
    if (!on && i >= 0) arr.splice(i, 1);
  };

  const paint = () => {
    const cats = Object.entries(CATEGORIES).map(([cat, subs]) => {
      const nOn = subs.filter((s) => f.subcategories.includes(s)).length;
      const catBox = h('input', {
        type: 'checkbox', checked: nOn === subs.length,
        onChange: (e) => { subs.forEach((s) => toggle(f.subcategories, s, e.target.checked)); changed(); },
      });
      catBox.indeterminate = nOn > 0 && nOn < subs.length;
      return h('div', { class: 'cat' },
        h('label', { class: 'cat-name' }, catBox, ' ', cat),
        subs.length > 1 && h('div', { class: 'subs' }, subs.map((s) => h('label', { class: 'sub' },
          h('input', { type: 'checkbox', checked: f.subcategories.includes(s), onChange: (e) => { toggle(f.subcategories, s, e.target.checked); changed(); } }),
          ' ', s.replace(/ (Literature|History|Fine Arts|Pop Culture|Science)$/, '') || s))));
    });
    root.replaceChildren(
      h('div', { class: 'row between' }, h('b', null, 'Categories'),
        h('span', { class: 'row gap-s' },
          h('button', { class: 'btn tiny ghost', onClick: () => { f.subcategories.length = 0; f.difficulties.length = 0; f.minYear = ''; f.maxYear = ''; changed(); } }, 'Clear all'))),
      h('div', { class: 'cats' }, cats),
      h('div', { style: 'margin-top:14px' }, difficultyPicker(f.difficulties, changed)),
      years && h('div', { class: 'row wrap gap-s', style: 'margin-top:10px' }, h('b', null, 'Years'),
        h('input', { class: 'input year', type: 'number', placeholder: 'min', value: f.minYear ?? '', onChange: (e) => { f.minYear = e.target.value; onChange?.(); } }),
        '–',
        h('input', { class: 'input year', type: 'number', placeholder: 'max', value: f.maxYear ?? '', onChange: (e) => { f.maxYear = e.target.value; onChange?.(); } })),
      h('div', { class: 'muted small', style: 'margin-top:6px' }, 'Nothing checked = everything.'));
  };
  paint();
  return root;
}

export function filterSummary(f) {
  const parts = [];
  if (f.subcategories?.length) parts.push(`${f.subcategories.length} subcategor${f.subcategories.length === 1 ? 'y' : 'ies'}`);
  if (f.difficulties?.length) parts.push(`diff ${[...f.difficulties].sort((a, b) => a - b).join(',')}`);
  if (f.minYear || f.maxYear) parts.push(`${f.minYear || '…'}–${f.maxYear || '…'}`);
  return parts.length ? parts.join(' · ') : 'All questions';
}

// Difficulty checkboxes, each with its name and a short description.
export function difficultyPicker(arr, onChange) {
  const toggle = (d, on) => {
    const i = arr.indexOf(d);
    if (on && i < 0) arr.push(d);
    if (!on && i >= 0) arr.splice(i, 1);
    onChange?.();
  };
  const group = (title, levels) => h('div', { class: 'diff-group' },
    h('div', { class: 'label' }, title),
    levels.map((d) => h('label', { class: 'diff-option' },
      h('input', { type: 'checkbox', checked: arr.includes(d), onChange: (e) => toggle(d, e.target.checked) }),
      h('span', { class: 'diff-num' }, d),
      h('span', null, h('span', { class: 'diff-name' }, DIFFICULTIES[d]), h('span', { class: 'diff-desc' }, DIFFICULTY_INFO[d])))));
  return h('div', null,
    h('b', null, 'Difficulty'),
    h('div', { class: 'diff-grid' },
      group('Middle & high school', [1, 2, 3, 4, 5]),
      group('College & open', [6, 7, 8, 9, 10])));
}

export const difficultyChips = (arr) => difficultyPicker(arr);
