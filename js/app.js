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

import { rankOrderWeights, runMethod, scoreToRank } from './mcdm.js';
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

const TEAMS = ['team1', 'team2'];

const DEFAULT_TEAM = {
  criteriaOrder: [], // ['I1','I2',...] — index 0 = rank 1 (highest priority)
  selections:    [], // ['A1','A4',...] — selected alternatives
  lastUpdated:   null,
  isDirty:       false, // unsaved local changes
  isSaving:      false
};

const state = {
  scriptUrl:    null,
  criteria:     [],   // [{id, name, shortName, type}]
  alternatives: [],   // [{id, description, values[]}]
  p:            0,    // shared weight exponent: 0 | 0.5 | 1
  method:       'topsis', // shared MCDM method
  teams: {
    team1: { ...DEFAULT_TEAM, name: 'Upper Basin' },
    team2: { ...DEFAULT_TEAM, name: 'Lower Basin' }
  },
  results: { team1: [], team2: [] },
  snapshots:       [],
  activeSnapshot:  null,
  lastModified:    null,
  isSyncing:       false,
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
      for (const teamId of TEAMS) {
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
    // Apply shared p/method from team1 data (or team2 if team1 absent),
    // but only if neither team has unsaved local changes.
    const anyDirty = state.teams.team1.isDirty || state.teams.team2.isDirty;
    if (!anyDirty) {
      const shared = rankData.team1 ?? rankData.team2;
      if (shared) {
        state.p      = shared.p;
        state.method = shared.method;
      }
    }
    for (const teamId of TEAMS) {
      const r = rankData[teamId];
      if (!r) continue;
      // Don't overwrite a team that has unsaved local edits
      if (state.teams[teamId].isDirty) continue;
      Object.assign(state.teams[teamId], {
        criteriaOrder: r.criteriaOrder,
        selections:    r.selections
      });
      // Apply team name from sheet if provided
      if (r.teamName) {
        state.teams[teamId].name = r.teamName;
        const nameEl = document.getElementById(`${teamId}-name`);
        if (nameEl) nameEl.textContent = r.teamName;
      }
    }
  }

  // Snapshots
  if (data.snapshots) {
    mergeSheetSnapshots(parseSnapshotsData(data.snapshots));
    state.snapshots = loadLocalSnapshots();
  }

  // Seed criteria order if blank (first load)
  for (const teamId of TEAMS) {
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
  const weights = rankOrderWeights(ranks, state.p); // shared p

  // Slice the value columns to match orderedCriteria
  const matrix = alternatives.map(alt =>
    orderedCriteria.map(c => {
      const idx = criteria.findIndex(x => x.id === c.id);
      return idx >= 0 ? (alt.values[idx] ?? 0) : 0;
    })
  );

  let scores;
  try {
    scores = runMethod(state.method, matrix, weights, types); // shared method
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
  renderSharedSettings();
  for (const teamId of TEAMS) renderPanel(teamId);
  renderCombinedChart();
  renderSnapshotsList();
}

function renderPanel(teamId) {
  renderCriteriaList(teamId);
  renderResults(teamId);
  renderChart(teamId);
}

function renderCriteriaList(teamId) {
  const team = state.teams[teamId];
  const listEl = document.getElementById(`${teamId}-criteria-list`);
  if (!listEl) return;

  // Maintain current Sortable instance
  if (listEl._sortable) { listEl._sortable.destroy(); }

  // Compute weights for the current order and the shared p-value
  const n = team.criteriaOrder.length;
  const weights = n > 0
    ? rankOrderWeights(team.criteriaOrder.map((_, i) => i + 1), state.p)
    : [];

  listEl.innerHTML = '';
  team.criteriaOrder.forEach((criterionId, idx) => {
    const c = state.criteria.find(x => x.id === criterionId);
    if (!c) return;

    const li = document.createElement('li');
    li.className = 'criterion-item';
    li.dataset.id = criterionId;

    const typeIcon  = c.type === 1 ? '↑' : '↓';
    const typeLabel = c.type === 1 ? 'benefit' : 'cost';
    const weightPct = weights[idx] !== undefined ? (weights[idx] * 100).toFixed(1) + '%' : '';

    li.innerHTML = `
      <span class="drag-handle" aria-label="Drag to reorder">⠿</span>
      <span class="criterion-rank">${idx + 1}</span>
      <span class="criterion-name" title="${escHtml(c.name)}">${escHtml(c.shortName)}</span>
      <span class="criterion-weight">${escHtml(weightPct)}</span>
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
      // Full re-render to update rank numbers and weights
      renderCriteriaList(teamId);
      renderResults(teamId);
      renderChart(teamId);
      renderCombinedChart();
      updateDirtyIndicator(teamId);
    }
  });
}

function renderSharedSettings() {
  const slider = document.getElementById('shared-p-slider');
  if (slider) {
    slider.value = String(state.p);
    updatePLabel(state.p);
  }
  document.querySelectorAll('#shared-method-tabs .method-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === state.method);
  });
  for (const teamId of TEAMS) updateDirtyIndicator(teamId);
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

  const otherId     = teamId === 'team1' ? 'team2' : 'team1';
  const ownSels     = new Set(state.teams[teamId].selections);
  const otherSels   = new Set(state.teams[otherId].selections);
  const allSels     = new Set([...ownSels, ...otherSels]);
  const filterEl    = document.getElementById(`${teamId}-filter-selected`);
  const selectedOnly = filterEl?.checked ?? false;
  // When filtering: show the union of both teams' selections
  const combinedFilterEl = document.getElementById('combined-filter-selected');
  const anyFilter   = selectedOnly || (combinedFilterEl?.checked ?? false);

  let results = state.results[teamId] ?? [];
  if (!results.length) { _destroyChart(canvas); return; }

  // When filter is active, show union; each result gets selection grade:
  //   'own'   = this team selected it  → full opacity
  //   'other' = only other team        → faded (shows shared context)
  //   'none'  = neither               → hidden (filtered out)
  if (anyFilter) results = results.filter(r => allSels.has(r.id));
  const graded = results.map(r => ({
    ...r,
    isOwn:   ownSels.has(r.id),
    isOther: !ownSels.has(r.id) && otherSels.has(r.id)
  }));

  const color = _cssVar(teamId === 'team1' ? '--team1' : '--team2');
  _renderBarChart(canvas, graded, color);
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

function renderCombinedChart() {
  const canvas = document.getElementById('combined-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const r1 = state.results.team1 ?? [];
  const r2 = state.results.team2 ?? [];
  if (!r1.length && !r2.length) { _destroyChart(canvas); return; }

  const hasT1   = r1.length > 0;
  const hasT2   = r2.length > 0;
  const divisor = (hasT1 ? 1 : 0) + (hasT2 ? 1 : 0);

  const allIds  = [...new Set([...r1.map(r => r.id), ...r2.map(r => r.id)])];
  const descMap = {};
  for (const r of [...r1, ...r2]) descMap[r.id] = r.description;

  const allSelections = new Set([
    ...state.teams.team1.selections,
    ...state.teams.team2.selections
  ]);
  const filterEl     = document.getElementById('combined-filter-selected');
  const selectedOnly = filterEl?.checked ?? false;

  // Each entry carries per-team scores so we can build marker datasets below
  let sorted = allIds
    .map(id => {
      const s1  = hasT1 ? (r1.find(r => r.id === id)?.score ?? null) : null;
      const s2  = hasT2 ? (r2.find(r => r.id === id)?.score ?? null) : null;
      const avg = divisor > 0 ? ((s1 ?? 0) + (s2 ?? 0)) / divisor : 0;
      return { id, description: descMap[id] || id, score: avg, score1: s1, score2: s2,
               isSelected: allSelections.has(id) };
    })
    .sort((a, b) => b.score - a.score);

  if (selectedOnly) sorted = sorted.filter(r => r.isSelected);

  // Team score markers: a line dataset per team, points only (no connecting line).
  // pointStyle:'line' + rotation:90 renders a short vertical tick at each score.
  const _marker = (color, name, scores) => ({
    type: 'line',
    label: name,
    data: scores,
    showLine: false,
    pointStyle: 'line',
    pointRadius: 6,
    pointRotation: 90,
    pointBorderColor: color,
    pointBorderWidth: 2,
    borderColor: color,
    backgroundColor: color,
    order: 1
  });

  const extraDatasets = [];
  if (hasT1) extraDatasets.push(_marker(_cssVar('--team1'), state.teams.team1.name || 'Upper Basin', sorted.map(r => r.score1)));
  if (hasT2) extraDatasets.push(_marker(_cssVar('--team2'), state.teams.team2.name || 'Lower Basin', sorted.map(r => r.score2)));

  _renderBarChart(canvas, sorted, _cssVar('--combined'), { extraDatasets, showLegend: extraDatasets.length > 0 });
}

/**
 * Shared horizontal bar chart renderer used by all three score charts.
 *
 * Every bar is a fixed pixel height (BAR_PX) so bar thickness looks identical
 * across all charts regardless of how many alternatives each shows.
 * The container height is set in JS to n_bars × BAR_PX + axis overhead.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{id, description, score, isSelected}>} results  sorted descending
 * @param {string} color  CSS hex color for this chart's accent
 * @param {{ extraDatasets?: object[], showLegend?: boolean }} [opts]
 */
function _renderBarChart(canvas, results, color, opts = {}) {
  const { extraDatasets = [], showLegend = false } = opts;

  const gridColor   = _cssVar('--border');
  const tickColor   = _cssVar('--text-muted');
  // Opacity levels:
  //   own selection (or combined selected) → full solid
  //   other team's selection only          → mid opacity (visible but clearly secondary)
  //   not selected                         → low opacity
  const solid        = color;
  const otherOpacity = _hexToRgba(color, 0.55);
  const faint        = _hexToRgba(color, 0.30);
  const faintBorder  = _hexToRgba(color, 0.55);

  const _bg  = r => r.isOwn !== undefined
    ? (r.isOwn ? solid : otherOpacity)
    : (r.isSelected ? solid : faint);
  const _bdr = r => r.isOwn !== undefined
    ? (r.isOwn ? solid : otherOpacity)
    : (r.isSelected ? solid : faintBorder);

  // Fixed px per bar — same value for all charts so bars are always identical size
  const BAR_PX    = 13;
  const AXIS_PX   = 36;
  const LEGEND_PX = showLegend ? 24 : 0;
  const targetH   = Math.max(60, results.length * BAR_PX + AXIS_PX + LEGEND_PX);
  const wrap      = canvas.parentElement;
  if (wrap) wrap.style.height = targetH + 'px';

  const chartData = {
    labels: results.map(r => r.id),
    datasets: [
      {
        label: 'Score',
        data:            results.map(r => r.score),
        backgroundColor: results.map(r => _bg(r)),
        borderColor:     results.map(r => _bdr(r)),
        borderWidth: 1,
        barThickness: 8,
        categoryPercentage: 0.6,
        barPercentage: 0.9,
        order: 2
      },
      ...extraDatasets
    ]
  };

  if (canvas._chart) {
    canvas._results = results;
    canvas._chart.data = chartData;
    canvas._chart.resize();
    canvas._chart.update('none');
    return;
  }

  canvas._results = results;
  canvas._chart = new Chart(canvas, {
    type: 'bar',
    data: chartData,
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: showLegend,
          position: 'top',
          labels: { color: tickColor, boxWidth: 10, padding: 10, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            title: ctx => {
              const r = (canvas._results ?? [])[ctx[0]?.dataIndex];
              if (r) return r.description ? `${r.id}: ${r.description}` : r.id;
              return ctx[0]?.label || '';
            },
            label: ctx => {
              const v = ctx.parsed.x;
              const name = ctx.dataset.label || 'Score';
              return ` ${name}: ${v != null ? v.toFixed(3) : 'N/A'}`;
            }
          }
        }
      },
      scales: _baseChartScales(tickColor, gridColor)
    }
  });
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

  // Shared p-value slider — affects both teams
  const sharedSlider = document.getElementById('shared-p-slider');
  sharedSlider?.addEventListener('input', () => {
    state.p = parseFloat(sharedSlider.value);
    updatePLabel(state.p);
    _onSharedSettingChanged();
  });

  // Shared method tabs — affects both teams
  document.querySelectorAll('#shared-method-tabs .method-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.method = btn.dataset.method;
      document.querySelectorAll('#shared-method-tabs .method-tab').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      _onSharedSettingChanged();
    });
  });

  // Filter-selected checkboxes (event delegation)
  document.addEventListener('change', e => {
    if (e.target.classList.contains('filter-checkbox')) {
      // Any filter change affects all three charts (union of both selections)
      for (const teamId of TEAMS) { renderResults(teamId); renderChart(teamId); }
      renderCombinedChart();
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
      for (const id of TEAMS) renderChart(id); // both charts reflect updated selections
      renderCombinedChart();
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
      p:             state.p,      // shared
      method:        state.method, // shared
      teamName:      team.name
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
    p:      state.p,
    method: state.method,
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
  if (saved.p      !== undefined) state.p      = saved.p;
  if (saved.method !== undefined) state.method = saved.method;
  // Support snapshots saved before shared-settings refactor
  const legacyP      = saved.teams?.team1?.p      ?? saved.teams?.team2?.p;
  const legacyMethod = saved.teams?.team1?.method  ?? saved.teams?.team2?.method;
  if (state.p      === 0       && legacyP      !== undefined) state.p      = legacyP;
  if (state.method === 'topsis' && legacyMethod !== undefined) state.method = legacyMethod;

  for (const teamId of TEAMS) {
    if (saved.teams?.[teamId]) {
      Object.assign(state.teams[teamId], {
        criteriaOrder: saved.teams[teamId].criteriaOrder ?? [],
        selections:    saved.teams[teamId].selections    ?? [],
        isDirty:       true  // restored state counts as unsaved
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function updatePLabel(p) {
  const label = document.getElementById('shared-p-label');
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

/** Read a CSS custom property value from :root. */
function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Shared Chart.js scale config for all score bar charts.
 * Both team charts and the combined chart use the same axis structure.
 */
function _baseChartScales(tickColor, gridColor) {
  return {
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
  };
}

/** Destroy the Chart.js instance on a canvas element if one exists. */
function _destroyChart(canvas) {
  if (canvas._chart) { canvas._chart.destroy(); canvas._chart = null; }
}

/**
 * Recompute and re-render both teams after a shared setting (p or method) changes.
 * Marks both teams dirty, recomputes scores, and refreshes all dependent views.
 */
function _onSharedSettingChanged() {
  for (const teamId of TEAMS) {
    state.teams[teamId].isDirty = true;
    recompute(teamId);
    renderPanel(teamId);
    updateDirtyIndicator(teamId);
  }
  renderCombinedChart();
}

/** Convert a CSS hex color (#rrggbb) to rgba(r,g,b,alpha) for canvas compatibility. */
function _hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
