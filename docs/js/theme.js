// Light/dark toggle. Defaults to the system setting; a click saves an explicit choice on this device.
const KEY = 'qbstudy-theme';
const root = document.documentElement;
const media = matchMedia('(prefers-color-scheme: dark)');

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

const current = () => root.dataset.theme || (media.matches ? 'dark' : 'light');

function paint(btn) {
  const dark = current() === 'dark';
  btn.innerHTML = dark ? SUN : MOON;
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

export function initThemeToggle(btn) {
  paint(btn);
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.classList.add('theme-anim');
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch {}
    paint(btn);
    setTimeout(() => root.classList.remove('theme-anim'), 300);
  });
  media.addEventListener('change', () => paint(btn));
}
