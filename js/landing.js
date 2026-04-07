/**
 * landing.js — Controller for index.html (the landing / connection page).
 *
 * Handles:
 *   - Launching the app with an Apps Script URL
 *   - Loading a local CSV file (offline / no-sheet mode)
 *   - Resuming a previous session stored in localStorage
 *   - Downloading the Apps Script template file
 */

import { initTheme } from './theme.js';

document.addEventListener('DOMContentLoaded', () => {
  initTheme(); // no re-render callback needed on the landing page
  // Show error banner if redirected here with ?error=
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'no_url') {
    showBanner('No sheet URL found — please connect a sheet or load a CSV file.', 'warn');
  }

  // If there is an existing connection, offer to resume it
  const existing = localStorage.getItem('madm_script_url');
  if (existing) {
    const resumeSection = document.getElementById('resume-section');
    if (resumeSection) {
      const preview = existing.length > 60 ? existing.slice(0, 57) + '…' : existing;
      document.getElementById('resume-url-preview').textContent = preview;
      resumeSection.hidden = false;
    }
  }

  // ── Launch with Apps Script URL ──────────────────────────────────────────
  const urlInput  = document.getElementById('script-url-input');
  const launchBtn = document.getElementById('launch-btn');

  launchBtn?.addEventListener('click', () => {
    const url = (urlInput?.value ?? '').trim();
    if (!url) { showBanner('Please paste an Apps Script URL first.', 'warn'); return; }
    if (!url.startsWith('https://script.google.com/')) {
      showBanner('That doesn\'t look like a Google Apps Script URL (should start with https://script.google.com/).', 'warn');
      return;
    }
    localStorage.setItem('madm_script_url', url);
    window.location.href = 'app.html';
  });

  // Allow pressing Enter in the input to launch
  urlInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') launchBtn?.click();
  });

  // ── Resume existing session ───────────────────────────────────────────────
  document.getElementById('resume-btn')?.addEventListener('click', () => {
    window.location.href = 'app.html';
  });

  document.getElementById('forget-btn')?.addEventListener('click', () => {
    localStorage.removeItem('madm_script_url');
    document.getElementById('resume-section').hidden = true;
    showBanner('Disconnected from previous sheet.', 'info');
  });

  // ── Load local CSV file (offline mode) ───────────────────────────────────
  document.getElementById('load-csv-btn')?.addEventListener('click', () => {
    document.getElementById('csv-file-input')?.click();
  });

  document.getElementById('csv-file-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      // Store the raw CSV text in sessionStorage so app.html can read it
      sessionStorage.setItem('madm_local_csv', ev.target.result);
      sessionStorage.setItem('madm_local_csv_name', file.name);
      localStorage.removeItem('madm_script_url'); // no sheet URL for offline mode
      window.location.href = 'app.html?mode=offline';
    };
    reader.readAsText(file);
  });

  // Download Template is a plain <a download> link — no JS handler needed.
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function showBanner(message, type = 'info') {
  const banner = document.getElementById('banner');
  if (!banner) return;
  banner.textContent = message;
  banner.className   = `banner banner-${type}`;
  banner.hidden      = false;
}
