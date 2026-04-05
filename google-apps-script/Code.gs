/**
 * MADM Decision Maker — Google Apps Script backend
 * ===================================================
 *
 * ⚠️  PUBLIC ACCESS NOTICE
 * ─────────────────────────────────────────────────────────────────────────
 * This script is deployed as a publicly accessible web service
 * ("Anyone, even anonymous" execution).  Any person who obtains the
 * deployed URL can read AND write data to your spreadsheet.
 *
 * Do NOT store sensitive, personal, confidential, or proprietary
 * information in this spreadsheet.  It is intended for collaborative
 * academic group exercises only.
 *
 * If you accidentally share the URL, re-deploy (Extensions → Apps Script
 * → Deploy → Manage deployments → New deployment).  The old URL will
 * immediately stop working.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Setup instructions: see SETUP.md in the project repository, or run
 * the "MADM Setup → Initialize Sheet Structure" menu item after opening
 * this spreadsheet for the first time.
 *
 * Sheet tabs used:
 *   Alternatives  — read-only decision matrix (filled in manually)
 *   Rankings      — team ranking state (managed by the web app)
 *   Snapshots     — saved snapshots      (managed by the web app)
 *   _meta         — internal last-modified timestamp (hidden)
 */

// ─── Tab names ───────────────────────────────────────────────────────────────
var TAB_ALTERNATIVES = 'Alternatives';
var TAB_RANKINGS     = 'Rankings';
var TAB_SNAPSHOTS    = 'Snapshots';
var TAB_META         = '_meta';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles GET requests.
 *
 * Query parameters:
 *   action=lastModified  → returns { lastModified: "ISO-timestamp" }
 *   (anything else)      → returns full data snapshot
 */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'all';

    if (action === 'lastModified') {
      return _json({ lastModified: _getLastModified() });
    }

    // Return everything in one round trip
    return _json({
      alternatives: _getSheetValues(TAB_ALTERNATIVES),
      rankings:     _getSheetValues(TAB_RANKINGS),
      snapshots:    _getSheetValues(TAB_SNAPSHOTS),
      lastModified: _getLastModified()
    });

  } catch (err) {
    return _json({ error: err.message });
  }
}

/**
 * Handles POST requests.
 *
 * Expected body (JSON string):
 *   { action: 'saveRankings',  team: 'team1'|'team2',  rankings: {...} }
 *   { action: 'saveSnapshot',  snapshot: { id, name, timestamp, state } }
 *   { action: 'deleteSnapshot', id: 'snap_...' }
 */
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    switch (payload.action) {
      case 'saveRankings':
        _saveRankings(payload.team, payload.rankings);
        return _json({ ok: true });

      case 'saveSnapshot':
        _saveSnapshot(payload.snapshot);
        return _json({ ok: true });

      case 'deleteSnapshot':
        _deleteSnapshot(payload.id);
        return _json({ ok: true });

      default:
        return _json({ error: 'Unknown action: ' + payload.action });
    }

  } catch (err) {
    return _json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rankings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts one team row in the Rankings tab.
 *
 * Rankings tab layout:
 *   Col A: team          ("team1" | "team2")
 *   Col B: criteriaOrder (JSON array of criterion IDs, e.g. ["I1","I2",...])
 *   Col C: selections    (JSON array of alternative IDs,  e.g. ["A1","A4",...])
 *   Col D: p             (number: 0 | 0.5 | 1)
 *   Col E: method        (string: "topsis" | "saw" | "mabac" | "aras")
 *   Col F: lastUpdated   (ISO timestamp)
 */
function _saveRankings(team, rankings) {
  var sheet = _getOrCreateSheet(TAB_RANKINGS);

  // Ensure header row exists
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['team', 'criteriaOrder', 'selections', 'p', 'method', 'lastUpdated']);
  }

  var data = sheet.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === team) { rowIdx = i + 1; break; } // 1-based
  }

  var newRow = [
    team,
    JSON.stringify(rankings.criteriaOrder || []),
    JSON.stringify(rankings.selections    || []),
    rankings.p      !== undefined ? rankings.p      : 0,
    rankings.method !== undefined ? rankings.method : 'topsis',
    new Date().toISOString()
  ];

  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 1, 1, newRow.length).setValues([newRow]);
  } else {
    sheet.appendRow(newRow);
  }

  _touchLastModified();
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshots tab layout:
 *   Col A: id         (unique string, e.g. "snap_1712345678_abc12")
 *   Col B: name       (human-readable label)
 *   Col C: timestamp  (ISO string)
 *   Col D: state      (JSON blob of the full app state)
 */
function _saveSnapshot(snapshot) {
  var sheet = _getOrCreateSheet(TAB_SNAPSHOTS);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['id', 'name', 'timestamp', 'state']);
  }

  sheet.appendRow([
    snapshot.id,
    snapshot.name,
    snapshot.timestamp,
    JSON.stringify(snapshot.state || {})
  ]);

  _touchLastModified();
}

function _deleteSnapshot(id) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_SNAPSHOTS);
  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  // Iterate in reverse to safely delete rows
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1); // getValues is 0-based; deleteRow is 1-based
    }
  }

  _touchLastModified();
}

// ─────────────────────────────────────────────────────────────────────────────
// Last-modified timestamp
// ─────────────────────────────────────────────────────────────────────────────

function _getLastModified() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_META);
  if (!sheet) return new Date().toISOString();
  var val = sheet.getRange(1, 1).getValue();
  return val ? String(val) : new Date().toISOString();
}

function _touchLastModified() {
  var sheet = _getOrCreateSheet(TAB_META);
  sheet.getRange(1, 1).setValue(new Date().toISOString());
  // Keep _meta hidden
  if (!sheet.isSheetHidden()) {
    try { sheet.hideSheet(); } catch (_) { /* may fail in some contexts */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _getSheetValues(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet || sheet.getLastRow() === 0) return [];
  return sheet.getDataRange().getValues();
}

function _getOrCreateSheet(name) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function _json(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time setup (run from the spreadsheet menu)
// ─────────────────────────────────────────────────────────────────────────────

/** Adds a "MADM Setup" menu when the spreadsheet is opened. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MADM Setup')
    .addItem('Initialize sheet structure', 'initializeSheets')
    .addSeparator()
    .addItem('About / help', 'showHelp')
    .addToUi();
}

/**
 * Creates required tabs with the correct headers if they don't already exist.
 * Safe to run multiple times — existing data is not overwritten.
 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Alternatives tab ──────────────────────────────────────────────────────
  var altSheet = _getOrCreateSheet(TAB_ALTERNATIVES);
  if (altSheet.getLastRow() === 0) {
    altSheet.appendRow([
      'ID',
      'Description',
      'I1: Bird Habitat Index (the higher the better)',
      'I2: Overall Energy Generation GWh/year (the higher the better)',
      'I3: Navigability of Big Vessels days/year (the higher the better)',
      'I4: Navigability of Medium Vessels days/year (the higher the better)',
      'I5: Navigability of Small Vessels days/year (the higher the better)',
      'I6: Catchment Evaporation Downstream m3 (the higher the worst)',
      'I7: Catchment Evaporation Upstream m3 (the higher the worst)',
      'I8: Wetland Evaporation m3 (the higher the worst)',
      'I9: Food Production Downstream tons/year (the higher the better)',
      'I10: Food Production Upstream tons/year (the higher the better)'
    ]);
    // Example data row (matches DATA_SelectedIndicators&Alternatives.csv)
    altSheet.appendRow(['A1','Situation as is',0.6,2394.758,236,316,347,21.193,0,20.61,6400109,0]);
    altSheet.appendRow(['A2','1b',             0.6,10739.871,251,318,344,21.19,0.588,20.61,6400109,0]);
    altSheet.appendRow(['A3','1p',             0.6,10149.887,233,315,344,21.186,0.51,20.61,6400109,0]);
    altSheet.appendRow(['A4','1b+2',           0.6,10440.646,246,317,344,21.188,0.579,20.61,6400109,1028062]);
    altSheet.appendRow(['A5','1p+2',           0.6,10053.412,233,315,344,21.186,0.508,20.61,6400109,64833]);
    altSheet.appendRow(['A6','3+4 20%bypass',  0.39,2394.758,259,328,347,17.671,0,17.213,6907498,0]);
    altSheet.appendRow(['A6.1','3+4 30%',      0.312,2394.758,270,335,352,14.14,0,13.77,7252873,0]);
    altSheet.appendRow(['A6.2','3+4 50%',      0.273,2394.758,285,342,257,12.37,0,12.05,7943622,0]);
    altSheet.appendRow(['A6.3','3+4 70%',      0.195,2394.758,295,350,365,5.3,0,5.163,8634372,0]);
    altSheet.appendRow(['A7','1b+2+4 20%',     0.39,10705.428,271,331,347,17.674,0.587,17.674,6400109,507389]);
    altSheet.appendRow(['A7.1','1b+2+4 10%',   0.35,10705.428,270,335,352,21.2,0.587,21.208,6592112,507389]);
    altSheet.appendRow(['A7.2','1b+2+4 25%',   0.31,10705.428,285,342,257,16.78,0.587,16.79,7040120,507389]);
    altSheet.appendRow(['A7.3','1b+2+4 40%',   0.27,10705.428,295,350,365,14.14,0.587,14.139,7488127,507389]);
    altSheet.appendRow(['A9','1b+2+3+4',       0.39,10440.646,267,330,347,17.667,0.579,17.667,6907498,1028062]);
    altSheet.appendRow(['A11','4 20%bypass',   0.39,2394.758,261,328,347,17.677,0,17.677,6400109,0]);
    altSheet.appendRow(['A11.2','4 50%',       0.27,2394.758,285,342,257,12.374,0,12.374,7360125,0]);
    altSheet.appendRow(['A12','1b+2+3',        0.6,10440.646,246,316,343,21.183,0.579,21.183,6907498,1028062]);
    SpreadsheetApp.getUi().alert('Alternatives tab populated with example data.\nReplace with your own data as needed.');
  }

  // ── Rankings tab ─────────────────────────────────────────────────────────
  var rankSheet = _getOrCreateSheet(TAB_RANKINGS);
  if (rankSheet.getLastRow() === 0) {
    rankSheet.appendRow(['team','criteriaOrder','selections','p','method','lastUpdated']);
    // Default state from DATA_Ranking.csv
    rankSheet.appendRow([
      'team1',
      JSON.stringify(['I4','I1','I7','I9','I6','I5','I8','I10','I3','I2']),
      JSON.stringify(['A1','A4','A5','A7.3','A9','A12']),
      0, 'topsis', new Date().toISOString()
    ]);
    rankSheet.appendRow([
      'team2',
      JSON.stringify(['I2','I3','I8','I10','I4','I5','I6','I9','I7','I1']),
      JSON.stringify(['A4','A6.2','A7','A7.1','A9','A11.2']),
      0, 'topsis', new Date().toISOString()
    ]);
  }

  // ── Snapshots tab ────────────────────────────────────────────────────────
  var snapSheet = _getOrCreateSheet(TAB_SNAPSHOTS);
  if (snapSheet.getLastRow() === 0) {
    snapSheet.appendRow(['id','name','timestamp','state']);
  }

  _touchLastModified();
  SpreadsheetApp.getUi().alert(
    'Sheet structure initialized.\n\n' +
    'Next step: Deploy as a web app.\n' +
    'Extensions → Apps Script → Deploy → New deployment\n' +
    'Execute as: Me\n' +
    'Who has access: Anyone\n\n' +
    'Copy the deployment URL and paste it into the MADM Decision Maker app.'
  );
}

function showHelp() {
  SpreadsheetApp.getUi().alert(
    'MADM Decision Maker — Help\n\n' +
    'This spreadsheet is the data backend for the MADM Decision Maker web app.\n\n' +
    'Tabs:\n' +
    '  Alternatives — the decision matrix (edit this with your alternatives data)\n' +
    '  Rankings     — team rankings saved by the web app (do not edit manually)\n' +
    '  Snapshots    — saved decision snapshots (do not edit manually)\n\n' +
    'For setup instructions, see SETUP.md in the project repository.'
  );
}
