/**
 * tests/results_7criteria.test.js
 *
 * Validates TOPSIS, SAW, and MABAC on the 9-alternative selected subset with
 * the top-7 criteria from the combined priority order (I9, I2, I3, I10, I4,
 * I5, I7), mirroring the "Calculate selected criteria only" feature in the UI.
 *
 * Also validates normaliseScores and invertRanksForDisplay — the helpers used
 * by the method-comparison spider chart in Sensitivity Analysis.  These tests
 * import the actual exported functions from mcdm.js rather than re-implementing
 * the logic inline.
 *
 * Combined criteria priority order (from consensus.json):
 *   I9(1) > I2(2) > I3(3) > I10(4) > I4(5) > I5(6) > I7(7)
 *
 * Sub-matrix columns (combined priority order):
 *   [I9, I2, I3, I10, I4, I5, I7]
 *   types: [+1, +1, +1, +1, +1, +1, -1]
 *
 * Reference scores confirmed against Sample_script_MCAM.py (P=1 table).
 *
 * A{n} label -> sub-matrix row index:
 *   A{1}  -> 0  A1     Situation as is
 *   A{2}  -> 1  A4     1b+2
 *   A{3}  -> 2  A5     1p+2
 *   A{4}  -> 3  A6.2   3+4  (50% water diverted)
 *   A{5}  -> 4  A7     1b+2+4  (20% bypass)
 *   A{6}  -> 5  A7.3   1b+2+4  (40% bypass)
 *   A{7}  -> 6  A9     1b+2+3+4  (full combined)
 *   A{8}  -> 7  A11.2  bypass only (50%)
 *   A{9}  -> 8  A12    1b+2+3
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';

import {
  initMCDM,
  topsis,
  saw,
  mabac,
  rankOrderWeights,
  scoreToRank,
  normaliseScores,
  invertRanksForDisplay,
} from '../js/mcdm.js';

before(async () => { await initMCDM(); });

// ─────────────────────────────────────────────────────────────────────────────
// Input data: 9 alternatives x 7 criteria (I9, I2, I3, I10, I4, I5, I7)
// Values extracted from the full 22-alt matrix in results_filtered.test.js,
// columns [8, 1, 2, 9, 3, 4, 6] (0-indexed, for I9, I2, I3, I10, I4, I5, I7).
// ─────────────────────────────────────────────────────────────────────────────

const MATRIX_7 = [
  //  I9           I2         I3    I10       I4    I5      I7
  [ 6400109,   2394.758,   236,        0,  316,  347,  0.000 ],  // A1    row 0
  [ 6400109,  10440.646,   246,  1028062,  317,  344,  0.579 ],  // A4    row 1
  [ 6400109,  10053.412,   233,    64833,  315,  344,  0.508 ],  // A5    row 2
  [ 7943622,   2394.758,   285,        0,  342,  257,  0.000 ],  // A6.2  row 3
  [ 6400109,  10705.428,   271,   507389,  331,  347,  0.587 ],  // A7    row 4
  [ 7488127,  10705.428,   295,   507389,  350,  365,  0.587 ],  // A7.3  row 5
  [ 6907498,  10440.646,   267,  1028062,  330,  347,  0.579 ],  // A9    row 6
  [ 7360125,   2394.758,   285,        0,  342,  257,  0.000 ],  // A11.2 row 7
  [ 6907498,  10440.646,   246,  1028062,  316,  343,  0.579 ],  // A12   row 8
];

// benefit (+1) / cost (-1) for [I9, I2, I3, I10, I4, I5, I7]
const TYPES_7 = [1, 1, 1, 1, 1, 1, -1];

// Combined priority ranks for [I9, I2, I3, I10, I4, I5, I7]: 1 = most important
const RANKS_7 = [1, 2, 3, 4, 5, 6, 7];

const TOL = 0.02;

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${label}: expected ~${expected}, got ${actual.toFixed(4)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOPSIS
// ─────────────────────────────────────────────────────────────────────────────

describe('TOPSIS scores — 7-criteria subset', () => {

  it('at p=0 (equal weights)', () => {
    const scores = topsis(MATRIX_7, rankOrderWeights(RANKS_7, 0), TYPES_7);
    near(scores[0], 0.40, 'A{1} A1');
    near(scores[1], 0.59, 'A{2} A4');
    near(scores[2], 0.33, 'A{3} A5');
    near(scores[3], 0.41, 'A{4} A6.2');
    near(scores[4], 0.46, 'A{5} A7');
    near(scores[5], 0.47, 'A{6} A7.3');
    near(scores[6], 0.60, 'A{7} A9');
    near(scores[7], 0.40, 'A{8} A11.2');
    near(scores[8], 0.60, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = topsis(MATRIX_7, rankOrderWeights(RANKS_7, 0.5), TYPES_7);
    near(scores[0], 0.25, 'A{1} A1');
    near(scores[1], 0.73, 'A{2} A4');
    near(scores[2], 0.40, 'A{3} A5');
    near(scores[3], 0.27, 'A{4} A6.2');
    near(scores[4], 0.57, 'A{5} A7');
    near(scores[5], 0.59, 'A{6} A7.3');
    near(scores[6], 0.75, 'A{7} A9');
    near(scores[7], 0.26, 'A{8} A11.2');
    near(scores[8], 0.74, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const scores = topsis(MATRIX_7, rankOrderWeights(RANKS_7, 1), TYPES_7);
    near(scores[0], 0.13, 'A{1} A1');
    near(scores[1], 0.79, 'A{2} A4');
    near(scores[2], 0.45, 'A{3} A5');
    near(scores[3], 0.21, 'A{4} A6.2');
    near(scores[4], 0.63, 'A{5} A7');
    near(scores[5], 0.66, 'A{6} A7.3');
    near(scores[6], 0.83, 'A{7} A9');
    near(scores[7], 0.18, 'A{8} A11.2');
    near(scores[8], 0.82, 'A{9} A12');
  });

});

describe('TOPSIS rankings — 7-criteria subset', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(topsis(MATRIX_7, rankOrderWeights(RANKS_7, 0), TYPES_7));
    assert.strictEqual(ranks[0], 7,  'A{1} A1');
    assert.strictEqual(ranks[1], 3,  'A{2} A4');
    assert.strictEqual(ranks[2], 9,  'A{3} A5');
    assert.strictEqual(ranks[3], 6,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 4,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 1,  'A{7} A9');
    assert.strictEqual(ranks[7], 8,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 2,  'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(topsis(MATRIX_7, rankOrderWeights(RANKS_7, 0.5), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 3,  'A{2} A4');
    assert.strictEqual(ranks[2], 6,  'A{3} A5');
    assert.strictEqual(ranks[3], 7,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 4,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 1,  'A{7} A9');
    assert.strictEqual(ranks[7], 8,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 2,  'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(topsis(MATRIX_7, rankOrderWeights(RANKS_7, 1), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 3,  'A{2} A4');
    assert.strictEqual(ranks[2], 6,  'A{3} A5');
    assert.strictEqual(ranks[3], 7,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 4,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 1,  'A{7} A9');
    assert.strictEqual(ranks[7], 8,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 2,  'A{9} A12');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// SAW
// ─────────────────────────────────────────────────────────────────────────────

describe('SAW scores — 7-criteria subset', () => {

  it('at p=0 (equal weights)', () => {
    const scores = saw(MATRIX_7, rankOrderWeights(RANKS_7, 0), TYPES_7);
    near(scores[0], 0.67, 'A{1} A1');
    near(scores[1], 0.78, 'A{2} A4');
    near(scores[2], 0.65, 'A{3} A5');
    near(scores[3], 0.70, 'A{4} A6.2');
    near(scores[4], 0.73, 'A{5} A7');
    near(scores[5], 0.78, 'A{6} A7.3');
    near(scores[6], 0.81, 'A{7} A9');
    near(scores[7], 0.69, 'A{8} A11.2');
    near(scores[8], 0.79, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = saw(MATRIX_7, rankOrderWeights(RANKS_7, 0.5), TYPES_7);
    near(scores[0], 0.62, 'A{1} A1');
    near(scores[1], 0.84, 'A{2} A4');
    near(scores[2], 0.69, 'A{3} A5');
    near(scores[3], 0.67, 'A{4} A6.2');
    near(scores[4], 0.79, 'A{5} A7');
    near(scores[5], 0.84, 'A{6} A7.3');
    near(scores[6], 0.87, 'A{7} A9');
    near(scores[7], 0.66, 'A{8} A11.2');
    near(scores[8], 0.85, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const scores = saw(MATRIX_7, rankOrderWeights(RANKS_7, 1), TYPES_7);
    near(scores[0], 0.59, 'A{1} A1');
    near(scores[1], 0.87, 'A{2} A4');
    near(scores[2], 0.72, 'A{3} A5');
    near(scores[3], 0.66, 'A{4} A6.2');
    near(scores[4], 0.82, 'A{5} A7');
    near(scores[5], 0.88, 'A{6} A7.3');
    near(scores[6], 0.90, 'A{7} A9');
    near(scores[7], 0.64, 'A{8} A11.2');
    near(scores[8], 0.88, 'A{9} A12');
  });

});

describe('SAW rankings — 7-criteria subset', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(saw(MATRIX_7, rankOrderWeights(RANKS_7, 0), TYPES_7));
    assert.strictEqual(ranks[0], 8,  'A{1} A1');
    assert.strictEqual(ranks[1], 3,  'A{2} A4');
    assert.strictEqual(ranks[2], 9,  'A{3} A5');
    assert.strictEqual(ranks[3], 6,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 4,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 1,  'A{7} A9');
    assert.strictEqual(ranks[7], 7,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 2,  'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(saw(MATRIX_7, rankOrderWeights(RANKS_7, 0.5), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 4,  'A{2} A4');
    assert.strictEqual(ranks[2], 6,  'A{3} A5');
    assert.strictEqual(ranks[3], 7,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 3,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 1,  'A{7} A9');
    assert.strictEqual(ranks[7], 8,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 2,  'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(saw(MATRIX_7, rankOrderWeights(RANKS_7, 1), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 4,  'A{2} A4');
    assert.strictEqual(ranks[2], 6,  'A{3} A5');
    assert.strictEqual(ranks[3], 7,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 3,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 1,  'A{7} A9');
    assert.strictEqual(ranks[7], 8,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 2,  'A{9} A12');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// MABAC
// ─────────────────────────────────────────────────────────────────────────────

describe('MABAC scores — 7-criteria subset', () => {

  it('at p=0 (equal weights)', () => {
    const scores = mabac(MATRIX_7, rankOrderWeights(RANKS_7, 0), TYPES_7);
    near(scores[0], -0.14, 'A{1} A1');
    near(scores[1],  0.02, 'A{2} A4');
    near(scores[2], -0.14, 'A{3} A5');
    near(scores[3],  0.10, 'A{4} A6.2');
    near(scores[4],  0.07, 'A{5} A7');
    near(scores[5],  0.33, 'A{6} A7.3');
    near(scores[6],  0.17, 'A{7} A9');
    near(scores[7],  0.04, 'A{8} A11.2');
    near(scores[8],  0.06, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = mabac(MATRIX_7, rankOrderWeights(RANKS_7, 0.5), TYPES_7);
    near(scores[0], -0.25, 'A{1} A1');
    near(scores[1],  0.03, 'A{2} A4');
    near(scores[2], -0.15, 'A{3} A5');
    near(scores[3],  0.09, 'A{4} A6.2');
    near(scores[4],  0.08, 'A{5} A7');
    near(scores[5],  0.37, 'A{6} A7.3');
    near(scores[6],  0.20, 'A{7} A9');
    near(scores[7],  0.01, 'A{8} A11.2');
    near(scores[8],  0.09, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const scores = mabac(MATRIX_7, rankOrderWeights(RANKS_7, 1), TYPES_7);
    near(scores[0], -0.31, 'A{1} A1');
    near(scores[1],  0.03, 'A{2} A4');
    near(scores[2], -0.15, 'A{3} A5');
    near(scores[3],  0.10, 'A{4} A6.2');
    near(scores[4],  0.08, 'A{5} A7');
    near(scores[5],  0.40, 'A{6} A7.3');
    near(scores[6],  0.22, 'A{7} A9');
    near(scores[7],  0.01, 'A{8} A11.2');
    near(scores[8],  0.11, 'A{9} A12');
  });

});

describe('MABAC rankings — 7-criteria subset', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(mabac(MATRIX_7, rankOrderWeights(RANKS_7, 0), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 7,  'A{2} A4');
    assert.strictEqual(ranks[2], 8,  'A{3} A5');
    assert.strictEqual(ranks[3], 3,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 4,  'A{5} A7');
    assert.strictEqual(ranks[5], 1,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 2,  'A{7} A9');
    assert.strictEqual(ranks[7], 6,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 5,  'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(mabac(MATRIX_7, rankOrderWeights(RANKS_7, 0.5), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 6,  'A{2} A4');
    assert.strictEqual(ranks[2], 8,  'A{3} A5');
    assert.strictEqual(ranks[3], 4,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 1,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 2,  'A{7} A9');
    assert.strictEqual(ranks[7], 7,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 3,  'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(mabac(MATRIX_7, rankOrderWeights(RANKS_7, 1), TYPES_7));
    assert.strictEqual(ranks[0], 9,  'A{1} A1');
    assert.strictEqual(ranks[1], 6,  'A{2} A4');
    assert.strictEqual(ranks[2], 8,  'A{3} A5');
    assert.strictEqual(ranks[3], 4,  'A{4} A6.2');
    assert.strictEqual(ranks[4], 5,  'A{5} A7');
    assert.strictEqual(ranks[5], 1,  'A{6} A7.3');
    assert.strictEqual(ranks[6], 2,  'A{7} A9');
    assert.strictEqual(ranks[7], 7,  'A{8} A11.2');
    assert.strictEqual(ranks[8], 3,  'A{9} A12');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// normaliseScores — unit tests (exported from mcdm.js, used by spider chart)
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliseScores', () => {

  it('maps min to 0 and max to 1', () => {
    const result = normaliseScores([0.1, 0.5, 0.8, 0.3]);
    near(result[0], 0.0, 'min -> 0');
    near(result[2], 1.0, 'max -> 1');
  });

  it('scales intermediate values correctly', () => {
    // range = 0.8 - 0.1 = 0.7
    // (0.5 - 0.1) / 0.7 = 4/7; (0.3 - 0.1) / 0.7 = 2/7
    const result = normaliseScores([0.1, 0.5, 0.8, 0.3]);
    near(result[1], 4 / 7, '0.5 -> 4/7');
    near(result[3], 2 / 7, '0.3 -> 2/7');
  });

  it('returns 0.5 for all-identical scores (flat)', () => {
    const result = normaliseScores([0.42, 0.42, 0.42]);
    result.forEach((v, i) => near(v, 0.5, `index ${i}`));
  });

  it('all output values are in [0, 1]', () => {
    const result = normaliseScores([3, 1, 4, 1, 5, 9, 2, 6]);
    result.forEach((v, i) =>
      assert.ok(v >= 0 && v <= 1, `index ${i} out of range: ${v}`)
    );
  });

  it('normalises TOPSIS scores at p=1 to [0, 1]', () => {
    // pre-computed TOPSIS scores for 7-criteria subset at p=1
    const rawScores = [0.1345, 0.7926, 0.4537, 0.2061, 0.6327, 0.6593, 0.8318, 0.1787, 0.8172];
    const result    = normaliseScores(rawScores);
    // min=A1(0.1345)->0, max=A9(0.8318)->1
    near(result[0], 0.00,  'A{1} A1  -> 0 (min)');
    near(result[6], 1.00,  'A{7} A9  -> 1 (max)');
    near(result[1], 0.94,  'A{2} A4');
    near(result[5], 0.75,  'A{6} A7.3');
    near(result[8], 0.98,  'A{9} A12');
    result.forEach((v, i) =>
      assert.ok(v >= 0 && v <= 1, `index ${i} out of range: ${v}`)
    );
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// invertRanksForDisplay — unit tests (exported from mcdm.js, used by spider chart)
// ─────────────────────────────────────────────────────────────────────────────

describe('invertRanksForDisplay', () => {

  it('maps best score to n and worst to 1', () => {
    // [0.5, 0.3, 0.8, 0.1]: n=4, sorted=[0.8,0.5,0.3,0.1]
    // 0.8 at index 0 -> 4-0=4; 0.1 at index 3 -> 4-3=1
    const result = invertRanksForDisplay([0.5, 0.3, 0.8, 0.1]);
    assert.strictEqual(result[2], 4, 'max score (0.8) -> n=4');
    assert.strictEqual(result[3], 1, 'min score (0.1) -> 1');
  });

  it('produces correct display values for all elements', () => {
    // sorted desc: [0.8, 0.5, 0.3, 0.1]
    // 0.5 -> idx 1 -> 4-1=3; 0.3 -> idx 2 -> 4-2=2
    assert.deepStrictEqual(
      invertRanksForDisplay([0.5, 0.3, 0.8, 0.1]),
      [3, 2, 4, 1]
    );
  });

  it('all output values are in [1, n]', () => {
    const scores = [0.57, 0.71, 0.41, 0.29, 0.56, 0.58, 0.72, 0.28, 0.71];
    const n      = scores.length;
    invertRanksForDisplay(scores).forEach((v, i) =>
      assert.ok(v >= 1 && v <= n, `index ${i} out of range: ${v}`)
    );
  });

  it('maps TOPSIS ranks to display values (rank 1 -> n, rank n -> 1)', () => {
    // TOPSIS at p=1: A9=rank1, A12=rank2, A4=rank3, A7.3=rank4,
    //                A7=rank5, A5=rank6, A6.2=rank7, A11.2=rank8, A1=rank9
    const rawScores = [0.1345, 0.7926, 0.4537, 0.2061, 0.6327, 0.6593, 0.8318, 0.1787, 0.8172];
    const display   = invertRanksForDisplay(rawScores);
    // n=9; rank-1 (A9, idx 6) -> 9; rank-9 (A1, idx 0) -> 1
    assert.strictEqual(display[6], 9, 'A{7} A9   rank-1 -> display 9');
    assert.strictEqual(display[0], 1, 'A{1} A1   rank-9 -> display 1');
    assert.strictEqual(display[8], 8, 'A{9} A12  rank-2 -> display 8');
    assert.strictEqual(display[1], 7, 'A{2} A4   rank-3 -> display 7');
    assert.strictEqual(display[5], 6, 'A{6} A7.3 rank-4 -> display 6');
    assert.strictEqual(display[4], 5, 'A{5} A7   rank-5 -> display 5');
    assert.strictEqual(display[2], 4, 'A{3} A5   rank-6 -> display 4');
    assert.strictEqual(display[3], 3, 'A{4} A6.2 rank-7 -> display 3');
    assert.strictEqual(display[7], 2, 'A{8} A11.2 rank-8 -> display 2');
  });

});
