// Category / difficulty / year filter panel shared by Reader, Search and Frequency views.
import { h, CATEGORIES, ALT_SUBCATEGORIES, DIFFICULTIES, DIFFICULTY_INFO } from './util.js?v=5da9d5ed';

export function filterPanel(f, onChange, { years = true } = {}) {
  f.subcategories ||= [];
  f.alternateSubcategories ||= [];
  f.difficulties ||= [];
  const changed = () => { paint(); onChange?.(); };
  const root = h('div', { class: 'filters' });

  const toggle = (arr, v, on) => {
    const i = arr.indexOf(v);
    if (on && i < 0) arr.push(v);
    if (!on && i >= 0) arr.splice(i, 1);
  };

  const short = (s) => s.replace(/ (Literature|History|Fine Arts|Pop Culture|Science)$/, '') || s;
  const altName = (a) => (/^(Misc|Other) /.test(a) ? 'Misc' : a);
  const box = (checked, onChange, indeterminate = false) => {
    const el = h('input', { type: 'checkbox', checked, onChange: (e) => { onChange(e.target.checked); changed(); } });
    el.indeterminate = indeterminate;
    return el;
  };
  const altsOn = (parent) => (ALT_SUBCATEGORIES[parent] || []).filter((a) => f.alternateSubcategories.includes(a));
  const clearAlts = (parent) => (ALT_SUBCATEGORIES[parent] || []).forEach((a) => toggle(f.alternateSubcategories, a, false));

  // Finer picks under a subcategory: all shown checked while the whole subcategory is on.
  // Unchecking one narrows to the rest; checking the last one collapses back to the subcategory.
  const altList = (parent) => h('div', { class: 'subs alts' }, ALT_SUBCATEGORIES[parent].map((a) => h('label', { class: 'sub' },
    box(f.subcategories.includes(parent) || f.alternateSubcategories.includes(a), (on) => {
      if (f.subcategories.includes(parent)) {
        toggle(f.subcategories, parent, false);
        ALT_SUBCATEGORIES[parent].forEach((x) => toggle(f.alternateSubcategories, x, x !== a));
      } else {
        toggle(f.alternateSubcategories, a, on);
        if (altsOn(parent).length === ALT_SUBCATEGORIES[parent].length) { clearAlts(parent); toggle(f.subcategories, parent, true); }
      }
    }), ' ', altName(a))));

  const subRow = (s) => [
    h('label', { class: 'sub' },
      box(f.subcategories.includes(s), (on) => { toggle(f.subcategories, s, on); clearAlts(s); },
        !f.subcategories.includes(s) && altsOn(s).length > 0),
      ' ', short(s)),
    ALT_SUBCATEGORIES[s] && altList(s),
  ];

  const paint = () => {
    const cats = Object.entries(CATEGORIES).map(([cat, subs]) => {
      const nOn = subs.filter((s) => f.subcategories.includes(s)).length;
      const partial = subs.some((s) => altsOn(s).length) || altsOn(cat).length > 0;
      const catBox = box(nOn === subs.length, (on) => {
        subs.forEach((s) => { toggle(f.subcategories, s, on); clearAlts(s); });
        if (!on) clearAlts(cat);
      }, nOn < subs.length && (nOn > 0 || partial));
      return h('div', { class: 'cat' },
        h('label', { class: 'cat-name' }, catBox, ' ', cat),
        subs.length > 1 && h('div', { class: 'subs' }, subs.map(subRow)),
        subs.length === 1 && ALT_SUBCATEGORIES[subs[0]] && altList(subs[0]),
        ALT_SUBCATEGORIES[cat] && !subs.includes(cat) && h('div', { class: 'subs' },
          h('div', { class: 'label alt-label' }, 'Genre'),
          ALT_SUBCATEGORIES[cat].map((a) => h('label', { class: 'sub' },
            box(f.alternateSubcategories.includes(a), (on) => toggle(f.alternateSubcategories, a, on)), ' ', altName(a)))));
    });
    root.replaceChildren(
      h('div', { class: 'row between' }, h('b', null, 'Categories'),
        h('span', { class: 'row gap-s' },
          h('button', { class: 'btn tiny ghost', onClick: () => { f.subcategories.length = 0; f.alternateSubcategories.length = 0; f.difficulties.length = 0; f.minYear = ''; f.maxYear = ''; changed(); } }, 'Clear all'))),
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
  const nSubs = (f.subcategories?.length || 0) + (f.alternateSubcategories?.length || 0);
  if (nSubs) parts.push(`${nSubs} subcategor${nSubs === 1 ? 'y' : 'ies'}`);
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
