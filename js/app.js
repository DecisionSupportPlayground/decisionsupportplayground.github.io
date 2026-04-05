/**
 * app.js — Main application controller for app.html.
 *
 * Responsibilities:
 *   - Owns the single application state object
 *   - Fetches data from the sheet and dispatches to MCDM algorithms
 *   - Wires DOM events (drag-drop, sliders, buttons) to state mutations
 *   - Drives the 5-second polling loop for live collaboration
 *   - Delegates rendering to renderPanel() and renderChart()
 */

import { rankOrderWeights, runMethod, scoreToRank, METHODS } from './mcdm.js';
import {
  parseAlternativesCSV,
  parseRankingsData,
  parseSnapshotsData,
  fetchSheetData,
  fetchLastModified,
  saveRankingToSheet
} from './data.js';
import {
  loadLocalSnapshots,
  saveSnapshot,
  deleteSnapshot,
  mergeSheetSnapshots
} from './snapshots.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TEAM = {
  criteriaOrder: [], // ['I1','I2',...] — index 0 = rank 1 (highest priority)
  selections:    [], // ['A1','A4',...] — selected alternatives
  p:             0,  // weight exponent: 0 | 0.5 | 1
  method:        'topsis',
  lastUpdated:   null,
  isDirty:       false, // unsaved local changes
  isSaving:      false
};

const state = {
  scriptUrl:    null,
  criteria:     [],   // [{id, name, shortName, type}]
  alternatives: [],   // [{id, description, values[]}]
  teams: {
    team1: { ...DEFAULT_TEAM, name: 'Upper Basin' },
    team2: { ...DEFAULT_TEAM, name: 'Lower Basin' }
  },
  results: { team1: [], team2: [] },
  snapshots:       [],
  activeSnapshot:  null,
  lastModified:    null,
  isSyncing:       false,
  syncError:       null,
  pollTimer:       null
};

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const scriptUrl  = localStorage.getItem('madm_script_url');
  const offlineCsv = sessionStorage.getItem('madm_local_csv');
  const isOffline  = new URLSearchParams(window.location.search).get('mode') === 'offline';

  if (!scriptUrl && !offlineCsv) {
    window.location.href = 'index.html?error=no_url';
    return;
  }

  state.scriptUrl = scriptUrl || null;
  state.snapshots = loadLocalSnapshots();

  wireGlobalButtons();
  renderAllPanels();

  if (isOffline && offlineCsv) {
    // Offline mode: parse the locally loaded CSV directly
    const fileName = sessionStorage.getItem('madm_local_csv_name') || 'local file';
    setStatus('offline', `Offline — ${fileName}`);
    try {
      const parsed = parseAlternativesCSV(offlineCsv);
      state.criteria     = parsed.criteria;
      state.alternatives = parsed.alternatives;
      for (const teamId of ['team1', 'team2']) {
        if (!state.teams[teamId].criteriaOrder.length) {
          state.teams[teamId].criteriaOrder = state.criteria.map(c => c.id);
        }
      }
      recomputeAll();
      renderAllPanels();
    } catch (err) {
      setStatus('error', `CSV parse error: ${err.message}`);
    }
    return; // no polling in offline mode
  }

  // Online mode
  setStatus('loading', 'Connecting to sheet…');
  fetchSheetData(scriptUrl)
    .then(applySheetData)
    .catch(err => {
      setStatus('error', `Could not reach sheet: ${err.message}`);
    });

  startPolling();
});

// ─────────────────────────────────────────────────────────────────────────────
// Data ingestion
// ─────────────────────────────────────────────────────────────────────────────

function applySheetData(data) {
  // Alternatives (decision matrix)
  if (data.alternatives && data.alternatives.length > 1) {
    const csvText = _arrayToCsv(data.alternatives);
    try {
      const parsed = parseAlternativesCSV(csvText);
      state.criteria     = parsed.criteria;
      state.alternatives = parsed.alternatives;
    } catch (err) {
      setStatus('error', `Alternatives tab parse error: ${err.message}`);
      return;
    }
  }

  // Rankings
  if (data.rankings) {
    const rankData = parseRankingsData(data.rankings);
    for (const teamId of ['team1', 'team2']) {
      const r = rankData[teamId];
      if (!r) continue;
      // Don't overwrite a team that has unsaved local edits
      if (state.teams[teamId].isDirty) continue;
      Object.assign(state.teams[teamId], {
        criteriaOrder: r.criteriaOrder,
        selections:    r.selections,
        p:             r.p,
        method:        r.method
      });
    }
  }

  // Snapshots
  if (data.snapshots) {
    mergeSheetSnapshots(parseSnapshotsData(data.snapshots));
    state.snapshots = loadLocalSnapshots();
  }

  // Seed criteria order if blank (first load)
  for (const teamId of ['team1', 'team2']) {
    if (!state.teams[teamId].criteriaOrder.length && state.criteria.length) {
      state.teams[teamId].criteriaOrder = state.criteria.map(c => c.id);
    }
  }

  state.lastModified = data.lastModified || null;
  recomputeAll();
  renderAllPanels();
  setStatus('ok', '');
}

// ─────────────────────────────────────────────────────────────────────────────
// MCDM computation
// ─────────────────────────────────────────────────────────────────────────────

function recomputeAll() {
  recompute('team1');
  recompute('team2');
}

function recompute(teamId) {
  const team = state.teams[teamId];
  const { criteria, alternatives } = state;

  if (!alternatives.length || !criteria.length || !team.criteriaOrder.length) {
    state.results[teamId] = [];
    return;
  }

  // Build ordered criteria list (skip any IDs not in current criteria set)
  const orderedCriteria = team.criteriaOrder
    .map(id => criteria.find(c => c.id === id))
    .filter(Boolean);

  if (!orderedCriteria.length) { state.results[teamId] = []; return; }

  const types   = orderedCriteria.map(c => c.type);
  const ranks   = orderedCriteria.map((_, i) => i + 1); // position = rank
  const weights = rankOrderWeights(ranks, team.p);

  // Slice the value columns to match orderedCriteria
  const matrix = alternatives.map(alt =>
    orderedCriteria.map(c => {
      const idx = criteria.findIndex(x => x.id === c.id);
      return idx >= 0 ? (alt.values[idx] ?? 0) : 0;
    })
  );

  let scores;
  try {
    scores = runMethod(team.method, matrix, weights, types);
  } catch {
    scores = alternatives.map(() => 0);
  }
  const ranks2 = scoreToRank(scores);

  state.results[teamId] = alternatives
    .map((alt, i) => ({
      id:          alt.id,
      description: alt.description,
      score:       scores[i],
      rank:        ranks2[i],
      isSelected:  team.selections.includes(alt.id)
    }))
    .sort((a, b) => a.rank - b.rank);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderAllPanels() {
  renderPanel('team1');
  renderPanel('team2');
  renderSnapshotsList();
}

function renderPanel(teamId) {
  renderCriteriaList(teamId);
  renderSettings(teamId);
  renderResults(teamId);
  renderChart(teamId);
}

function renderCriteriaList(teamId) {
  const team = state.teams[teamId];
  const listEl = document.getElementById(`${teamId}-criteria-list`);
  if (!listEl) return;

  // Maintain current Sortable instance
  if (listEl._sortable) { listEl._sortable.destroy(); }

  listEl.innerHTML = '';
  team.criteriaOrder.forEach((criterionId, idx) => {
    const c = state.criteria.find(x => x.id === criterionId);
    if (!c) return;

    const li = document.createElement('li');
    li.className = 'criterion-item';
    li.dataset.id = criterionId;

    const typeIcon  = c.type === 1 ? '↑' : '↓';
    const typeLabel = c.type === 1 ? 'benefit' : 'cost';

    li.innerHTML = `
      <span class="drag-handle" aria-label="Drag to reorder">⠿</span>
      <span class="criterion-rank">${idx + 1}</span>
      <span class="criterion-name" title="${escHtml(c.name)}">${escHtml(c.shortName)}</span>
      <span class="criterion-type ${typeLabel}" title="${typeLabel}: ${typeLabel === 'benefit' ? 'the higher the better' : 'the higher the worst'}">${typeIcon}</span>
    `;
    listEl.appendChild(li);
  });

  // Re-initialise SortableJS
  listEl._sortable = Sortable.create(listEl, {
    animation:  150,
    handle:     '.drag-handle',
    ghostClass: 'sortable-ghost',
    onEnd() {
      const newOrder = [...listEl.querySelectorAll('.criterion-item')].map(el => el.dataset.id);
      state.teams[teamId].criteriaOrder = newOrder;
      state.teams[teamId].isDirty = true;
      recompute(teamId);
      // Update rank numbers without full re-render (avoids disrupting drag)
      listEl.querySelectorAll('.criterion-rank').forEach((el, i) => { el.textContent = i + 1; });
      renderResults(teamId);
      renderChart(teamId);
      updateDirtyIndicator(teamId);
    }
  });
}

function renderSettings(teamId) {
  const team = state.teams[teamId];

  const slider = document.getElementById(`${teamId}-p-slider`);
  if (slider) {
    slider.value = String(team.p);
    updatePLabel(teamId, team.p);
  }

  document.querySelectorAll(`#${teamId}-panel .method-tab`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === team.method);
  });

  updateDirtyIndicator(teamId);
}

function updateDirtyIndicator(teamId) {
  const btn = document.getElementById(`${teamId}-save-btn`);
  if (!btn) return;
  btn.classList.toggle('dirty', state.teams[teamId].isDirty);
  btn.textContent = state.teams[teamId].isSaving
    ? 'Saving…'
    : state.teams[teamId].isDirty ? 'Save Ranking ●' : 'Save Ranking';
}

function renderResults(teamId) {
  const team    = state.teams[teamId];
  const results = state.results[teamId] ?? [];
  const tbody   = document.getElementById(`${teamId}-results-body`);
  const filterEl = document.getElementById(`${teamId}-filter-selected`);
  if (!tbody) return;

  const selectedOnly = filterEl?.checked && team.selections.length > 0;
  const rows = selectedOnly ? results.filter(r => r.isSelected) : results;

  tbody.innerHTML = rows.map(r => `
    <tr class="${r.isSelected ? 'selected-alt' : ''}">
      <td class="rank-cell">${r.rank}</td>
      <td class="id-cell">${escHtml(r.id)}</td>
      <td class="desc-cell">${escHtml(r.description)}</td>
      <td class="score-cell">${r.score.toFixed(3)}</td>
      <td class="sel-cell">
        <input type="checkbox" class="alt-checkbox"
               data-team="${teamId}" data-alt="${escHtml(r.id)}"
               ${r.isSelected ? 'checked' : ''}>
      </td>
    </tr>
  `).join('');
}

function renderChart(teamId) {
  const canvas = document.getElementById(`${teamId}-chart`);
  if (!canvas || typeof Chart === 'undefined') return;

  const results = state.results[teamId] ?? [];
  if (!results.length) {
    if (canvas._chart) { canvas._chart.destroy(); canvas._chart = null; }
    return;
  }

  // Read colors from CSS variables so they always match the current palette
  const style       = getComputedStyle(document.documentElement);
  const teamColor   = style.getPropertyValue(teamId === 'team1' ? '--team1' : '--team2').trim();
  const selectedColor = style.getPropertyValue(teamId === 'team1' ? '--team1-dark' : '--team2-dark').trim();
  const gridColor   = style.getPropertyValue('--border').trim();
  const tickColor   = style.getPropertyValue('--text-muted').trim();

  const labels  = results.map(r => r.id);
  const scores  = results.map(r => r.score);
  const colors  = results.map(r => r.isSelected ? selectedColor : teamColor + 'aa');
  const borders = results.map(r => r.isSelected ? selectedColor : teamColor);

  const chartData = {
    labels,
    datasets: [{
      label: 'Score',
      data: scores,
      backgroundColor: colors,
      borderColor: borders,
      borderWidth: 1
    }]
  };

  if (canvas._chart) {
    canvas._chart.data = chartData;
    canvas._chart.update('none');
    return;
  }

  canvas._chart = new Chart(canvas, {
    type: 'bar',
    data: chartData,
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` Score: ${ctx.parsed.x.toFixed(3)}`
          }
        }
      },
      scales: {
        x: {
          min: 0,
          title: { display: true, text: 'Score', color: tickColor },
          ticks: { color: tickColor },
          grid:  { color: gridColor }
        },
        y: {
          ticks: { color: tickColor, font: { size: 11 } },
          grid:  { color: gridColor }
        }
      }
    }
  });
}

function renderSnapshotsList() {
  const list = document.getElementById('snapshots-list');
  if (!list) return;
  list.innerHTML = state.snapshots.length === 0
    ? '<li class="empty-msg">No snapshots saved yet.</li>'
    : state.snapshots
        .slice()
        .reverse()
        .map(s => `
          <li class="snapshot-item ${state.activeSnapshot?.id === s.id ? 'active' : ''}">
            <button class="snapshot-load" data-id="${escHtml(s.id)}">
              <strong>${escHtml(s.name)}</strong>
              <span class="snapshot-ts">${new Date(s.timestamp).toLocaleString()}</span>
            </button>
            <button class="snapshot-delete btn-icon" data-id="${escHtml(s.id)}" title="Delete">✕</button>
          </li>
        `).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────────

function wireGlobalButtons() {
  // Refresh now
  document.getElementById('refresh-btn')?.addEventListener('click', () => {
    if (!state.scriptUrl) return;
    setStatus('loading', 'Refreshing…');
    fetchSheetData(state.scriptUrl)
      .then(applySheetData)
      .catch(err => setStatus('error', err.message));
  });

  // Disconnect (return to landing)
  document.getElementById('disconnect-btn')?.addEventListener('click', () => {
    if (confirm('Disconnect from this sheet and return to the start page?')) {
      localStorage.removeItem('madm_script_url');
      window.location.href = 'index.html';
    }
  });

  // Save ranking buttons
  document.getElementById('team1-save-btn')?.addEventListener('click', () => saveRanking('team1'));
  document.getElementById('team2-save-btn')?.addEventListener('click', () => saveRanking('team2'));

  // p-value sliders
  ['team1', 'team2'].forEach(teamId => {
    const slider = document.getElementById(`${teamId}-p-slider`);
    slider?.addEventListener('input', () => {
      const p = parseFloat(slider.value);
      state.teams[teamId].p = p;
      state.teams[teamId].isDirty = true;
      updatePLabel(teamId, p);
      recompute(teamId);
      renderResults(teamId);
      renderChart(teamId);
      updateDirtyIndicator(teamId);
    });
  });

  // Method tabs (event delegation on each panel)
  document.querySelectorAll('.method-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const teamId = btn.closest('.team-panel')?.id?.replace('-panel', '');
      if (!teamId) return;
      state.teams[teamId].method  = btn.dataset.method;
      state.teams[teamId].isDirty = true;
      document.querySelectorAll(`#${teamId}-panel .method-tab`).forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      recompute(teamId);
      renderResults(teamId);
      renderChart(teamId);
      updateDirtyIndicator(teamId);
    });
  });

  // Filter-selected checkboxes (event delegation)
  document.addEventListener('change', e => {
    if (e.target.classList.contains('filter-checkbox')) {
      const teamId = e.target.dataset.team;
      if (teamId) renderResults(teamId);
    }

    // Alternative selection checkboxes
    if (e.target.classList.contains('alt-checkbox')) {
      const { team: teamId, alt } = e.target.dataset;
      if (!teamId || !alt) return;
      const sels = state.teams[teamId].selections;
      if (e.target.checked) {
        if (!sels.includes(alt)) sels.push(alt);
      } else {
        state.teams[teamId].selections = sels.filter(a => a !== alt);
      }
      state.teams[teamId].isDirty = true;
      recompute(teamId);   // isSelected flag changes
      renderResults(teamId);
      renderChart(teamId);
      updateDirtyIndicator(teamId);
    }
  });

  // Save snapshot
  document.getElementById('save-snapshot-btn')?.addEventListener('click', async () => {
    const name = prompt('Snapshot name:', `Snapshot ${new Date().toLocaleTimeString()}`);
    if (name === null) return; // cancelled
    const snap = await saveSnapshot(name, _captureState(), state.scriptUrl);
    state.snapshots = loadLocalSnapshots();
    state.activeSnapshot = snap;
    renderSnapshotsList();
  });

  // Snapshots list — load or delete (event delegation)
  document.getElementById('snapshots-list')?.addEventListener('click', e => {
    const loadBtn   = e.target.closest('.snapshot-load');
    const deleteBtn = e.target.closest('.snapshot-delete');

    if (loadBtn) {
      const id = loadBtn.dataset.id;
      const snap = state.snapshots.find(s => s.id === id);
      if (!snap) return;
      if (!confirm(`Load snapshot "${snap.name}"? Unsaved changes will be lost.`)) return;
      _restoreState(snap.state);
      state.activeSnapshot = snap;
      recomputeAll();
      renderAllPanels();
    }

    if (deleteBtn) {
      const id = deleteBtn.dataset.id;
      const snap = state.snapshots.find(s => s.id === id);
      if (!snap) return;
      if (!confirm(`Delete snapshot "${snap.name}"?`)) return;
      deleteSnapshot(id, state.scriptUrl).then(() => {
        state.snapshots = loadLocalSnapshots();
        if (state.activeSnapshot?.id === id) state.activeSnapshot = null;
        renderSnapshotsList();
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Save ranking to sheet
// ─────────────────────────────────────────────────────────────────────────────

async function saveRanking(teamId) {
  if (!state.scriptUrl) return;
  const team = state.teams[teamId];
  team.isSaving = true;
  updateDirtyIndicator(teamId);

  try {
    await saveRankingToSheet(state.scriptUrl, teamId, {
      criteriaOrder: team.criteriaOrder,
      selections:    team.selections,
      p:             team.p,
      method:        team.method
    });
    team.isDirty = false;
    team.lastUpdated = new Date().toISOString();
    showToast(`${team.name} ranking saved.`);
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  } finally {
    team.isSaving = false;
    updateDirtyIndicator(teamId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────────────────────────

function startPolling() {
  if (!state.scriptUrl) return;
  state.pollTimer = setInterval(async () => {
    if (state.isSyncing) return;
    state.isSyncing = true;
    try {
      const ts = await fetchLastModified(state.scriptUrl);
      if (ts && ts !== state.lastModified) {
        const data = await fetchSheetData(state.scriptUrl);
        applySheetData(data);
      }
      setStatus('ok', '');
    } catch {
      setStatus('offline', 'Sheet unreachable — working offline');
    } finally {
      state.isSyncing = false;
    }
  }, 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(type, message) {
  const el  = document.getElementById('sync-status');
  const dot = document.getElementById('sync-dot');
  if (!el) return;
  el.textContent = message;
  ['ok', 'loading', 'error', 'offline'].forEach(c => el.classList.remove(c));
  el.classList.add(type);
  if (dot) {
    dot.className = `sync-dot ${type}`;
    dot.title = message || type;
  }
  // Update "last synced" timestamp
  if (type === 'ok') {
    const ts = document.getElementById('last-synced');
    if (ts) ts.textContent = `Last synced: ${new Date().toLocaleTimeString()}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────────────────────────────────────

function _captureState() {
  return {
    teams: {
      team1: { ...state.teams.team1 },
      team2: { ...state.teams.team2 }
    },
    results: {
      team1: state.results.team1.map(r => ({ ...r })),
      team2: state.results.team2.map(r => ({ ...r }))
    }
  };
}

function _restoreState(saved) {
  for (const teamId of ['team1', 'team2']) {
    if (saved.teams?.[teamId]) {
      Object.assign(state.teams[teamId], {
        criteriaOrder: saved.teams[teamId].criteriaOrder ?? [],
        selections:    saved.teams[teamId].selections    ?? [],
        p:             saved.teams[teamId].p             ?? 0,
        method:        saved.teams[teamId].method        ?? 'topsis',
        isDirty:       true  // restored state counts as unsaved
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function updatePLabel(teamId, p) {
  const label = document.getElementById(`${teamId}-p-label`);
  if (!label) return;
  const labels = { 0: 'Equal weights (p = 0)', 0.5: 'Moderate priority (p = 0.5)', 1: 'Strong priority (p = 1)' };
  label.textContent = labels[p] ?? `p = ${p}`;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a 2D array of values to a CSV string (for reuse of parseAlternativesCSV). */
function _arrayToCsv(rows) {
  return rows.map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  ).join('\n');
}
