/**
 * data.js — Data loading and persistence layer.
 *
 * Handles:
 *   - Parsing Alternatives CSV into structured objects
 *   - Parsing Rankings data returned by the Apps Script
 *   - All network communication with the Google Apps Script web app
 *
 * This module has no knowledge of the DOM or MCDM algorithms.
 */

const FETCH_TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// CSV / sheet parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an Alternatives CSV into criteria definitions and alternative rows.
 *
 * Expected format (matches the Google Sheets template):
 *
 *   Row 1  — headers
 *     col 0 : "ID"
 *     col 1 : "Description"
 *     col 2+ : criterion names; each must contain either
 *              "(the higher the better)" → benefit  (type +1)
 *              "(the higher the worst)"  → cost     (type -1)
 *              If neither phrase is found the criterion is treated as
 *              benefit with a console warning.
 *
 *   Rows 2+ — one alternative per row
 *     col 0 : alternative ID  (e.g. "A1", "A6.2")
 *     col 1 : short description
 *     col 2+ : numeric values aligned with header columns
 *
 * Blank rows and rows whose first cell is empty or non-alphabetic are skipped.
 *
 * @param {string} csvText  Raw CSV string.
 * @returns {{
 *   criteria:     Array<{id:string, name:string, shortName:string, type:number}>,
 *   alternatives: Array<{id:string, description:string, values:number[]}>
 * }}
 * @throws {Error} when the format cannot be recognised.
 */
export function parseAlternativesCSV(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) throw new Error('CSV must have at least a header row and one data row.');

  // Locate the header row: the first row (within the first 8) where col 0
  // is "ID" (case-insensitive) or col 2 contains a criterion hint.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const c0 = String(rows[i][0] ?? '').trim().toUpperCase();
    const c2 = String(rows[i][2] ?? '').trim().toLowerCase();
    if (c0 === 'ID' || c2.includes('higher the')) {
      headerIdx = i;
      break;
    }
  }

  const headerRow = rows[headerIdx];
  const criteria = [];
  for (let j = 2; j < headerRow.length; j++) {
    const raw = String(headerRow[j] ?? '').trim();
    if (!raw) continue;

    const isCost = /higher the (worst|worse)/i.test(raw);
    const isBenefit = /higher the better/i.test(raw);
    const type = isCost ? -1 : 1;
    if (!isCost && !isBenefit && raw.length > 0) {
      console.warn(`Criterion at column ${j} ("${raw}") has no type hint — treating as benefit.`);
    }

    // Short name: strip the parenthetical type hint
    const shortName = raw
      .replace(/\s*\(the higher the (better|worst|worse)\)/gi, '')
      .replace(/\s*\(-\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    criteria.push({
      id:        `I${j - 1}`,   // I1, I2, ... (1-based among criteria cols)
      name:      raw,
      shortName: shortName || `I${j - 1}`,
      type
    });
  }

  if (criteria.length === 0) {
    throw new Error(
      'No criterion columns found. ' +
      'Check that the header row uses the standard format and contains ' +
      '"(the higher the better)" or "(the higher the worst)" in criterion names.'
    );
  }

  // Parse data rows: rows after the header where col 0 starts with a letter
  const alternatives = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const id = String(row[0] ?? '').trim();
    if (!id || !/^[A-Za-z]/i.test(id)) continue; // skip blank / non-ID rows

    const description = String(row[1] ?? '').trim();
    const values = criteria.map((_, idx) => {
      const raw = row[idx + 2];
      const num = parseFloat(raw);
      return isNaN(num) ? 0 : num;
    });
    alternatives.push({ id, description, values });
  }

  if (alternatives.length === 0) {
    throw new Error(
      'No alternative rows found. ' +
      'Ensure data rows start with an ID like "A1" after the header row.'
    );
  }

  return { criteria, alternatives };
}

/**
 * Parse the raw 2D array returned by the Apps Script for the Rankings tab.
 *
 * New format (one row per criterion per team):
 *   Row 0 (header): ["team","teamName","criterionId","rank","p","method","selections","lastUpdated"]
 *   Row 1+: ["team1","Upper Basin","I4",1,0,"topsis",'["A1"]',"ISO-timestamp"]
 *   ...one row per criterion for each team
 *
 * Legacy format (one row per team with JSON arrays — still supported for
 * spreadsheets initialized before the format change):
 *   Row 0 (header): ["team","criteriaOrder","selections","p","method","lastUpdated"]
 *   Row 1: ["team1", JSON-array, JSON-array, number, string, ISO-timestamp]
 *
 * @param {any[][]} rows  Raw 2D array from the sheet.
 * @returns {{
 *   team1: {teamName:string, criteriaOrder:string[], selections:string[], p:number, method:string} | null,
 *   team2: {teamName:string, criteriaOrder:string[], selections:string[], p:number, method:string} | null
 * }}
 */
export function parseRankingsData(rows) {
  const result = { team1: null, team2: null };
  if (!rows || rows.length < 2) return result;

  // Detect format from header row:
  //   new format col 1 header = "teamName", col 2 header = "criterionId"
  //   legacy format col 1 header = "criteriaOrder"
  const header = rows[0].map(h => String(h ?? '').trim().toLowerCase());
  const isNewFormat = header[1] === 'teamname' || header[2] === 'criterionid';

  if (isNewFormat) {
    // New format: one row per criterion per team
    const byTeam = { team1: [], team2: [] };
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const team = String(row[0] ?? '').trim();
      if (team === 'team1' || team === 'team2') byTeam[team].push(row);
    }
    for (const team of ['team1', 'team2']) {
      const teamRows = byTeam[team];
      if (!teamRows.length) continue;
      // Sort rows by rank column (index 3)
      teamRows.sort((a, b) => Number(a[3]) - Number(b[3]));
      const firstRow = teamRows[0];
      try {
        result[team] = {
          teamName:     String(firstRow[1] ?? '').trim(),
          criteriaOrder: teamRows.map(r => String(r[2] ?? '').trim()).filter(Boolean),
          selections:   JSON.parse(String(firstRow[6] ?? '') || '[]'),
          p:            parseFloat(firstRow[4]) || 0,
          method:       String(firstRow[5] || 'topsis').trim().toLowerCase()
        };
      } catch {
        console.warn(`Could not parse new-format rankings for ${team}`);
      }
    }
  } else {
    // Legacy format: one row per team with JSON arrays
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const team = String(row[0] ?? '').trim();
      if (team !== 'team1' && team !== 'team2') continue;
      try {
        result[team] = {
          teamName:     '',
          criteriaOrder: JSON.parse(String(row[1] ?? '') || '[]'),
          selections:   JSON.parse(String(row[2] ?? '') || '[]'),
          p:            parseFloat(row[3]) || 0,
          method:       String(row[4] || 'topsis').trim().toLowerCase()
        };
      } catch {
        console.warn(`Could not parse legacy rankings for ${team}`);
      }
    }
  }

  return result;
}

/**
 * Parse the raw 2D array returned by the Apps Script for the Snapshots tab.
 *
 * Expected sheet layout:
 *   Row 0 (header): ["id","name","timestamp","state"]
 *   Row 1+: [id, name, ISO-timestamp, JSON-string-of-state]
 *
 * @param {any[][]} rows
 * @returns {Array<{id:string, name:string, timestamp:string, state:object}>}
 */
export function parseSnapshotsData(rows) {
  const snapshots = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const id = String(row[0] ?? '').trim();
    if (!id) continue;
    try {
      snapshots.push({
        id,
        name:      String(row[1] ?? '').trim() || id,
        timestamp: String(row[2] ?? '').trim(),
        state:     typeof row[3] === 'string' ? JSON.parse(row[3]) : (row[3] ?? {})
      });
    } catch {
      console.warn(`Could not parse snapshot row ${i}`);
    }
  }
  return snapshots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal CSV parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse CSV text into a 2D array of strings.
 * Prefers PapaParse (loaded from vendor/) if available; falls back to a
 * hand-rolled RFC-4180 parser that handles quoted fields with embedded
 * commas and newlines.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsvRows(text) {
  if (typeof Papa !== 'undefined') {
    const result = Papa.parse(text, { skipEmptyLines: false });
    return result.data;
  }
  return _simpleParseCsv(text);
}

function _simpleParseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      field += ch;
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' && text[i + 1] === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
      }
      if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i++; continue;
      }
      field += ch;
    }
    i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Apps Script API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all data (alternatives, rankings, snapshots, lastModified) from the
 * Apps Script web app in a single request.
 *
 * @param {string} scriptUrl  Deployed Apps Script URL.
 * @returns {Promise<{
 *   alternatives: any[][],
 *   rankings:     any[][],
 *   snapshots:    any[][],
 *   lastModified: string
 * }>}
 * @throws {Error} on network failure or non-OK HTTP status.
 */
export async function fetchSheetData(scriptUrl) {
  const res = await _fetchWithTimeout(scriptUrl, {}, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Sheet request failed with status ${res.status}`);
  return res.json();
}

/**
 * Fetch only the lastModified timestamp — lightweight polling check.
 * Avoids re-downloading the full dataset on every poll tick.
 *
 * @param {string} scriptUrl
 * @returns {Promise<string>}  ISO timestamp string.
 */
export async function fetchLastModified(scriptUrl) {
  const url = `${scriptUrl}?action=lastModified`;
  const res = await _fetchWithTimeout(url, {}, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Timestamp fetch failed with status ${res.status}`);
  const data = await res.json();
  return String(data.lastModified ?? '');
}

/**
 * Save one team's complete ranking state to the sheet.
 *
 * @param {string} scriptUrl
 * @param {'team1'|'team2'} team
 * @param {{criteriaOrder:string[], selections:string[], p:number, method:string}} rankingData
 * @returns {Promise<void>}
 */
export async function saveRankingToSheet(scriptUrl, team, rankingData) {
  const res = await _fetchWithTimeout(scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' }, // Apps Script requires text/plain for doPost
    body:    JSON.stringify({ action: 'saveRankings', team, rankings: rankingData })
  }, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Save ranking failed with status ${res.status}`);
}

/**
 * Push a snapshot to the sheet.
 *
 * @param {string} scriptUrl
 * @param {{id:string, name:string, timestamp:string, state:object}} snapshot
 * @returns {Promise<void>}
 */
export async function saveSnapshotToSheet(scriptUrl, snapshot) {
  const res = await _fetchWithTimeout(scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body:    JSON.stringify({ action: 'saveSnapshot', snapshot })
  }, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Save snapshot failed with status ${res.status}`);
}

/**
 * Log a user interaction event to the Events sheet — fire-and-forget.
 * Silently no-ops when scriptUrl is absent (local CSV mode).
 *
 * @param {string} scriptUrl
 * @param {string} event       e.g. 'algorithm_changed'
 * @param {string} team        e.g. 'team1'
 * @param {object} [properties]  event-specific data
 */
export function logEvent(scriptUrl, event, team, properties = {}) {
  if (!scriptUrl) return;
  fetch(scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body:    JSON.stringify({ action: 'logEvent', event, team, properties })
  }).catch(() => {}); // never block the UI
}

/**
 * Delete a snapshot from the sheet.
 *
 * @param {string} scriptUrl
 * @param {string} snapshotId
 * @returns {Promise<void>}
 */
export async function deleteSnapshotFromSheet(scriptUrl, snapshotId) {
  const res = await _fetchWithTimeout(scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body:    JSON.stringify({ action: 'deleteSnapshot', id: snapshotId })
  }, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Delete snapshot failed with status ${res.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function _fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}
