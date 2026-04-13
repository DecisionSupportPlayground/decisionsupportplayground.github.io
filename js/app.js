/**
 * app.js: Main application controller for app.html.
 *
 * Responsibilities:
 *   - Owns the single application state object
 *   - Fetches data from the sheet and dispatches to MCDM algorithms
 *   - Wires DOM events (drag-drop, sliders, buttons) to state mutations
 *   - Drives the 5-second polling loop for live collaboration
 *   - Delegates rendering to renderPanel() and renderChart()
 */

import { initMCDM, rankOrderWeights, runMethod, scoreToRank, normaliseScores, invertRanksForDisplay, METHODS } from './mcdm.js?v=3';
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
  criteriaOrder:      [], // ['I1','I2',...]: index 0 = rank 1 (highest priority)
  criteriaSelections: [], // ['I1','I2',...]: subset to include; empty = all included
  selections:         [], // ['A1','A4',...]: selected alternatives
  lastUpdated:        null,
  isDirty:            false, // unsaved local changes
  isSaving:           false
};

const state = {
  scriptUrl:    null,
  criteria:     [],   // [{id, name, shortName, type}]
  alternatives: [],   // [{id, description, values[]}]
  p:            0,    // shared weight exponent: 0 | 0.5 | 1
  method:       'topsis', // shared MCDM method
  combinedMode: 'copeland', // 'consensus' | 'copeland' | 'sensitivity'
  teams: {
    team1:    { ...DEFAULT_TEAM, name: 'Upper Basin' },
    team2:    { ...DEFAULT_TEAM, name: 'Lower Basin' },
    combined: { ...DEFAULT_TEAM, name: 'Consensus' }
  },
  results:                       { team1: [], team2: [], combined: [] },
  selectedResults:               { team1: [], team2: [], combined: [] },
  criteriaFilteredResults:       { team1: [], team2: [], combined: [] },
  criteriaFilteredSelResults:    { team1: [], team2: [], combined: [] },
  sensitivityCache:    null,   // { steps, altIds, ranks, flipPoints, summary, weightDiff } | null
  sensitivityRunning:  false,
  sensitivityGen:      0,      // incremented on every invalidation to cancel in-flight computations
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
  const _savedMode = (() => { try { return localStorage.getItem('madm_combined_mode'); } catch { return null; } })();
  if (_savedMode) _applyMode(_savedMode);
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
    setStatus('offline', `Offline: ${fileName}`);
    try {
      const parsed = parseAlternativesCSV(offlineCsv);
      state.criteria     = parsed.criteria;
      state.alternatives = parsed.alternatives;
      for (const teamId of TEAMS) {
        if (!state.teams[teamId].criteriaOrder.length) {
          state.teams[teamId].criteriaOrder = state.criteria.map(c => c.id);
        }
      }
      if (!state.teams.combined.criteriaOrder.length) {
        state.teams.combined.criteriaOrder = state.criteria.map(c => c.id);
      }
      recomputeAll();
      renderAllPanels();
    } catch (err) {
      setStatus('error', `CSV parse error: ${err.message}`);
    }
    return; // no polling in offline mode
  }

  // Online mode: render from cache immediately, then refresh in background
  const cached = _loadCache();
  if (cached) {
    applySheetData(cached);
    setStatus('cached', 'Cached data, syncing…');
  } else {
    setStatus('loading', 'Connecting to sheet…');
  }

  fetchSheetData(scriptUrl)
    .then(data => { _saveCache(data); applySheetData(data); logEvent(scriptUrl, 'session_start', null); })
    .catch(err => {
      if (cached) {
        setStatus('cached', 'Sheet unreachable, showing cached data');
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
    // Load saved consensus criteria order
    if (rankData.combined?.criteriaOrder?.length) {
      state.teams.combined.criteriaOrder = rankData.combined.criteriaOrder;
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
  // Seed selections to all alternatives if none saved (first load or fresh sheet)
  for (const teamId of TEAMS) {
    if (!state.teams[teamId].isDirty && !state.teams[teamId].selections.length && state.alternatives.length) {
      state.teams[teamId].selections = state.alternatives.map(a => a.id);
    }
  }
  // Seed combined criteria order from sheet column order (neutral baseline)
  if (!state.teams.combined.criteriaOrder.length && state.criteria.length) {
    state.teams.combined.criteriaOrder = state.criteria.map(c => c.id);
  }

  state.lastModified = data.lastModified || null;
  recomputeAll();
  renderAllPanels();
  setStatus('ok', '');
}

// ─────────────────────────────────────────────────────────────────────────────
// MCDM computation
// ─────────────────────────────────────────────────────────────────────────────

function _invalidateSensitivity() {
  state.sensitivityCache  = null;
  state.sensitivityRunning = false;
  state.sensitivityGen++;
}

function recomputeAll() {
  recompute('team1');
  recompute('team2');
  if (state.combinedMode === 'consensus') recompute('combined');
  _invalidateSensitivity();
}

function _computeResults(alts, teamId, criteriaOrderOverride = null) {
  const team = state.teams[teamId];
  const { criteria } = state;

  // Build ordered criteria list (skip any IDs not in current criteria set)
  const orderedCriteria = (criteriaOrderOverride ?? team.criteriaOrder)
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
    state.results[teamId]                    = [];
    state.selectedResults[teamId]            = [];
    state.criteriaFilteredResults[teamId]    = [];
    state.criteriaFilteredSelResults[teamId] = [];
    return;
  }

  state.results[teamId] = _computeResults(alternatives, teamId);

  const selectedAlts = alternatives.filter(a => team.selections.includes(a.id));
  state.selectedResults[teamId] = selectedAlts.length > 0
    ? _computeResults(selectedAlts, teamId)
    : [];

  // Criteria-filtered results (only when a real subset is selected)
  const filteredOrder = team.criteriaSelections.length > 0
    ? team.criteriaOrder.filter(id => team.criteriaSelections.includes(id))
    : team.criteriaOrder;
  const isFiltered = filteredOrder.length < team.criteriaOrder.length;

  state.criteriaFilteredResults[teamId] = isFiltered
    ? _computeResults(alternatives, teamId, filteredOrder)
    : state.results[teamId];

  state.criteriaFilteredSelResults[teamId] = isFiltered && selectedAlts.length > 0
    ? _computeResults(selectedAlts, teamId, filteredOrder)
    : state.selectedResults[teamId];
}

/** Returns the active criteria order for a team: filtered by the global criteria filter when on. */
function _activeCriteriaOrder(teamId) {
  const team     = state.teams[teamId];
  const filterEl = document.getElementById('combined-calc-criteria');
  if (filterEl?.checked && team.criteriaSelections.length > 0) {
    return team.criteriaOrder.filter(id => team.criteriaSelections.includes(id));
  }
  return team.criteriaOrder;
}

/** Returns the appropriate results array based on which global filter checkboxes are active. */
function _activeResults(teamId) {
  const altEl  = document.getElementById('combined-calc-selected');
  const critEl = document.getElementById('combined-calc-criteria');

  const useAlt  = altEl?.checked;
  const useCrit = critEl?.checked && state.teams[teamId].criteriaSelections.length > 0;

  if (useCrit && useAlt && state.criteriaFilteredSelResults[teamId]?.length > 0) {
    return state.criteriaFilteredSelResults[teamId];
  }
  if (useCrit && state.criteriaFilteredResults[teamId]?.length > 0) {
    return state.criteriaFilteredResults[teamId];
  }
  if (useAlt && state.selectedResults[teamId].length > 0) {
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
  renderCombinedPanel();
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
  const wrap = document.getElementById(`${teamId}-criteria-wrap`);
  if (!wrap) return;

  const team = state.teams[teamId];

  // Destroy existing Sortable before replacing DOM
  const oldList = wrap.querySelector('.criteria-list');
  if (oldList?._sortable) oldList._sortable.destroy();

  // Compute weights for the current order and the shared p-value
  const n = team.criteriaOrder.length;
  const weights = n > 0
    ? rankOrderWeights(team.criteriaOrder.map((_, i) => i + 1), state.p)
    : [];

  // Seed criteriaSelections to all criteria on first render
  if (!team.criteriaSelections.length && team.criteriaOrder.length) {
    team.criteriaSelections = [...team.criteriaOrder];
  }

  const filterActive  = document.getElementById('combined-calc-criteria')?.checked ?? false;
  const activeOrder   = filterActive && team.criteriaSelections.length > 0
    ? team.criteriaOrder.filter(id => team.criteriaSelections.includes(id))
    : null;
  const activeWeights = activeOrder
    ? rankOrderWeights(activeOrder.map((_, i) => i + 1), state.p)
    : null;

  // Build <ul>
  const listEl = document.createElement('ul');
  listEl.className = 'criteria-list';

  team.criteriaOrder.forEach((criterionId, idx) => {
    const c = state.criteria.find(x => x.id === criterionId);
    if (!c) return;

    const li = document.createElement('li');
    const isChecked = team.criteriaSelections.includes(criterionId);
    li.className = `criterion-item${isChecked ? '' : ' deselected'}`;
    li.dataset.id = criterionId;

    const typeIcon  = c.type === 1 ? '↑' : '↓';
    const typeLabel = c.type === 1 ? 'benefit' : 'cost';
    const critIcon  = _criterionIcon(c);

    let weightPct;
    if (filterActive && !isChecked) {
      weightPct = '-';
    } else if (filterActive && activeOrder) {
      const ai = activeOrder.indexOf(criterionId);
      weightPct = ai >= 0 ? (activeWeights[ai] * 100).toFixed(1) + '%' : '-';
    } else {
      weightPct = weights[idx] !== undefined ? (weights[idx] * 100).toFixed(1) + '%' : '';
    }

    li.innerHTML = `
      <span class="drag-handle" aria-label="Drag to reorder">⠿</span>
      <span class="criterion-rank">${idx + 1}</span>
      <span class="criterion-name" title="${critIcon ? critIcon + ' ' : ''}${escHtml(c.name)}">${critIcon ? critIcon + ' ' : ''}${escHtml(c.shortName)}</span>
      <span class="criterion-weight">${escHtml(weightPct)}</span>
      <span class="criterion-type ${typeLabel}" title="${typeLabel}: ${typeLabel === 'benefit' ? 'the higher the better' : 'the higher the worst'}">${typeIcon}</span>
      <input type="checkbox" class="criterion-checkbox" data-team="${teamId}" data-id="${criterionId}"
             title="Include in calculation" ${isChecked ? 'checked' : ''}>`;
    listEl.appendChild(li);
  });

  // Build Save Ranking button
  const btn = document.createElement('button');
  btn.id        = `${teamId}-save-btn`;
  btn.className = 'btn-save-ranking';
  btn.dataset.team = teamId;
  btn.style.marginTop = '.5rem';
  btn.textContent = 'Save Ranking';

  // Render into wrap
  wrap.replaceChildren(listEl, btn);

  // Initialise SortableJS
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
      _invalidateSensitivity();
      renderCriteriaList(teamId);
      renderResults(teamId);
      renderChart(teamId);
      renderCriteriaTable(teamId);
      renderSpiderChart(teamId);
      renderCombinedPanel();
      updateDirtyIndicator(teamId);
    }
  });
}

function _updateMethodDesc() {
  const el = document.getElementById('method-desc-text');
  if (el) el.textContent = METHODS[state.method]?.description ?? '';
}

function renderSharedSettings() {
  const slider = document.getElementById('shared-p-slider');
  if (slider) {
    slider.value = String(state.p);
    updatePLabel(state.p);
  }
  const _sel = document.getElementById('shared-method-select');
  if (_sel) _sel.value = state.method;
  _updateMethodDesc();
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
  const wrap = document.getElementById(`${teamId}-results-wrap`);
  if (!wrap) return;

  const results  = state.results[teamId] ?? [];
  const calcEl   = document.getElementById('combined-calc-selected');
  const calcOnly = calcEl?.checked && state.selectedResults[teamId].length > 0;
  const selMap   = new Map(state.selectedResults[teamId].map(r => [r.id, r]));

  const rows = results.map(r => {
    const sel   = calcOnly ? selMap.get(r.id) : null;
    const rank  = sel ? sel.rank              : (calcOnly ? '-' : r.rank);
    const score = sel ? sel.score.toFixed(3)  : (calcOnly ? '-' : r.score.toFixed(3));
    return `<tr class="${r.isSelected ? 'selected-alt' : ''}">
      <td class="rank-cell">${rank}</td>
      <td class="id-cell">${escHtml(r.id)}</td>
      <td class="desc-cell">${escHtml(r.description)}</td>
      <td class="score-cell">${score}</td>
      <td class="sel-cell"><input type="checkbox" class="alt-checkbox"
        data-team="${teamId}" data-alt="${escHtml(r.id)}" ${r.isSelected ? 'checked' : ''}></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="results-table">
    <thead><tr>
      <th class="rank-cell">#</th>
      <th class="id-cell">ID</th>
      <th class="desc-cell">Description</th>
      <th class="score-cell">Score</th>
      <th class="sel-cell" title="Mark as selected">★</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
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

  // Consensus results: computed using the shared combined criteria order
  const combined = _activeResults('combined');
  if (!combined.length) { _destroyChart(canvas); return; }

  // Per-team scores as secondary markers (computed with each team's own criteria)
  const r1 = _activeResults('team1');
  const r2 = _activeResults('team2');
  const scoreMap1 = new Map(r1.map(r => [r.id, r.score]));
  const scoreMap2 = new Map(r2.map(r => [r.id, r.score]));

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
  if (r1.length) extraDatasets.push(_marker(_cssVar('--team1'), state.teams.team1.name || 'Upper Basin', combined.map(r => scoreMap1.get(r.id) ?? null)));
  if (r2.length) extraDatasets.push(_marker(_cssVar('--team2'), state.teams.team2.name || 'Lower Basin', combined.map(r => scoreMap2.get(r.id) ?? null)));

  _renderBarChart(canvas, combined, _cssVar('--combined'), { extraDatasets, showLegend: extraDatasets.length > 0 });
}

/** Spider chart for the combined panel: used by Consensus and Copeland modes. */
function _renderCombinedSpiderChart(displayIds) {
  const wrap = document.getElementById('combined-spider-wrap');
  if (!wrap || wrap.hidden) return;

  const canvas = document.getElementById('combined-spider');
  if (!canvas || typeof Chart === 'undefined') return;
  if (!displayIds.length) { _destroyChart(canvas); return; }

  const activeCritIds = new Set(_activeCriteriaOrder('team1'));
  const orderedCriteria = state.criteria.filter(c => !activeCritIds.size || activeCritIds.has(c.id));
  if (!orderedCriteria.length) { _destroyChart(canvas); return; }

  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = state.alternatives.map(a => a.values[ci]).filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  _renderSpiderChart(canvas, displayIds, orderedCriteria, colStats, displayIds.map(_altColor));
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined panel: mode dispatcher + per-mode renderers
// ─────────────────────────────────────────────────────────────────────────────

/** Master entry point for the combined panel; routes to the active mode renderer. */
function renderCombinedPanel() {
  switch (state.combinedMode) {
    case 'consensus':    renderConsensusPanel();    break;
    case 'sensitivity':  renderSensitivityPanel();  break;
    default:             renderCopelandPanel();      break;
  }
}

// ── Mode 1: Forced Consensus ──────────────────────────────────────────────────

function renderConsensusPanel() {
  renderCriteriaList('combined');
  renderCombinedChart();   // bar chart using consensus MCDM results
  const spiderWrap = document.getElementById('combined-spider-wrap');
  const tableWrap  = document.getElementById('combined-criteria-table-wrap');
  if (spiderWrap && !spiderWrap.hidden) renderConsensusSpider();
  if (tableWrap  && !tableWrap.hidden)  renderConsensusTable();
  renderResults('combined');
}

function renderConsensusSpider() {
  const r = _activeResults('combined');
  const allSels = state.teams.combined.selections;
  let displayResults = allSels.length > 0
    ? r.filter(res => allSels.includes(res.id))
    : r.slice(0, 5);
  if (!displayResults.length) displayResults = r.slice(0, 5);
  _renderCombinedSpiderChart(displayResults.map(res => res.id));
}

function renderConsensusTable() {
  const wrap = document.getElementById('combined-criteria-table-wrap');
  if (!wrap || wrap.hidden) return;
  const rows = _sortById(_activeResults('combined'));
  if (!rows.length) { wrap.innerHTML = '<p class="empty-msg" style="padding:.75rem 1rem">No data</p>'; return; }
  const activeCritIds   = new Set(_activeCriteriaOrder('team1'));
  const orderedCriteria = state.criteria.filter(c => activeCritIds.has(c.id));
  if (!orderedCriteria.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = _buildCriteriaTableHTML(rows, orderedCriteria, state.method.toUpperCase());
}

// ── Mode 2: Copeland Rank Aggregation ─────────────────────────────────────────

/**
 * Compute Copeland pairwise vote between two results arrays.
 * Pure JS: no Pyodide required.
 * @param {Array<{id,description,rank}>} r1
 * @param {Array<{id,description,rank}>} r2
 * @returns {Array<{id,description,copelandScore,score,rank,isSelected}>}
 */
export function computeCopeland(r1, r2) {
  const allSels = new Set([...state.teams.team1.selections, ...state.teams.team2.selections]);
  const rankOf  = (results, id) => results.find(r => r.id === id)?.rank ?? Infinity;
  const descOf  = id => {
    const r = r1.find(r => r.id === id) ?? r2.find(r => r.id === id);
    return r?.description ?? '';
  };

  const ids    = [...new Set([...r1.map(r => r.id), ...r2.map(r => r.id)])];
  const scores = Object.fromEntries(ids.map(id => [id, 0]));

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      let winsA = 0, winsB = 0;
      for (const res of [r1, r2]) {
        const ra = rankOf(res, a), rb = rankOf(res, b);
        if (ra < rb) winsA++;
        else if (rb < ra) winsB++;
      }
      if (winsA > winsB)      { scores[a]++; scores[b]--; }
      else if (winsB > winsA) { scores[b]++; scores[a]--; }
      // tie → no change
    }
  }

  const sorted = ids
    .map(id => ({ id, description: descOf(id), copelandScore: scores[id], isSelected: allSels.has(id) }))
    .sort((a, b) => b.copelandScore - a.copelandScore || a.id.localeCompare(b.id));

  return sorted.map((r, i) => ({ ...r, score: r.copelandScore, rank: i + 1 }));
}

function renderCopelandPanel() {
  const canvas = document.getElementById('combined-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const r1 = _activeResults('team1');
  const r2 = _activeResults('team2');
  if (!r1.length && !r2.length) { _destroyChart(canvas); return; }

  const copeland = computeCopeland(r1, r2);
  if (!copeland.length) { _destroyChart(canvas); return; }

  _renderBarChart(canvas, copeland, _cssVar('--combined'), {
    xMin: undefined   // Copeland scores can be negative
  });

  // Spider chart
  const spiderWrap = document.getElementById('combined-spider-wrap');
  if (spiderWrap && !spiderWrap.hidden) {
    const displayIds = copeland.slice(0, 5).map(r => r.id);
    const activeCritIds2 = new Set(_activeCriteriaOrder('team1'));
    const orderedCriteria = state.criteria.filter(c => !activeCritIds2.size || activeCritIds2.has(c.id));
    if (orderedCriteria.length) {
      const colStats = orderedCriteria.map(crit => {
        const ci   = state.criteria.findIndex(c => c.id === crit.id);
        const vals = state.alternatives.map(a => a.values[ci]).filter(v => v != null);
        return { min: Math.min(...vals), max: Math.max(...vals) };
      });
      const spiderCanvas = document.getElementById('combined-spider');
      if (spiderCanvas) _renderSpiderChart(spiderCanvas, displayIds, orderedCriteria, colStats, displayIds.map(_altColor));
    }
  }

  // Pairwise matrix: shown in the "Table" view slot
  const tableWrap = document.getElementById('combined-criteria-table-wrap');
  if (tableWrap && !tableWrap.hidden) _renderPairwiseMatrix(copeland, r1, r2);
}

function _renderPairwiseMatrix(copeland, r1, r2) {
  const tableDiv = document.getElementById('combined-criteria-table-wrap');
  if (!tableDiv) return;

  const rankOf = (results, id) => results.find(r => r.id === id)?.rank ?? Infinity;
  const ids    = copeland.map(r => r.id);

  const thead = `<thead><tr><th></th>${ids.map(id => `<th title="${escHtml(id)}">${escHtml(id)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${ids.map(id => {
    const cells = ids.map(other => {
      if (id === other) return `<td class="pairwise-cell-self">./td>`;
      let winsA = 0, winsB = 0;
      for (const res of [r1, r2]) {
        const ra = rankOf(res, id), rb = rankOf(res, other);
        if (ra < rb) winsA++; else if (rb < ra) winsB++;
      }
      if (winsA > winsB)      return `<td class="pairwise-cell-win">+1</td>`;
      else if (winsB > winsA) return `<td class="pairwise-cell-loss">−1</td>`;
      else                    return `<td class="pairwise-cell-tie">0</td>`;
    }).join('');
    return `<tr><th title="${escHtml(id)}">${escHtml(id)}</th>${cells}</tr>`;
  }).join('')}</tbody>`;

  tableDiv.innerHTML = `
    <p class="sensitivity-section-label">Pairwise matrix</p>
    <p class="sensitivity-hint">Each cell shows whether the row alternative beats (+1), loses to (−1), or ties (0) the column alternative across both teams' rankings.</p>
    <table class="pairwise-table">${thead}${tbody}</table>`;
}

// ── Mode 3: Sensitivity Analysis ──────────────────────────────────────────────

/**
 * Build a per-criterion weight map for a team (criterionId → normalized weight).
 * Criteria absent from the team's order get weight 0.
 */
function _buildWeightVectorForTeam(teamId) {
  // Respect the active criteria filter so sensitivity matches what the team is actually comparing.
  // Always use p=1 (linear rank-order weights) so the sensitivity reflects each
  // team's actual priority ordering regardless of the shared weight-exponent slider.
  // At p=0 both teams would get equal weights and the analysis becomes meaningless.
  const criteriaOrder = _activeCriteriaOrder(teamId);
  const weights = rankOrderWeights(criteriaOrder.map((_, i) => i + 1), 1);
  return new Map(criteriaOrder.map((id, i) => [id, weights[i]]));
}

async function computeSensitivity(nSteps = 20) {
  const gen = ++state.sensitivityGen;
  state.sensitivityRunning = true;
  state.sensitivityCache   = null;
  renderSensitivityPanel(); // show progress bar

  const w1 = _buildWeightVectorForTeam('team1');
  const w2 = _buildWeightVectorForTeam('team2');

  // Respect active filters: use the union of both teams' active criteria and alternatives.
  const activeCritIds = [...new Set([..._activeCriteriaOrder('team1'), ..._activeCriteriaOrder('team2')])];
  const activeCriteria = activeCritIds.map(id => state.criteria.find(c => c.id === id)).filter(Boolean);
  const critIds = activeCriteria.map(c => c.id);
  const types   = activeCriteria.map(c => c.type);

  const r1 = _activeResults('team1');
  const r2 = _activeResults('team2');
  const altIds = [...new Set([...r1.map(r => r.id), ...r2.map(r => r.id)])];
  const matrix = altIds.map(altId => {
    const alt = state.alternatives.find(a => a.id === altId);
    return critIds.map(critId => {
      const ci = state.criteria.findIndex(c => c.id === critId);
      return alt?.values[ci] ?? 0;
    });
  });
  const steps   = Array.from({ length: nSteps + 1 }, (_, i) => i / nSteps);
  const allRanks = [];

  const progressFill = document.getElementById('sensitivity-progress-fill');
  const progressText = document.getElementById('sensitivity-progress-text');

  for (let si = 0; si <= nSteps; si++) {
    const t = steps[si];
    const mixed = critIds.map(id => (1 - t) * (w1.get(id) ?? 0) + t * (w2.get(id) ?? 0));
    const sum   = mixed.reduce((a, b) => a + b, 0);
    const norm  = sum > 0 ? mixed.map(w => w / sum) : mixed.map(() => 1 / mixed.length);

    let scores;
    try {
      scores = runMethod(state.method, matrix, norm, types);
    } catch {
      scores = altIds.map(() => 0);
    }
    allRanks.push(scoreToRank(scores));

    if (si % 5 === 0 || si === nSteps) {
      const pct = Math.round((si / nSteps) * 100);
      if (progressFill) progressFill.style.width = pct + '%';
      if (progressText) progressText.textContent = `Computing… ${si} / ${nSteps}`;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }

  // Detect flip points: steps where rank-1 alternative changes
  const rank1At = step => {
    const r = allRanks[step];
    return altIds[r.indexOf(Math.min(...r))];
  };
  const flipPoints = [];
  for (let si = 1; si <= nSteps; si++) {
    if (rank1At(si) !== rank1At(si - 1)) flipPoints.push(steps[si]);
  }

  // Per-alternative rank-1 spans
  const summary = [];
  let current = rank1At(0), spanStart = 0;
  for (let si = 1; si <= nSteps; si++) {
    const here = rank1At(si);
    if (here !== current || si === nSteps) {
      const end = here !== current ? steps[si - 1] : steps[si];
      summary.push({ id: current, from: spanStart, to: end });
      current = here; spanStart = steps[si];
    }
  }

  // Weight disagreement table
  const weightDiff = critIds.map((id) => ({
    id,
    shortName: state.criteria.find(c => c.id === id)?.shortName || id,
    w1: (w1.get(id) ?? 0) * 100,
    w2: (w2.get(id) ?? 0) * 100,
    diff: Math.abs((w1.get(id) ?? 0) - (w2.get(id) ?? 0)) * 100
  })).sort((a, b) => b.diff - a.diff).slice(0, 5);

  // Midpoint weight blend (t=0.5) used for method-comparison spider
  const midMixed = critIds.map(id => 0.5 * (w1.get(id) ?? 0) + 0.5 * (w2.get(id) ?? 0));
  const midSum   = midMixed.reduce((a, b) => a + b, 0);
  const midWeights = midSum > 0 ? midMixed.map(w => w / midSum) : midMixed.map(() => 1 / midMixed.length);

  if (gen !== state.sensitivityGen) return; // invalidated while computing
  state.sensitivityCache   = { steps, altIds, ranks: allRanks, flipPoints, summary, weightDiff, matrix, critIds, types, midWeights };
  state.sensitivityRunning = false;
  renderSensitivityPanel();
}

function renderSensitivityPanel() {
  const chartWrap   = document.getElementById('combined-chart-wrap');
  const controls    = document.getElementById('combined-sensitivity-controls');
  const progressDiv = document.getElementById('combined-sensitivity-progress');
  const summaryDiv  = document.getElementById('combined-sensitivity-summary');
  const resultsDiv  = document.getElementById('combined-sensitivity-results');
  const methodsDiv  = document.getElementById('combined-sensitivity-methods');
  if (!controls) return;

  controls.hidden = false;

  if (state.sensitivityRunning) {
    if (progressDiv) progressDiv.hidden = false;
    if (chartWrap)   chartWrap.hidden   = true;
    if (resultsDiv)  resultsDiv.hidden  = true;
    if (methodsDiv)  methodsDiv.hidden  = true;
    return;
  }

  if (progressDiv) progressDiv.hidden = true;

  if (!state.sensitivityCache) {
    if (chartWrap)  chartWrap.hidden  = true;
    if (resultsDiv) resultsDiv.hidden = true;
    if (methodsDiv) methodsDiv.hidden = true;
    if (summaryDiv) summaryDiv.innerHTML = '';
    computeSensitivity();
    return;
  }

  // Results ready
  if (chartWrap)  chartWrap.hidden  = false;
  if (resultsDiv) resultsDiv.hidden = false;
  if (methodsDiv) methodsDiv.hidden = false;

  const canvas = document.getElementById('combined-chart');
  if (canvas) _renderSensitivityLineChart(canvas, state.sensitivityCache);

  if (summaryDiv) _renderSensitivitySummary(summaryDiv, state.sensitivityCache);
  if (resultsDiv) _renderSensitivityResults(resultsDiv, state.sensitivityCache);
  _renderMethodComparisonSpider(state.sensitivityCache);
}

function _renderSensitivityLineChart(canvas, cache) {
  _destroyChart(canvas);
  if (typeof Chart === 'undefined') return;

  const { steps, altIds, ranks, flipPoints } = cache;
  const tickColor = _cssVar('--text-muted');
  const gridColor = _cssVar('--border');

  // Median rank per alternative (for prominence sorting)
  const medianRank = altIds.map((_, ai) => {
    const sorted = steps.map((_, si) => ranks[si][ai]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  });
  const topAltIndices = altIds
    .map((_, i) => ({ i, med: medianRank[i] }))
    .sort((a, b) => a.med - b.med)
    .slice(0, 3)
    .map(x => x.i);

  const PALETTE = [_cssVar('--team1'), _cssVar('--team2'), _cssVar('--combined'), '#a78bfa', '#fb923c', '#34d399'];

  const altDatasets = altIds.map((id, ai) => {
    const isTop   = topAltIndices.includes(ai);
    const color   = isTop ? PALETTE[topAltIndices.indexOf(ai) % PALETTE.length] : _cssVar('--text-dim');
    return {
      label:       id,
      data:        steps.map((_, si) => ranks[si][ai]),
      borderColor: color,
      backgroundColor: color,
      borderWidth: isTop ? 2.5 : 1,
      pointRadius: isTop ? 3 : 0,
      tension:     0.2,
      borderDash:  isTop ? [] : [3, 3],
      fill:        false
    };
  });

  const flipDatasets = flipPoints.map(t => ({
    label:       `Flip at ${Math.round(t * 100)}%`,
    data:        steps.map(s => s === t ? 1 : null),
    borderColor: _cssVar('--text-dim'),
    borderWidth: 1,
    borderDash:  [4, 4],
    pointRadius: 0,
    fill:        false,
    showLine:    true,
    spanGaps:    false
  }));

  const wrap = canvas.parentElement;
  if (wrap) wrap.style.height = '260px';

  canvas._chart = new Chart(canvas, {
    type: 'line',
    data: { labels: steps.map(t => Math.round(t * 100) + '%'), datasets: [...altDatasets, ...flipDatasets] },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: '← Team 1 weights    Team 2 weights →', color: tickColor },
          ticks: { color: tickColor, maxTicksLimit: 11 },
          grid:  { color: gridColor }
        },
        y: {
          reverse: true,
          min:     1,
          max:     altIds.length,
          title:   { display: true, text: 'Rank', color: tickColor },
          ticks:   { color: tickColor, stepSize: 1, callback: v => Number.isInteger(v) ? `#${v}` : '' },
          grid:    { color: gridColor }
        }
      },
      plugins: {
        legend: {
          display:  true,
          position: 'bottom',
          labels:   { color: tickColor, filter: item => !item.text.startsWith('Flip'), boxWidth: 10, font: { size: 10 } }
        },
        tooltip: {
          callbacks: {
            title: ctx => `Weight blend: ${ctx[0]?.label}`,
            label: ctx => ` ${ctx.dataset.label}: Rank #${ctx.parsed.y}`
          }
        }
      }
    }
  });
}

function _renderSensitivitySummary(el, cache) {
  const { weightDiff } = cache;

  const diffRows = weightDiff.map(d =>
    `<tr><td>${escHtml(d.shortName)}</td><td>${d.w1.toFixed(1)}%</td><td>${d.w2.toFixed(1)}%</td><td><strong>${d.diff.toFixed(1)}pp</strong></td></tr>`
  ).join('');

  el.innerHTML = `
    <div class="sensitivity-weight-details">
      <p class="sensitivity-section-label">Largest weight disagreements (top 5)</p>
      <p class="sensitivity-hint">Criteria with the largest priority difference drive ranking instability.</p>
      <table class="sensitivity-weight-table">
        <thead><tr><th>Criterion</th><th>${escHtml(state.teams.team1.name)}</th><th>${escHtml(state.teams.team2.name)}</th><th>Diff</th></tr></thead>
        <tbody>${diffRows}</tbody>
      </table>
    </div>
    <div class="sensitivity-chart-header">
      <p class="sensitivity-section-label">Ranking sensitivity</p>
      <p class="sensitivity-hint">Shows how the final ranking changes as weights shift from Team 1's to Team 2's criteria priority order. Weight is always p = 1.</p>
    </div>`;
}

function _renderSensitivityResults(el, cache) {
  const { summary, flipPoints } = cache;

  const flipText = flipPoints.length === 0
    ? '<p>No flip points. The top alternative is stable regardless of whose weights are used.</p>'
    : `<p>Top alternative changes at: <strong>${flipPoints.map(t => Math.round(t * 100) + '%').join(', ')}</strong></p>`;

  const spans = summary.map(s =>
    `<li><strong>${escHtml(s.id)}</strong> leads from ${Math.round(s.from * 100)}% to ${Math.round(s.to * 100)}%</li>`
  ).join('');

  el.innerHTML = `${flipText}<ul class="sensitivity-spans">${spans}</ul>`;
}

/**
 * Resolve a weight vector (in critIds order) for the method-comparison spider.
 *
 * mode       | source
 * -----------|---------------------------------------------------
 * 'consensus'| combined team's agreed criteria order (default)
 * 'combined' | midpoint blend of team1+team2 (Copeland tab)
 * 'team1'    | team 1's criteria priority order
 * 'team2'    | team 2's criteria priority order
 */
function _weightsForSpiderMode(mode, critIds, midWeights) {
  if (mode === 'combined') return midWeights; // pre-computed blend in cache
  const teamId = mode === 'consensus' ? 'combined' : mode; // 'combined' state key = consensus order
  const wMap = _buildWeightVectorForTeam(teamId);
  const raw  = critIds.map(id => wMap.get(id) ?? 0);
  const sum  = raw.reduce((a, b) => a + b, 0);
  return sum > 0 ? raw.map(v => v / sum) : raw.map(() => 1 / raw.length);
}

/**
 * Render the method-comparison radar chart: axes = TOPSIS + SAW + active method
 * (if not already one of the two), one dataset per selected alternative.
 */
function _renderMethodComparisonSpider(cache) {
  const canvas = document.getElementById('combined-method-spider');
  if (!canvas || typeof Chart === 'undefined') return;

  const { matrix, types, midWeights, altIds, critIds } = cache;
  if (!matrix?.length || !midWeights?.length) { _destroyChart(canvas); return; }

  const spiderMethodKeys = ['topsis', 'saw'];
  if (!spiderMethodKeys.includes(state.method)) spiderMethodKeys.push(state.method);
  const SPIDER_METHODS = spiderMethodKeys;
  const METHOD_LABELS  = spiderMethodKeys.map(k => METHODS[k]?.label ?? k.toUpperCase());

  // Resolve which weight vector to use based on the dropdown.
  const modeEl = document.getElementById('spider-weight-mode');
  const mode   = modeEl?.value ?? 'consensus';
  // Update team name labels now that state is loaded
  if (modeEl) {
    const t1opt = modeEl.querySelector('option[value="team1"]');
    const t2opt = modeEl.querySelector('option[value="team2"]');
    if (t1opt && state.teams.team1.name) t1opt.textContent = state.teams.team1.name;
    if (t2opt && state.teams.team2.name) t2opt.textContent = state.teams.team2.name;
  }
  const spiderWeights = _weightsForSpiderMode(mode, critIds, midWeights);
  if (!spiderWeights) { _destroyChart(canvas); return; }

  // Determine which alternatives to display first.
  // Fall back to top-5 by score (using full matrix) only when nothing is selected.
  const selectedIds = new Set([...state.teams.team1.selections, ...state.teams.team2.selections]);
  let displayIds = altIds.filter(id => selectedIds.has(id));
  if (!displayIds.length) {
    const fallbackScores = SPIDER_METHODS.map(m => {
      try { return runMethod(m, matrix, spiderWeights, types); }
      catch { return altIds.map(() => 0); }
    });
    const fallbackNorm = fallbackScores.map(normaliseScores);
    displayIds = altIds
      .map((id, ai) => ({ id, avg: fallbackNorm.reduce((s, n) => s + n[ai], 0) / SPIDER_METHODS.length }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 5)
      .map(r => r.id);
  }
  // Sort clockwise: A1, A2, A3… A9, A11, A12…
  displayIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  // Build a sub-matrix for displayIds only.  This ensures rankings and
  // normalised scores are computed within this set, not against the full
  // alt pool (which would skew TOPSIS/MABAC ideal/anti-ideal values).
  const displayMatrix = displayIds.map(id => matrix[altIds.indexOf(id)]);
  const displayScores = SPIDER_METHODS.map(m => {
    try { return runMethod(m, displayMatrix, spiderWeights, types); }
    catch { return displayIds.map(() => 0); }
  });

  // Normalise each method's scores to [0, 1] so axes are comparable
  const normalised = displayScores.map(normaliseScores);

  const methodPalette = ['#3b82f6', '#f59e0b', '#22c55e', '#ec4899'];
  const gridColor = _cssVar('--border');
  const tickColor = _cssVar('--text-muted');

  // ── Chart 1: axes = methods, lines = alternatives (normalised scores) ──────
  const datasets1 = displayIds.map((id, di) => {
    const data  = normalised.map(n => +(n[di] ?? 0).toFixed(3));
    const color = _altColor(id);
    const alt   = state.alternatives.find(a => a.id === id);
    return {
      label:                id + (alt?.description ? `: ${alt.description}` : ''),
      data,
      backgroundColor:      _hexToRgba(color, 0.12),
      borderColor:          color,
      pointBackgroundColor: color,
      pointRadius:          4,
      borderWidth:          2
    };
  });

  const radarOpts = (_labels, max, tooltipFn) => ({
    responsive: true, maintainAspectRatio: true, aspectRatio: 1,
    layout: { padding: 10 },
    scales: {
      r: {
        min: 0, max,
        ticks:       { display: false },
        grid:        { color: gridColor },
        angleLines:  { color: gridColor },
        pointLabels: { color: tickColor, font: { size: 11 } }
      }
    },
    plugins: {
      legend: { display: true, position: 'bottom',
        labels: { color: tickColor, boxWidth: 10, padding: 8, usePointStyle: true, font: { size: 10 } } },
      tooltip: { callbacks: { label: tooltipFn } }
    }
  });

  if (canvas._chart && JSON.stringify(canvas._chart.data.labels) === JSON.stringify(METHOD_LABELS)) {
    canvas._chart.data.datasets = datasets1;
    canvas._chart.update('none');
  } else {
    _destroyChart(canvas);
    canvas._chart = new Chart(canvas, {
      type: 'radar',
      data: { labels: METHOD_LABELS, datasets: datasets1 },
      options: radarOpts(METHOD_LABELS, 1, ctx => ` ${ctx.dataset.label}: ${(ctx.parsed.r * 100).toFixed(0)}%`)
    });
  }

  // ── Chart 2: axes = alternatives, lines = methods (rank-based) ────────────
  const canvas2 = document.getElementById('combined-method-spider-2');
  if (!canvas2) return;

  const n = displayIds.length;
  // Rank within the displayed set only. Rank #1 (best) -> n (outer ring); rank #n (worst) -> 1 (centre).
  const datasets2 = SPIDER_METHODS.map((_m, mi) => {
    const data = invertRanksForDisplay(displayScores[mi]); // rank 1 (best) -> n (far from centre)
    const color  = methodPalette[mi % methodPalette.length];
    return {
      label:                METHOD_LABELS[mi],
      data,
      backgroundColor:      _hexToRgba(color, 0.12),
      borderColor:          color,
      pointBackgroundColor: color,
      pointRadius:          4,
      borderWidth:          2
    };
  });

  if (canvas2._chart) {
    canvas2._chart.data.labels   = displayIds;
    canvas2._chart.data.datasets = datasets2;
    canvas2._chart.update('none');
  } else {
    canvas2._chart = new Chart(canvas2, {
      type: 'radar',
      data: { labels: displayIds, datasets: datasets2 },
      options: radarOpts(displayIds, n, ctx => ` ${ctx.dataset.label}: rank #${n - ctx.parsed.r + 1}`)
    });
  }
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
  const { extraDatasets = [], showLegend = false, xMin = 0 } = opts;

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

  // Fixed px per bar: same value for all charts so bars are always identical size
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

  // Destroy and recreate if the existing chart is a different type (e.g. switching from sensitivity line chart)
  if (canvas._chart && canvas._chart.config.type !== 'bar') {
    _destroyChart(canvas);
  }

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
      scales: _baseChartScales(tickColor, gridColor, xMin)
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the criteria-values heatmap table HTML.
 * Returns a <div class="cvt-scroll"><table …>…</table></div> string.
 *
 * @param {Array<{id,description,rank,score,isSelected}>} rows  sorted as desired
 * @param {Array<{id,name,shortName,type}>} orderedCriteria  columns in order
 * @param {string} scoreLabel  header text for the score column
 */
function _buildCriteriaTableHTML(rows, orderedCriteria, scoreLabel) {
  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = rows
      .map(r => state.alternatives.find(a => a.id === r.id)?.values[ci])
      .filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  const thead = `<thead><tr>
    <th class="cvt-rank">#</th>
    <th class="cvt-id"></th>
    <th class="cvt-score">${escHtml(scoreLabel)}</th>
    ${orderedCriteria.map(c => { const ci = _criterionIcon(c); return `<th title="${ci ? ci + ' ' : ''}${escHtml(c.name)} (${c.type === 1 ? '↑ benefit' : '↓ cost'})">${ci ? ci + ' ' : ''}${escHtml(c.id)}</th>`; }).join('')}
  </tr></thead>`;

  const tbody = `<tbody>${rows.map(r => {
    const alt   = state.alternatives.find(a => a.id === r.id);
    const cells = orderedCriteria.map((crit, ci) => {
      const idx = state.criteria.findIndex(c => c.id === crit.id);
      const v   = alt?.values[idx] ?? null;
      const bg  = v != null ? _heatmapColor(v, colStats[ci].min, colStats[ci].max, crit.type) : 'var(--surface2)';
      return `<td class="cvt-cell" style="background:${bg}" title="${escHtml(crit.id)}: ${v != null ? v : '-'}">${v != null ? v : '-'}</td>`;
    }).join('');
    const rowTitle = ` title="${escHtml(r.id)}: ${escHtml(r.description)}"`;
    return `<tr class="${r.isSelected ? 'selected-alt' : ''}"${rowTitle}><td class="cvt-rank">${r.rank}</td><td class="cvt-id">${escHtml(r.id)}</td><td class="cvt-score">${r.score.toFixed(3)}</td>${cells}</tr>`;
  }).join('')}</tbody>`;

  return `<div class="cvt-scroll"><table class="criteria-values-table">${thead}${tbody}</table></div>`;
}

/**
 * Render a radar/spider chart onto a canvas.
 * Shared by both per-team and combined views.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string[]} displayIds  alternative IDs to render as datasets
 * @param {Array<{id,name,shortName,type}>} orderedCriteria  axes in order
 * @param {Array<{min,max}>} colStats  per-criterion value range (from all alternatives)
 * @param {string[]} palette  CSS hex colors, cycled per dataset
 */
function _renderSpiderChart(canvas, displayIds, orderedCriteria, colStats, palette) {
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
    const color = palette[di % palette.length];
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
    labels:   orderedCriteria.map(c => { const ci = _criterionIcon(c); return ci ? `${ci} ${c.id}` : c.id; }),
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
      layout: { padding: 20 },
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
              return ` ${id}: ${crit?.shortName || crit?.id}: ${raw != null ? raw : 'N/A'} (norm ${norm})`;
            }
          }
        }
      }
    }
  });
}

/**
 * Render the criteria-values heatmap table for a team panel.
 * Only executes when the table view is visible (chart-wrap is hidden).
 */
function renderCriteriaTable(teamId) {
  const wrap = document.getElementById(`${teamId}-criteria-table-wrap`);
  if (!wrap || wrap.hidden) return;

  const rows = _sortById(_activeResults(teamId));
  if (!rows.length) { wrap.innerHTML = '<p class="empty-msg" style="padding:.75rem 1rem">No data</p>'; return; }

  const activeCritIds   = new Set(_activeCriteriaOrder(teamId));
  const orderedCriteria = state.criteria.filter(c => activeCritIds.has(c.id));
  if (!orderedCriteria.length) { wrap.innerHTML = ''; return; }

  wrap.innerHTML = _buildCriteriaTableHTML(rows, orderedCriteria, state.method.toUpperCase());
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

  const activeCritIds = new Set(_activeCriteriaOrder(teamId));
  const orderedCriteria = state.criteria.filter(c => activeCritIds.has(c.id));
  if (!orderedCriteria.length) { _destroyChart(canvas); return; }

  const sels = team.selections;
  let displayResults = sels.length > 0
    ? results.filter(r => sels.includes(r.id))
    : results.slice(0, 5);
  if (!displayResults.length) displayResults = results.slice(0, 5);

  const colStats = orderedCriteria.map(crit => {
    const ci   = state.criteria.findIndex(c => c.id === crit.id);
    const vals = state.alternatives.map(a => a.values[ci]).filter(v => v != null);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  });

  _renderSpiderChart(canvas, displayResults.map(r => r.id), orderedCriteria, colStats, displayResults.map(r => _altColor(r.id)));
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

  // Save ranking buttons: delegated so dynamically-rendered buttons are covered
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-save-ranking[data-team]');
    if (btn) saveRanking(btn.dataset.team);
  });

  // Shared p-value slider: affects both teams
  const sharedSlider = document.getElementById('shared-p-slider');
  sharedSlider?.addEventListener('input', () => {
    state.p = parseFloat(sharedSlider.value);
    updatePLabel(state.p);
    _onSharedSettingChanged();
  });
  sharedSlider?.addEventListener('change', () => {
    logEvent(state.scriptUrl, 'p_value_changed', null, { p: state.p });
  });

  // Shared method dropdown: affects both teams
  document.getElementById('shared-method-select')?.addEventListener('change', e => {
    state.method = e.target.value;
    logEvent(state.scriptUrl, 'algorithm_changed', null, { method: state.method });
    _updateMethodDesc();
    _onSharedSettingChanged();
  });

  // Method description panel: restore open/closed state from localStorage
  const _methodDescPanel = document.getElementById('method-desc-panel');
  if (_methodDescPanel) {
    if (localStorage.getItem('method-desc-open') === 'false') _methodDescPanel.removeAttribute('open');
    _methodDescPanel.addEventListener('toggle', () => {
      localStorage.setItem('method-desc-open', String(_methodDescPanel.open));
    });
  }

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
      renderCombinedPanel();
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
      _invalidateSensitivity();
      for (const teamId of TEAMS) { renderResults(teamId); renderChart(teamId); renderCriteriaTable(teamId); renderSpiderChart(teamId); }
      renderCombinedPanel();
    }

    // Criteria selection checkboxes
    if (e.target.classList.contains('criterion-checkbox')) {
      const { team: teamId, id: criterionId } = e.target.dataset;
      if (!teamId || !criterionId) return;
      const sels = state.teams[teamId].criteriaSelections;
      if (e.target.checked) {
        if (!sels.includes(criterionId)) sels.push(criterionId);
      } else {
        state.teams[teamId].criteriaSelections = sels.filter(id => id !== criterionId);
      }
      recompute(teamId);
      _invalidateSensitivity();
      renderCriteriaList(teamId);
      if (teamId !== 'combined') {
        renderResults(teamId);
        renderChart(teamId);
        renderCriteriaTable(teamId);
        renderSpiderChart(teamId);
      }
      renderCombinedPanel();
    }

    // "Calculate selected criteria only" toggle: global filter, re-render everything
    if (e.target.classList.contains('calc-criteria-checkbox')) {
      _invalidateSensitivity();
      for (const teamId of TEAMS) {
        renderCriteriaList(teamId);
        renderResults(teamId);
        renderChart(teamId);
        renderCriteriaTable(teamId);
        renderSpiderChart(teamId);
      }
      renderCombinedPanel();
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
      _invalidateSensitivity();
      renderResults(teamId);
      for (const id of TEAMS) { renderChart(id); renderCriteriaTable(id); renderSpiderChart(id); }
      renderCombinedPanel();
      updateDirtyIndicator(teamId);
    }
  });

  // Save snapshot
  document.getElementById('spider-weight-mode')?.addEventListener('change', () => {
    if (state.sensitivityCache) _renderMethodComparisonSpider(state.sensitivityCache);
  });

  document.getElementById('save-snapshot-btn')?.addEventListener('click', async () => {
    const name = prompt('Snapshot name:', `Snapshot ${new Date().toLocaleTimeString()}`);
    if (name === null) return; // cancelled
    const snap = await saveSnapshot(name, _captureState(), state.scriptUrl);
    logEvent(state.scriptUrl, 'snapshot_saved', null, { name });
    state.snapshots = loadLocalSnapshots();
    state.activeSnapshot = snap;
    renderSnapshotsList();
  });

  // Snapshots list: load or delete (event delegation)
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

  // Combined mode tabs
  document.getElementById('combined-mode-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.combined-mode-tab');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === state.combinedMode) return;
    _applyMode(mode);
    // Consensus: seed combined criteria order if empty and recompute
    if (mode === 'consensus') {
      if (!state.teams.combined.criteriaOrder.length) {
        state.teams.combined.criteriaOrder = state.criteria.map(c => c.id);
      }
      if (!state.results.combined.length) recompute('combined');
    }
    // Sensitivity: auto-run
    if (mode === 'sensitivity') {
      computeSensitivity();
    }
    // Invalidate sensitivity cache on mode switch away from sensitivity
    if (mode !== 'sensitivity') _invalidateSensitivity();
    renderCombinedPanel();
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
        .catch(() => setStatus('offline', 'Sheet unreachable, working offline'));
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
      setStatus('offline', 'Sheet unreachable, working offline');
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
  } catch { /* quota exceeded: ignore */ }
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
  const cloneTeam = t => ({
    name:               t.name,
    criteriaOrder:      [...t.criteriaOrder],
    criteriaSelections: [...t.criteriaSelections],
    selections:         [...t.selections],
  });
  return {
    p:            state.p,
    method:       state.method,
    combinedMode: state.combinedMode,
    teams: {
      team1:    cloneTeam(state.teams.team1),
      team2:    cloneTeam(state.teams.team2),
      combined: cloneTeam(state.teams.combined),
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

  for (const teamId of [...TEAMS, 'combined']) {
    if (saved.teams?.[teamId]) {
      Object.assign(state.teams[teamId], {
        criteriaOrder:      saved.teams[teamId].criteriaOrder      ?? [],
        criteriaSelections: saved.teams[teamId].criteriaSelections ?? [],
        selections:         saved.teams[teamId].selections         ?? [],
        isDirty:            true
      });
    }
  }
  if (saved.combinedMode) _applyMode(saved.combinedMode);
  _invalidateSensitivity();
}

/** Apply all DOM changes needed when the combined mode changes, without triggering recompute. */
function _applyMode(mode) {
  state.combinedMode = mode;

  // Tab buttons
  document.querySelectorAll('.combined-mode-tab').forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });

  // Mode-specific element visibility
  const _set = (id, hidden) => { const el = document.getElementById(id); if (el) el.hidden = hidden; };
  _set('combined-sensitivity-controls',  mode !== 'sensitivity');
  _set('combined-sensitivity-results',   mode !== 'sensitivity');
  _set('combined-sensitivity-methods',   mode !== 'sensitivity');
  _set('combined-copeland-description',  mode !== 'copeland');
  _set('combined-consensus-description', mode !== 'consensus');

  const viewToggle = document.getElementById('combined-view-toggle');
  if (viewToggle) viewToggle.hidden = mode === 'sensitivity';

  // Reset to bar view
  if (mode !== 'sensitivity') {
    _set('combined-chart-wrap',         false);
    _set('combined-spider-wrap',        true);
    _set('combined-criteria-table-wrap', true);
    viewToggle?.querySelectorAll('.btn-view-icon').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'bar')
    );
  } else {
    _set('combined-chart-wrap',          true);
    _set('combined-criteria-table-wrap', true);
  }

  // Subtitle
  const subtitleMap = { consensus: 'Consensus', copeland: 'Combined', sensitivity: 'Sensitivity Analysis' };
  const subtitleEl = document.getElementById('combined-subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitleMap[mode] ?? 'Combined';

  // Grid layout and consensus-only panels
  document.querySelector('.main-grid')?.classList.toggle('main-grid--mode-consensus', mode === 'consensus');
  _set('combined-criteria-col', mode !== 'consensus');
  _set('combined-results-col',  mode !== 'consensus');

  // Persist
  try { localStorage.setItem('madm_combined_mode', mode); } catch {}
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

const ALT_PALETTE = [
  '#2ea0ed', '#3abf8f', '#f59e0b', '#a78bfa', '#fb923c',
  '#f43f5e', '#22d3ee', '#84cc16', '#e879f9', '#64748b',
  '#06b6d4', '#10b981', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#6366f1', '#ef4444', '#0ea5e9',
];

/** Returns a stable color for an alternative ID based on its position in state.alternatives. */
function _altColor(altId) {
  const idx = state.alternatives.findIndex(a => a.id === altId);
  return ALT_PALETTE[(idx >= 0 ? idx : 0) % ALT_PALETTE.length];
}

/** Read a CSS custom property value from :root. */
function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Shared Chart.js scale config for all score bar charts.
 * Both team charts and the combined chart use the same axis structure.
 */
function _baseChartScales(tickColor, gridColor, xMin = 0) {
  return {
    x: {
      min: xMin,
      title: { display: true, text: 'Score', color: tickColor },
      ticks: { color: tickColor },
      grid:  { color: gridColor }
    },
    y: {
      ticks: { color: tickColor, font: { size: 11 }, autoSkip: false },
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
  _invalidateSensitivity();
  for (const teamId of TEAMS) {
    state.teams[teamId].isDirty = true;
    recompute(teamId);
    renderPanel(teamId);
    updateDirtyIndicator(teamId);
  }
  renderCombinedPanel();
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
 * This is the single source of truth for criterion icons: used in table
 * headers, the criteria priority list, spider chart axis labels, and any
 * tooltips, so the icon↔criterion connection is always consistent.
 */
function _criterionIcon(criterion) {
  const text = `${criterion.name ?? ''} ${criterion.shortName ?? ''}`.toLowerCase();
  const rules = [
    // Navigability: size-specific before generic (big ship > ferry > sailboat)
    [/navigab.*(big|large)|(big|large).*vessel/,    '🚢'],
    [/navigab.*medium|medium.*vessel/,               '⛴️'],
    [/navigab.*(small)|small.*vessel/,               '⛵'],
    [/navigab/,                                      '⛵'],
    // Energy / power
    [/energy|power|electricity|hydropower|gwh/,      '⚡'],
    // Birds / wildlife
    [/bird/,                                         '🐦'],
    // Food production: location before generic
    [/food.*(down|downstream)|downstream.*food/,     '🌽🏞️'],
    [/food.*(up|upstream)|upstream.*food/,           '🌽🏔️'],
    [/food|crop|agricult|irrigat|maize|grain/,       '🌽'],
    // Evaporation: location before generic
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
