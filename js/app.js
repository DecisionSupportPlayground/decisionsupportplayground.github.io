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

import { initMCDM, rankOrderWeights, runMethod, scoreToRank } from './mcdm.js';
import { initTheme } from './theme.js';
import {
  parseAlternativesCSV,
  parseRankingsData,
  parseSnapshotsData,
  fetchSheetData,
  fetchLastModified,
  saveRankingToSheet,
  logEvent
} from './data.js';
import {
  loadLocalSnapshots,
  saveSnapshot,
  deleteSnapshot,
  mergeSheetSnapshots
} from './snapshots.js';

let _pyodideReady = false;


// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const TEAMS     = ['team1', 'team2'];
const CACHE_KEY = 'madm_sheet_cache';

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
  results:         { team1: [], team2: [] },
  selectedResults: { team1: [], team2: [] }, // recalculated using selected alts only
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
  initTheme(() => renderAllPanels());
  renderAllPanels();

  // Position and close .method-info popovers
  function _openMethodInfo(details) {
    document.querySelectorAll('.method-info[open]').forEach(d => {
      if (d !== details) d.removeAttribute('open');
    });
    if (!details.open) details.setAttribute('open', '');
    const icon  = details.querySelector('.method-info-icon');
    const panel = details.querySelector('.method-info-panel');
    if (!icon || !panel) return;
    const r = icon.getBoundingClientRect();
    const panelW = panel.offsetWidth || 352;
    let left = r.left;
    if (left + panelW > window.innerWidth - 16) left = window.innerWidth - panelW - 16;
    if (left < 8) left = 8;
    panel.style.top  = `${r.bottom + 6}px`;
    panel.style.left = `${left}px`;
  }

  // Long-hover (600 ms) opens the popover
  let _hoverTimer = null;
  document.addEventListener('mouseover', e => {
    const icon = e.target.closest('.method-info-icon');
    if (!icon) return;
    const details = icon.closest('.method-info');
    if (!details || details.open) return;
    _hoverTimer = setTimeout(() => _openMethodInfo(details), 600);
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest('.method-info-icon')) clearTimeout(_hoverTimer);
  });

  document.addEventListener('click', e => {
    clearTimeout(_hoverTimer);
    const details = e.target.closest('.method-info');
    // Close all others regardless of where the click landed
    document.querySelectorAll('.method-info[open]').forEach(d => {
      if (d !== details) d.removeAttribute('open');
    });
    if (!details) return;
    // Position the panel just below the summary icon, clamped to viewport
    requestAnimationFrame(() => {
      if (!details.open) return;
      const icon  = details.querySelector('.method-info-icon');
      const panel = details.querySelector('.method-info-panel');
      if (!icon || !panel) return;
      const r = icon.getBoundingClientRect();
      const panelW = panel.offsetWidth || 352;
      let left = r.left;
      if (left + panelW > window.innerWidth - 16) left = window.innerWidth - panelW - 16;
      if (left < 8) left = 8;
      panel.style.top  = `${r.bottom + 6}px`;
      panel.style.left = `${left}px`;
    });
  });

  // Start Pyodide + pymcdm loading in parallel with the sheet data fetch.
  // Both take ~5-10 s; the user waits for whichever finishes last, not both.
  setStatus('loading', 'Loading MCDM engine…');
  initMCDM()
    .then(() => {
      _pyodideReady = true;
      if (state.alternatives.length) { recomputeAll(); renderAllPanels(); }
    })
    .catch(err => setStatus('error', `MCDM engine failed: ${err.message}`));

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

  // Online mode — render from cache immediately, then refresh in background
  const cached = _loadCache();
  if (cached) {
    applySheetData(cached);
    setStatus('cached', 'Cached data — syncing…');
  } else {
    setStatus('loading', 'Connecting to sheet…');
  }

  fetchSheetData(scriptUrl)
    .then(data => { _saveCache(data); applySheetData(data); logEvent(scriptUrl, 'session_start', null); })
    .catch(err => {
      if (cached) {
        setStatus('cached', 'Sheet unreachable — showing cached data');
      } else {
        setStatus('error', `Could not reach sheet: ${err.message}`);
      }
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

function _computeResults(alts, teamId) {
  const team = state.teams[teamId];
  const { criteria } = state;

  // Build ordered criteria list (skip any IDs not in current criteria set)
  const orderedCriteria = team.criteriaOrder
    .map(id => criteria.find(c => c.id === id))
    .filter(Boolean);

  if (!orderedCriteria.length) return [];

  const types   = orderedCriteria.map(c => c.type);
  const ranks   = orderedCriteria.map((_, i) => i + 1); // position = rank
  const weights = rankOrderWeights(ranks, state.p);

  const matrix = alts.map(alt =>
    orderedCriteria.map(c => {
      const idx = criteria.findIndex(x => x.id === c.id);
      return idx >= 0 ? (alt.values[idx] ?? 0) : 0;
    })
  );

  let scores;
  try {
    scores = runMethod(state.method, matrix, weights, types);
  } catch {
    scores = alts.map(() => 0);
  }
  const ranks2 = scoreToRank(scores);

  return alts
    .map((alt, i) => ({
      id:          alt.id,
      description: alt.description,
      score:       scores[i],
      rank:        ranks2[i],
      isSelected:  team.selections.includes(alt.id)
    }))
    .sort((a, b) => a.rank - b.rank);
}

function recompute(teamId) {
  const team = state.teams[teamId];
  const { criteria, alternatives } = state;

  if (!alternatives.length || !criteria.length || !team.criteriaOrder.length || !_pyodideReady) {
    state.results[teamId] = [];
    state.selectedResults[teamId] = [];
    return;
  }

  state.results[teamId] = _computeResults(alternatives, teamId);

  const selectedAlts = alternatives.filter(a => team.selections.includes(a.id));
  state.selectedResults[teamId] = selectedAlts.length > 0
    ? _computeResults(selectedAlts, teamId)
    : [];
}

/** Returns selectedResults when any relevant "calc selected only" checkbox is checked, else full results. */
function _activeResults(teamId) {
  const calcEl         = document.getElementById(`${teamId}-calc-selected`);
  const combinedCalcEl = document.getElementById('combined-calc-selected');
  if ((calcEl?.checked || combinedCalcEl?.checked) && state.selectedResults[teamId].length > 0) {
    return state.selectedResults[teamId];
  }
  return state.results[teamId] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderAllPanels() {
  renderSharedSettings();
  for (const teamId of TEAMS) renderPanel(teamId);
  renderCombinedChart();
  renderCombinedSpiderChart();
  renderCombinedTable();
  renderSnapshotsList();
}

function renderPanel(teamId) {
  renderCriteriaList(teamId);
  renderResults(teamId);
  renderChart(teamId);
  renderCriteriaTable(teamId);
  renderSpiderChart(teamId);
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
    const critIcon  = _criterionIcon(c);

    li.innerHTML = `
      <span class="drag-handle" aria-label="Drag to reorder">⠿</span>
      <span class="criterion-rank">${idx + 1}</span>
      <span class="criterion-name" title="${critIcon ? critIcon + ' ' : ''}${escHtml(c.name)}">${critIcon ? critIcon + ' ' : ''}${escHtml(c.shortName)}</span>
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
      logEvent(state.scriptUrl, 'criteria_reordered', teamId, { newOrder });
      recompute(teamId);
      // Full re-render to update rank numbers and weights
      renderCriteriaList(teamId);
      renderResults(teamId);
      renderChart(teamId);
      renderCriteriaTable(teamId);
      renderSpiderChart(teamId);
      renderCombinedChart();
      renderCombinedSpiderChart();
      renderCombinedTable();
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
  const results = state.results[teamId] ?? [];
  const tbody   = document.getElementById(`${teamId}-results-body`);
  if (!tbody) return;

  const calcEl   = document.getElementById(`${teamId}-calc-selected`);
  const combinedCalcEl = document.getElementById('combined-calc-selected');
  const calcOnly = (calcEl?.checked || combinedCalcEl?.checked) && state.selectedResults[teamId].length > 0;

  // Build a lookup of recalculated rank/score for selected alts
  const selMap = new Map(state.selectedResults[teamId].map(r => [r.id, r]));

  tbody.innerHTML = results.map(r => {
    const sel = calcOnly ? selMap.get(r.id) : null;
    const rank  = sel ? sel.rank  : (calcOnly ? '—' : r.rank);
    const score = sel ? sel.score.toFixed(3) : (calcOnly ? '—' : r.score.toFixed(3));
    return `
    <tr class="${r.isSelected ? 'selected-alt' : ''}">
      <td class="rank-cell">${rank}</td>
      <td class="id-cell">${escHtml(r.id)}</td>
      <td class="desc-cell">${escHtml(r.description)}</td>
      <td class="score-cell">${score}</td>
      <td class="sel-cell">
        <input type="checkbox" class="alt-checkbox"
               data-team="${teamId}" data-alt="${escHtml(r.id)}"
               ${r.isSelected ? 'checked' : ''}>
      </td>
    </tr>`;
  }).join('');
}

function renderChart(teamId) {
  const canvas = document.getElementById(`${teamId}-chart`);
  if (!canvas || typeof Chart === 'undefined') return;

  const results = _activeResults(teamId);
  if (!results.length) { _destroyChart(canvas); return; }

  const color = _cssVar(teamId === 'team1' ? '--team1' : '--team2');
  _renderBarChart(canvas, results, color);
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

  const calcEl    = document.getElementById('combined-calc-selected');
  const calcOnly  = calcEl?.checked ?? false;
  const r1 = (calcOnly && state.selectedResults.team1.length > 0 ? state.selectedResults.team1 : state.results.team1) ?? [];
  const r2 = (calcOnly && state.selectedResults.team2.length > 0 ? state.selectedResults.team2 : state.results.team2) ?? [];
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
 * Radar/spider chart for the combined view.
 * Axes = criteria (in team1's priority order, falling back to state.criteria order).
 * Datasets = alternatives selected by either team (or top 5 by avg score if none).
 * Values are normalised 0–1 per criterion; cost criteria are inverted.
 * Legend items are clickable (Chart.js default) to show/hide individual alternatives.
 */
function renderCombinedSpiderChart() {
  const wrap = document.getElementById('combined-spider-wrap');
  if (!wrap || wrap.hidden) return;

  const canvas = document.getElementById('combined-spider');
  if (!canvas || typeof Chart === 'undefined') return;

  const calcEl   = document.getElementById('combined-calc-selected');
  const calcOnly = calcEl?.checked ?? false;
  const r1 = (calcOnly && state.selectedResults.team1.length > 0 ? state.selectedResults.team1 : state.results.team1) ?? [];
  const r2 = (calcOnly && state.selectedResults.team2.length > 0 ? state.selectedResults.team2 : state.results.team2) ?? [];
  if (!r1.length && !r2.length) { _destroyChart(canvas); return; }

  // Criteria order: prefer team1's priority order
  const refOrder = state.teams.team1.criteriaOrder.length
    ? state.teams.team1.criteriaOrder
    : state.criteria.map(c => c.id);
  const orderedCriteria = refOrder
    .map(id => state.criteria.find(c => c.id === id))
    .filter(Boolean);
  if (!orderedCriteria.length) { _destroyChart(canvas); return; }

  // Alternatives to show: union of selections, or top 5 by avg score
  const allSels = new Set([
    ...state.teams.team1.selections,
    ...state.teams.team2.selections
  ]);

  const allIds  = [...new Set([...r1.map(r => r.id), ...r2.map(r => r.id)])];
  const divisor = (r1.length ? 1 : 0) + (r2.length ? 1 : 0);
  let sorted = allIds
    .map(id => {
      const s1  = r1.find(r => r.id === id)?.score ?? 0;
      const s2  = r2.find(r => r.id === id)?.score ?? 0;
      return { id, avg: (s1 + s2) / divisor, isSelected: allSels.has(id) };
    })
    .sort((a, b) => b.avg - a.avg);

  let displayIds = allSels.size > 0
    ? sorted.filter(r => allSels.has(r.id)).map(r => r.id)
    : sorted.slice(0, 5).map(r => r.id);
  if (!displayIds.length) displayIds = sorted.slice(0, 5).map(r => r.id);

  // Per-criterion min/max across ALL alternatives for consistent normalisation
  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = state.alternatives.map(a => a.values[ci]).filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const PALETTE = [
    _cssVar('--team1'),
    _cssVar('--team2'),
    _cssVar('--combined'),
    '#a78bfa',
    '#fb923c',
  ];

  const datasets = displayIds.map((id, di) => {
    const alt  = state.alternatives.find(a => a.id === id);
    const data = orderedCriteria.map((crit, ci) => {
      const idx = state.criteria.findIndex(c => c.id === crit.id);
      const v   = alt?.values[idx] ?? null;
      if (v == null) return 0;
      const { min, max } = colStats[ci];
      if (max === min) return 0.5;
      const t = (v - min) / (max - min);
      return crit.type === 1 ? t : 1 - t;
    });
    const color = PALETTE[di % PALETTE.length];
    return {
      label:                id,
      data,
      backgroundColor:      _hexToRgba(color, 0.12),
      borderColor:          color,
      pointBackgroundColor: color,
      pointRadius:          3,
      borderWidth:          2
    };
  });

  const gridColor = _cssVar('--border');
  const tickColor = _cssVar('--text-muted');
  const chartData = {
    labels:   orderedCriteria.map(c => { const ci = _criterionIcon(c); return ci ? `${ci} ${c.shortName || c.id}` : (c.shortName || c.id); }),
    datasets
  };

  if (canvas._chart) {
    canvas._chart.data = chartData;
    canvas._chart.update('none');
    return;
  }

  canvas._chart = new Chart(canvas, {
    type: 'radar',
    data: chartData,
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      aspectRatio:         1,
      scales: {
        r: {
          min: 0,
          max: 1,
          ticks:       { display: false },
          grid:        { color: gridColor },
          angleLines:  { color: gridColor },
          pointLabels: { color: tickColor, font: { size: 10 } }
        }
      },
      plugins: {
        legend: {
          display:  true,
          position: 'bottom',
          labels:   { color: tickColor, boxWidth: 10, padding: 8, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const id   = displayIds[ctx.datasetIndex];
              const crit = orderedCriteria[ctx.dataIndex];
              const alt  = state.alternatives.find(a => a.id === id);
              const idx  = state.criteria.findIndex(c => c.id === crit?.id);
              const raw  = alt?.values[idx];
              const norm = ctx.parsed.r?.toFixed(2);
              return ` ${id} — ${crit?.shortName || crit?.id}: ${raw != null ? raw : 'N/A'} (norm ${norm})`;
            }
          }
        }
      }
    }
  });
}

/**
 * Heatmap table for the combined view.
 * Columns = criteria in team1's priority order; rows = alternatives sorted by avg score.
 */
function renderCombinedTable() {
  const wrap = document.getElementById('combined-criteria-table-wrap');
  if (!wrap || wrap.hidden) return;

  const calcEl   = document.getElementById('combined-calc-selected');
  const calcOnly = calcEl?.checked ?? false;
  const r1 = (calcOnly && state.selectedResults.team1.length > 0 ? state.selectedResults.team1 : state.results.team1) ?? [];
  const r2 = (calcOnly && state.selectedResults.team2.length > 0 ? state.selectedResults.team2 : state.results.team2) ?? [];
  if (!r1.length && !r2.length) {
    wrap.innerHTML = '<p class="empty-msg" style="padding:.75rem 1rem">No data</p>';
    return;
  }

  // Criteria in original sheet order (matches the Google doc)
  const orderedCriteria = state.criteria.filter(Boolean);
  if (!orderedCriteria.length) { wrap.innerHTML = ''; return; }

  // Alternatives sorted by average combined score
  const allSels = new Set([...state.teams.team1.selections, ...state.teams.team2.selections]);
  const divisor = (r1.length ? 1 : 0) + (r2.length ? 1 : 0);
  const allIds  = [...new Set([...r1.map(r => r.id), ...r2.map(r => r.id)])];
  const unsorted = allIds.map(id => {
    const s1  = r1.find(r => r.id === id)?.score ?? 0;
    const s2  = r2.find(r => r.id === id)?.score ?? 0;
    const alt = state.alternatives.find(a => a.id === id);
    return { id, score: (s1 + s2) / divisor, isSelected: allSels.has(id),
             description: alt?.description ?? '' };
  });
  const combinedRanks = scoreToRank(unsorted.map(r => r.score));
  const rows = _sortById(unsorted.map((r, i) => ({ ...r, rank: combinedRanks[i] })));

  if (!rows.length) {
    wrap.innerHTML = '<p class="empty-msg" style="padding:.75rem 1rem">No data</p>';
    return;
  }

  // Per-column min/max for displayed rows
  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = rows
      .map(r => state.alternatives.find(a => a.id === r.id)?.values[ci])
      .filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const method = state.method.toUpperCase();

  const thead = `<thead><tr>
    <th class="cvt-rank">#</th>
    <th class="cvt-id"></th>
    <th class="cvt-score">${escHtml(method)} avg</th>
    ${orderedCriteria.map(c => { const ci = _criterionIcon(c); return `<th title="${ci ? ci + ' ' : ''}${escHtml(c.name)} (${c.type === 1 ? '↑ benefit' : '↓ cost'})">${ci ? ci + ' ' : ''}${escHtml(c.id)}</th>`; }).join('')}
  </tr></thead>`;

  const tbody = `<tbody>${rows.map(r => {
    const alt   = state.alternatives.find(a => a.id === r.id);
    const cells = orderedCriteria.map((crit, ci) => {
      const idx = state.criteria.findIndex(c => c.id === crit.id);
      const v   = alt?.values[idx] ?? null;
      const bg  = v != null ? _heatmapColor(v, colStats[ci].min, colStats[ci].max, crit.type) : 'var(--surface2)';
      return `<td class="cvt-cell" style="background:${bg}" title="${escHtml(crit.id)}: ${v != null ? v : '—'}">${v != null ? v : '—'}</td>`;
    }).join('');
    const rowTitle = ` title="${escHtml(r.id)}: ${escHtml(r.description)}"`;
    return `<tr class="${r.isSelected ? 'selected-alt' : ''}"${rowTitle}><td class="cvt-rank">${r.rank}</td><td class="cvt-id">${escHtml(r.id)}</td><td class="cvt-score">${r.score.toFixed(3)}</td>${cells}</tr>`;
  }).join('')}</tbody>`;

  wrap.innerHTML = `<div class="cvt-scroll"><table class="criteria-values-table">${thead}${tbody}</table></div>`;
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
    canvas._chart.data.labels   = chartData.labels;
    canvas._chart.data.datasets = chartData.datasets;
    if (!canvas.closest('[hidden]')) canvas._chart.resize();
    canvas._chart.update();
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

/**
 * RdYlGn colormap: goodness 0 (worst) → red, 0.5 → yellow, 1 (best) → green.
 * Returns a solid rgb() string for use as a cell background.
 */
function _heatmapColor(val, min, max, type) {
  if (max === min) return 'var(--surface2)';
  const t        = (val - min) / (max - min);
  const goodness = type === 1 ? t : 1 - t;
  let r, g, b;
  if (goodness <= 0.5) {
    const f = goodness * 2;                      // 0→1 : red→yellow
    r = Math.round(220 + (254 - 220) * f);
    g = Math.round( 53 + (220 -  53) * f);
    b = Math.round( 69 + ( 83 -  69) * f);
  } else {
    const f = (goodness - 0.5) * 2;             // 0→1 : yellow→green
    r = Math.round(254 + ( 58 - 254) * f);
    g = Math.round(220 + (191 - 220) * f);
    b = Math.round( 83 + (143 -  83) * f);
  }
  return `rgb(${r},${g},${b})`;
}

/**
 * Render the criteria-values heatmap table for a team panel.
 * Only executes when the table view is visible (chart-wrap is hidden).
 */
function renderCriteriaTable(teamId) {
  const wrap = document.getElementById(`${teamId}-criteria-table-wrap`);
  if (!wrap || wrap.hidden) return;

  const rows = _sortById(_activeResults(teamId));

  if (!rows.length) {
    wrap.innerHTML = '<p class="empty-msg" style="padding:.75rem 1rem">No data</p>';
    return;
  }

  // Criteria in original sheet order (matches the Google doc)
  const orderedCriteria = state.criteria.filter(Boolean);

  if (!orderedCriteria.length) { wrap.innerHTML = ''; return; }

  // Per-column min/max for the displayed rows
  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = rows
      .map(r => state.alternatives.find(a => a.id === r.id)?.values[ci])
      .filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const method = state.method.toUpperCase();

  const thead = `<thead><tr>
    <th class="cvt-rank">#</th>
    <th class="cvt-id"></th>
    <th class="cvt-score">${escHtml(method)}</th>
    ${orderedCriteria.map(c => { const ci = _criterionIcon(c); return `<th title="${ci ? ci + ' ' : ''}${escHtml(c.name)} (${c.type === 1 ? '↑ benefit' : '↓ cost'})">${ci ? ci + ' ' : ''}${escHtml(c.id)}</th>`; }).join('')}
  </tr></thead>`;

  const tbody = `<tbody>${rows.map(r => {
    const alt   = state.alternatives.find(a => a.id === r.id);
    const cells = orderedCriteria.map((crit, ci) => {
      const idx = state.criteria.findIndex(c => c.id === crit.id);
      const v   = alt?.values[idx] ?? null;
      const bg  = v != null ? _heatmapColor(v, colStats[ci].min, colStats[ci].max, crit.type) : 'var(--surface2)';
      return `<td class="cvt-cell" style="background:${bg}" title="${escHtml(crit.id)}: ${v != null ? v : '—'}">${v != null ? v : '—'}</td>`;
    }).join('');
    const rowTitle = ` title="${escHtml(r.id)}: ${escHtml(r.description)}"`;
    return `<tr class="${r.isSelected ? 'selected-alt' : ''}"${rowTitle}><td class="cvt-rank">${r.rank}</td><td class="cvt-id">${escHtml(r.id)}</td><td class="cvt-score">${r.score.toFixed(3)}</td>${cells}</tr>`;
  }).join('')}</tbody>`;

  wrap.innerHTML = `<div class="cvt-scroll"><table class="criteria-values-table">${thead}${tbody}</table></div>`;
}

/**
 * Render a radar/spider chart for one team.
 * Each axis = one criterion (in team's priority order), normalised 0–1.
 * Benefit criteria: higher raw → higher on chart.
 * Cost criteria: lower raw → higher on chart (inverted).
 * Shows selected alternatives, or the top 5 if none are selected.
 */
function renderSpiderChart(teamId) {
  const wrap = document.getElementById(`${teamId}-spider-wrap`);
  if (!wrap || wrap.hidden) return;

  const canvas = document.getElementById(`${teamId}-spider`);
  if (!canvas || typeof Chart === 'undefined') return;

  const team    = state.teams[teamId];
  const results = _activeResults(teamId);
  if (!results.length) { _destroyChart(canvas); return; }

  const orderedCriteria = team.criteriaOrder
    .map(id => state.criteria.find(c => c.id === id))
    .filter(Boolean);
  if (!orderedCriteria.length) { _destroyChart(canvas); return; }

  // Alternatives to display: selected ones, else top 5.
  // When "calc selected only" is active, results already contains only selected alts.
  const sels = team.selections;
  let displayResults = sels.length > 0
    ? results.filter(r => sels.includes(r.id))
    : results.slice(0, 5);
  if (!displayResults.length) displayResults = results.slice(0, 5);

  // Per-criterion min/max across ALL alternatives for consistent normalisation
  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = state.alternatives.map(a => a.values[ci]).filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const teamColor = _cssVar(teamId === 'team1' ? '--team1' : '--team2');
  const PALETTE   = [
    teamColor,
    _cssVar('--combined'),
    '#a78bfa', // violet
    '#fb923c', // orange
    '#34d399', // emerald
  ];

  const datasets = displayResults.map((r, di) => {
    const alt   = state.alternatives.find(a => a.id === r.id);
    const data  = orderedCriteria.map((crit, ci) => {
      const idx = state.criteria.findIndex(c => c.id === crit.id);
      const v   = alt?.values[idx] ?? null;
      if (v == null) return 0;
      const { min, max } = colStats[ci];
      if (max === min) return 0.5;
      const t = (v - min) / (max - min);
      return crit.type === 1 ? t : 1 - t; // invert cost criteria
    });
    const color = PALETTE[di % PALETTE.length];
    return {
      label:                r.id,
      data,
      backgroundColor:      _hexToRgba(color, 0.12),
      borderColor:          color,
      pointBackgroundColor: color,
      pointRadius:          3,
      borderWidth:          2
    };
  });

  const gridColor  = _cssVar('--border');
  const tickColor  = _cssVar('--text-muted');
  const chartData  = {
    labels:   orderedCriteria.map(c => { const ci = _criterionIcon(c); return ci ? `${ci} ${c.shortName || c.id}` : (c.shortName || c.id); }),
    datasets
  };

  if (canvas._chart) {
    canvas._chart.data = chartData;
    canvas._chart.update('none');
    return;
  }

  canvas._chart = new Chart(canvas, {
    type: 'radar',
    data: chartData,
    options: {
      responsive:          true,
      maintainAspectRatio: true,
      aspectRatio:         1,
      scales: {
        r: {
          min: 0,
          max: 1,
          ticks:       { display: false },
          grid:        { color: gridColor },
          angleLines:  { color: gridColor },
          pointLabels: { color: tickColor, font: { size: 10 } }
        }
      },
      plugins: {
        legend: {
          display:  true,
          position: 'bottom',
          labels:   { color: tickColor, boxWidth: 10, padding: 8, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const r    = displayResults[ctx.datasetIndex];
              const crit = orderedCriteria[ctx.dataIndex];
              const alt  = state.alternatives.find(a => a.id === r?.id);
              const idx  = state.criteria.findIndex(c => c.id === crit?.id);
              const raw  = alt?.values[idx];
              const norm = ctx.parsed.r?.toFixed(2);
              return ` ${r?.id} — ${crit?.shortName || crit?.id}: ${raw != null ? raw : 'N/A'} (norm ${norm})`;
            }
          }
        }
      }
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
  sharedSlider?.addEventListener('change', () => {
    logEvent(state.scriptUrl, 'p_value_changed', null, { p: state.p });
  });

  // Shared method tabs — affects both teams
  document.querySelectorAll('#shared-method-tabs .method-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.method = btn.dataset.method;
      document.querySelectorAll('#shared-method-tabs .method-tab').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      logEvent(state.scriptUrl, 'algorithm_changed', null, { method: state.method });
      _onSharedSettingChanged();
    });
  });

  // View toggle: bar ↔ spider ↔ table (icon buttons), shared by team panels and combined
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-view-icon');
    if (!btn) return;
    const group = btn.closest('.view-toggle-group');
    if (!group) return;
    const teamId = group.dataset.team;
    const view   = btn.dataset.view;
    group.querySelectorAll('.btn-view-icon').forEach(b => b.classList.toggle('active', b === btn));
    logEvent(state.scriptUrl, 'view_changed', teamId, { view });
    if (teamId === 'combined') {
      const chartWrap  = document.getElementById('combined-chart-wrap');
      const spiderWrap = document.getElementById('combined-spider-wrap');
      const tableWrap  = document.getElementById('combined-criteria-table-wrap');
      if (!chartWrap || !spiderWrap || !tableWrap) return;
      chartWrap.hidden  = view !== 'bar';
      spiderWrap.hidden = view !== 'spider';
      tableWrap.hidden  = view !== 'table';
      if (view === 'spider') renderCombinedSpiderChart();
      if (view === 'table')  renderCombinedTable();
      if (view === 'bar')    renderCombinedChart();
    } else {
      const chartWrap  = document.getElementById(`${teamId}-chart-wrap`);
      const spiderWrap = document.getElementById(`${teamId}-spider-wrap`);
      const tableWrap  = document.getElementById(`${teamId}-criteria-table-wrap`);
      if (!chartWrap || !spiderWrap || !tableWrap) return;
      chartWrap.hidden  = view !== 'bar';
      spiderWrap.hidden = view !== 'spider';
      tableWrap.hidden  = view !== 'table';
      if (view === 'table')  renderCriteriaTable(teamId);
      if (view === 'spider') renderSpiderChart(teamId);
      if (view === 'bar')    renderChart(teamId);
    }
  });

  // Calc-selected checkboxes (event delegation)
  document.addEventListener('change', e => {
    if (e.target.classList.contains('calc-selected-checkbox')) {
      // Switching the checkbox just changes which results are displayed — no recompute needed.
      for (const teamId of TEAMS) { renderResults(teamId); renderChart(teamId); renderCriteriaTable(teamId); renderSpiderChart(teamId); }
      renderCombinedChart();
      renderCombinedSpiderChart();
      renderCombinedTable();
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
      logEvent(state.scriptUrl, 'selection_changed', teamId, { selectedCount: state.teams[teamId].selections.length });
      recompute(teamId);   // recomputes both full and selectedResults
      renderResults(teamId);
      for (const id of TEAMS) { renderChart(id); renderCriteriaTable(id); renderSpiderChart(id); }
      renderCombinedChart();
      renderCombinedSpiderChart();
      renderCombinedTable();
      updateDirtyIndicator(teamId);
    }
  });

  // Save snapshot
  document.getElementById('save-snapshot-btn')?.addEventListener('click', async () => {
    const name = prompt('Snapshot name:', `Snapshot ${new Date().toLocaleTimeString()}`);
    if (name === null) return; // cancelled
    const snap = await saveSnapshot(name, _captureState(), state.scriptUrl);
    logEvent(state.scriptUrl, 'snapshot_saved', null, { name });
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
      logEvent(state.scriptUrl, 'snapshot_loaded', null, { name: snap.name });
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
  document.getElementById('sync-enabled')?.addEventListener('change', e => {
    if (e.target.checked) {
      setStatus('loading', 'Resuming sync…');
      fetchSheetData(state.scriptUrl)
        .then(data => { _saveCache(data); applySheetData(data); })
        .catch(() => setStatus('offline', 'Sheet unreachable — working offline'));
    } else {
      setStatus('offline', 'Auto-sync paused');
    }
  });

  state.pollTimer = setInterval(async () => {
    if (!document.getElementById('sync-enabled')?.checked) return;
    if (state.isSyncing) return;
    state.isSyncing = true;
    try {
      const ts = await fetchLastModified(state.scriptUrl);
      if (ts && ts !== state.lastModified) {
        const data = await fetchSheetData(state.scriptUrl);
        _saveCache(data);
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
  ['ok', 'loading', 'error', 'offline', 'cached'].forEach(c => el.classList.remove(c));
  el.classList.add(type);
  if (dot) {
    dot.className = `sync-dot ${type}`;
    dot.title = message || type;
  }
  if (type === 'ok') {
    const ts = document.getElementById('last-synced');
    if (ts) ts.textContent = new Date().toLocaleTimeString();
  }
}

function _saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota exceeded — ignore */ }
}

function _loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw).data ?? null;
  } catch { return null; }
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
  renderCombinedSpiderChart();
  renderCombinedTable();
}

/** Convert a CSS hex color (#rrggbb) to rgba(r,g,b,alpha) for canvas compatibility. */
function _hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Return an emoji icon for a criterion, matched by keywords in its name.
 * Rules are ordered: more-specific patterns before generic ones.
 * Returns '' (empty string) if no rule matches.
 *
 * This is the single source of truth for criterion icons — used in table
 * headers, the criteria priority list, spider chart axis labels, and any
 * tooltips, so the icon↔criterion connection is always consistent.
 */
function _criterionIcon(criterion) {
  const text = `${criterion.name ?? ''} ${criterion.shortName ?? ''}`.toLowerCase();
  const rules = [
    // Navigability — size-specific before generic (big ship > ferry > sailboat)
    [/navigab.*(big|large)|(big|large).*vessel/,    '🚢'],
    [/navigab.*medium|medium.*vessel/,               '⛴️'],
    [/navigab.*(small)|small.*vessel/,               '⛵'],
    [/navigab/,                                      '⛵'],
    // Energy / power
    [/energy|power|electricity|hydropower|gwh/,      '⚡'],
    // Birds / wildlife
    [/bird/,                                         '🐦'],
    // Food production — location before generic
    [/food.*(down|downstream)|downstream.*food/,     '🌽🏞️'],
    [/food.*(up|upstream)|upstream.*food/,           '🌽🏔️'],
    [/food|crop|agricult|irrigat|maize|grain/,       '🌽'],
    // Evaporation — location before generic
    [/evap.*(down|downstream)|downstream.*evap/,     '☀️🏞️'],
    [/evap.*(up|upstream)|upstream.*evap/,           '☀️🏔️'],
    [/wetland.*evap|evap.*wetland/,                  '🌿☀️'],
    [/evapor/,                                       '☀️'],
    // Wetlands (non-evap)
    [/wetland/,                                      '🌿'],
    // Forest / vegetation
    [/forest|woodland|tree/,                         '🌲'],
    // Cost / investment
    [/cost|invest|budget|expenditure/,               '💰'],
    // Discharge / flow
    [/discharge|flow|runoff/,                        '🌊'],
    // Social
    [/social|community|displace|accept/,             '👥'],
    // Sediment
    [/sediment|silt/,                                '🪨'],
    // Flood
    [/flood/,                                        '🌊'],
    // Carbon / GHG
    [/carbon|emission|ghg|greenhouse/,               '🌫️'],
    // Habitat (generic fallback)
    [/habitat/,                                      '🌿'],
  ];
  for (const [rx, icon] of rules) {
    if (rx.test(text)) return icon;
  }
  return '';
}

/** Sort an array of objects with an `id` field alphabetically/numerically (A1 < A2 < A11). */
function _sortById(arr) {
  return [...arr].sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' })
  );
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
