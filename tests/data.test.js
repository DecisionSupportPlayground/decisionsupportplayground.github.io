/**
 * tests/data.test.js
 *
 * Unit tests for CSV parsing in js/data.js.
 * Run with:  npm test
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  parseAlternativesCSV,
  parseRankingsData,
  parseSnapshotsData
} from '../js/data.js';

// ─────────────────────────────────────────────────────────────────────────────
// parseAlternativesCSV
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAlternativesCSV', () => {
  const CLEAN_CSV = [
    'ID,Description,I1: Discharge (the higher the better),I2: Cost (the higher the worst),I3: Wetlands (the higher the worst)',
    'A1,Location 1,2.5,50,500',
    'A2,Location 2,3,60,850',
    'A3,Location 3,4,80,1000'
  ].join('\n');

  it('parses criteria count correctly', () => {
    const { criteria } = parseAlternativesCSV(CLEAN_CSV);
    assert.strictEqual(criteria.length, 3);
  });

  it('assigns correct types from header hints', () => {
    const { criteria } = parseAlternativesCSV(CLEAN_CSV);
    assert.strictEqual(criteria[0].type,  1, 'Discharge should be benefit (+1)');
    assert.strictEqual(criteria[1].type, -1, 'Cost should be cost (-1)');
    assert.strictEqual(criteria[2].type, -1, 'Wetlands should be cost (-1)');
  });

  it('assigns criterion IDs as I1, I2, I3 …', () => {
    const { criteria } = parseAlternativesCSV(CLEAN_CSV);
    assert.strictEqual(criteria[0].id, 'I1');
    assert.strictEqual(criteria[1].id, 'I2');
    assert.strictEqual(criteria[2].id, 'I3');
  });

  it('parses correct number of alternatives', () => {
    const { alternatives } = parseAlternativesCSV(CLEAN_CSV);
    assert.strictEqual(alternatives.length, 3);
  });

  it('parses alternative IDs correctly', () => {
    const { alternatives } = parseAlternativesCSV(CLEAN_CSV);
    assert.strictEqual(alternatives[0].id, 'A1');
    assert.strictEqual(alternatives[1].id, 'A2');
    assert.strictEqual(alternatives[2].id, 'A3');
  });

  it('parses numeric values correctly', () => {
    const { alternatives } = parseAlternativesCSV(CLEAN_CSV);
    assert.strictEqual(alternatives[0].values[0], 2.5);
    assert.strictEqual(alternatives[1].values[1], 60);
    assert.strictEqual(alternatives[2].values[2], 1000);
  });

  it('strips type hint from shortName', () => {
    const { criteria } = parseAlternativesCSV(CLEAN_CSV);
    assert.ok(!criteria[0].shortName.includes('the higher'),
      `shortName should not contain "the higher": "${criteria[0].shortName}"`);
  });

  it('skips blank rows silently', () => {
    const csvWithBlanks = CLEAN_CSV + '\n\n,,,\n';
    const { alternatives } = parseAlternativesCSV(csvWithBlanks);
    assert.strictEqual(alternatives.length, 3);
  });

  it('throws when there are no criteria columns', () => {
    assert.throws(
      () => parseAlternativesCSV('ID,Description\nA1,Foo'),
      /No criterion columns found/
    );
  });

  it('throws when there are no data rows', () => {
    // Header row present but no rows starting with an alternative ID
    const csvHeaderOnly = [
      'ID,Description,I1 (the higher the better)',
      ',empty row,',
      ',,another empty'
    ].join('\n');
    assert.throws(
      () => parseAlternativesCSV(csvHeaderOnly),
      /No alternative rows found/
    );
  });

  it('handles alternative IDs with dots (e.g. A6.2)', () => {
    const csv = [
      'ID,Description,I1 (the higher the better)',
      'A6.2,Bypass 50%,0.273'
    ].join('\n');
    const { alternatives } = parseAlternativesCSV(csv);
    assert.strictEqual(alternatives[0].id, 'A6.2');
  });

  it('tolerates extra header rows (finds first matching header row)', () => {
    const csvWithPreamble = [
      ',,mgh,',
      ',,',
      'ID,Description,I1: Discharge (the higher the better)',
      'A1,Location 1,2.5'
    ].join('\n');
    const { alternatives } = parseAlternativesCSV(csvWithPreamble);
    assert.strictEqual(alternatives.length, 1);
    assert.strictEqual(alternatives[0].id, 'A1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRankingsData
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRankingsData', () => {
  const ROWS = [
    ['team', 'criteriaOrder', 'selections', 'p', 'method', 'lastUpdated'],
    ['team1', '["I1","I2","I3"]', '["A1","A4"]', 0.5, 'topsis', '2026-04-04T12:00:00Z'],
    ['team2', '["I3","I1","I2"]', '["A2","A5"]', 1,   'saw',    '2026-04-04T12:01:00Z']
  ];

  it('parses team1 criteriaOrder', () => {
    const { team1 } = parseRankingsData(ROWS);
    assert.deepStrictEqual(team1.criteriaOrder, ['I1', 'I2', 'I3']);
  });

  it('parses team2 method', () => {
    const { team2 } = parseRankingsData(ROWS);
    assert.strictEqual(team2.method, 'saw');
  });

  it('parses p as a number', () => {
    const { team1 } = parseRankingsData(ROWS);
    assert.strictEqual(team1.p, 0.5);
  });

  it('returns null for a missing team', () => {
    const { team1, team2 } = parseRankingsData([
      ['team', 'criteriaOrder', 'selections', 'p', 'method', 'lastUpdated'],
      ['team1', '[]', '[]', 0, 'topsis', '']
    ]);
    assert.ok(team1 !== null);
    assert.strictEqual(team2, null);
  });

  it('returns both null for empty data', () => {
    const { team1, team2 } = parseRankingsData([]);
    assert.strictEqual(team1, null);
    assert.strictEqual(team2, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSnapshotsData
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSnapshotsData', () => {
  const ROWS = [
    ['id', 'name', 'timestamp', 'state'],
    ['snap_001', 'Initial', '2026-04-04T10:00:00Z', '{"teams":{}}'],
    ['snap_002', 'After edit', '2026-04-04T11:00:00Z', '{"teams":{"team1":{}}}']
  ];

  it('returns correct number of snapshots', () => {
    const snaps = parseSnapshotsData(ROWS);
    assert.strictEqual(snaps.length, 2);
  });

  it('parses id and name', () => {
    const snaps = parseSnapshotsData(ROWS);
    assert.strictEqual(snaps[0].id,   'snap_001');
    assert.strictEqual(snaps[0].name, 'Initial');
  });

  it('parses state JSON', () => {
    const snaps = parseSnapshotsData(ROWS);
    assert.deepStrictEqual(snaps[1].state, { teams: { team1: {} } });
  });

  it('skips blank rows', () => {
    const rowsWithBlank = [...ROWS, ['', '', '', '']];
    const snaps = parseSnapshotsData(rowsWithBlank);
    assert.strictEqual(snaps.length, 2);
  });

  it('returns empty array for header-only input', () => {
    const snaps = parseSnapshotsData([ROWS[0]]);
    assert.strictEqual(snaps.length, 0);
  });
});
