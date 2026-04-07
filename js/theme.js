/**
 * theme.js — Light/dark theme toggle, shared by app.js and landing.js.
 *
 * Call initTheme() once in DOMContentLoaded.
 * The saved preference is applied immediately via the module-level IIFE so
 * there is no flash of the wrong theme before the DOM loads.
 */

// Apply saved preference before first paint
const _saved = localStorage.getItem('madm_theme') ?? 'dark';
document.documentElement.dataset.theme = _saved;

export function initTheme(onToggle) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.textContent = document.documentElement.dataset.theme === 'light' ? '🌙' : '☀';
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('madm_theme', next);
    document.documentElement.dataset.theme = next;
    btn.textContent = next === 'light' ? '🌙' : '☀';
    onToggle?.();
  });
}
