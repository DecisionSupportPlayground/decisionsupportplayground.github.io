/**
 * snapshots.js: Snapshot save / load / merge.
 *
 * Snapshots capture the full decision state (both teams' criteria order,
 * settings, and computed results) at a moment in time.
 *
 * Storage strategy:
 *   Primary  : browser localStorage  (survives page refresh, private to device)
 *   Secondary: Google Sheet           (shared, requires scriptUrl)
 *
 * Sheet pushes are best-effort: a failure logs a warning but does not
 * prevent the local save from succeeding.
 */

import { saveSnapshotToSheet, deleteSnapshotFromSheet } from './data.js';

const STORAGE_KEY = 'madm_snapshots_v1';

// ─────────────────────────────────────────────────────────────────────────────
// Local storage helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Array<{id:string, name:string, timestamp:string, state:object}>} */
export function loadLocalSnapshots() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function _persist(snapshots) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and save a snapshot.
 *
 * @param {string}  name        Label chosen by the user.
 * @param {object}  state       Full app state to capture (deep-cloned).
 * @param {string}  [scriptUrl] If provided, also push to the Google Sheet.
 * @returns {Promise<{id, name, timestamp, state}>}  The saved snapshot.
 */
export async function saveSnapshot(name, state, scriptUrl) {
  const snapshot = {
    id:        `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name:      name.trim() || `Snapshot ${new Date().toLocaleTimeString()}`,
    timestamp: new Date().toISOString(),
    state:     _deepClone(state)
  };

  const snapshots = loadLocalSnapshots();
  snapshots.push(snapshot);
  _persist(snapshots);

  if (scriptUrl) {
    try {
      await saveSnapshotToSheet(scriptUrl, snapshot);
    } catch (err) {
      console.warn('Could not push snapshot to sheet (local save succeeded):', err.message);
    }
  }

  return snapshot;
}

/**
 * Delete a snapshot by ID from localStorage (and from the sheet if connected).
 *
 * @param {string}  id
 * @param {string}  [scriptUrl]
 * @returns {Promise<void>}
 */
export async function deleteSnapshot(id, scriptUrl) {
  _persist(loadLocalSnapshots().filter(s => s.id !== id));

  if (scriptUrl) {
    try {
      await deleteSnapshotFromSheet(scriptUrl, id);
    } catch (err) {
      console.warn('Could not delete snapshot from sheet:', err.message);
    }
  }
}

/**
 * Merge snapshots received from the sheet into localStorage, deduplicating
 * by ID.  Sheet version wins on conflict (same ID, different content).
 *
 * @param {Array<{id, name, timestamp, state}>} sheetSnapshots
 */
export function mergeSheetSnapshots(sheetSnapshots) {
  const local = loadLocalSnapshots();
  const byId  = new Map(local.map(s => [s.id, s]));
  for (const s of sheetSnapshots) byId.set(s.id, s); // sheet wins
  _persist([...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function _deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}
