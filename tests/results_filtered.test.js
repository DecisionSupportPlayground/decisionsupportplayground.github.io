/**
 * tests/results_filtered.test.js
 *
 * Validates TOPSIS, SAW, and MABAC on the 9-alternative selected subset with
 * all 10 criteria, mirroring the "Calculate selected alternatives only" feature
 * in the UI.  The filter is applied the same way the UI does it: only the rows
 * for the selected alternatives are passed to the MCDM method.
 *
 * Full 22-alternative MATRIX is defined below (same as results_full.test.js).
 * FILTERED slices out the 9 selected alternatives (A1, A4, A5, A6.2, A7,
 * A7.3, A9, A11.2, A12 — indices 0–8 in MATRIX).
 *
 * Reference scores produced by pymcdm on the filtered subset:
 *   selected alternatives (9): A1 A4 A5 A6.2 A7 A7.3 A9 A11.2 A12
 *   criteria (10): I1–I10 (all)
 *   joint criterion ranking: [9, 2, 3, 5, 6, 10, 7, 8, 1, 4]
 *
 * A{n} label → MATRIX index:
 *   A{1} → 0  A1     Situation as is
 *   A{2} → 1  A4     1b+2
 *   A{3} → 2  A5     1p+2
 *   A{4} → 3  A6.2   3+4  (50 % water diverted)
 *   A{5} → 4  A7     1b+2+4  (20 % bypass)
 *   A{6} → 5  A7.3   1b+2+4  (40 % bypass)
 *   A{7} → 6  A9     1b+2+3+4  (full combined)
 *   A{8} → 7  A11.2  bypass only (50 %)
 *   A{9} → 8  A12    1b+2+3
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';

import { initMCDM, topsis, saw, mabac, rankOrderWeights, scoreToRank } from '../js/mcdm.js';

before(async () => { await initMCDM(); });

// ─────────────────────────────────────────────────────────────────────────────
// Input data — full 22-alternative matrix (same as results_full.test.js)
// ─────────────────────────────────────────────────────────────────────────────

const MATRIX = [
  //  I1       I2          I3    I4    I5      I6       I7      I8       I9         I10
  [0.600,  2394.758,  236,  316,  347, 21.193, 0.000, 20.610, 6400109,       0],  // A1    index 0
  [0.600, 10440.646,  246,  317,  344, 21.188, 0.579, 20.610, 6400109, 1028062],  // A4    index 1
  [0.600, 10053.412,  233,  315,  344, 21.186, 0.508, 20.610, 6400109,   64833],  // A5    index 2
  [0.273,  2394.758,  285,  342,  257, 12.370, 0.000, 12.050, 7943622,       0],  // A6.2  index 3
  [0.390, 10705.428,  271,  331,  347, 17.674, 0.587, 17.674, 6400109,  507389],  // A7    index 4
  [0.270, 10705.428,  295,  350,  365, 14.140, 0.587, 14.139, 7488127,  507389],  // A7.3  index 5
  [0.390, 10440.646,  267,  330,  347, 17.667, 0.579, 17.667, 6907498, 1028062],  // A9    index 6
  [0.270,  2394.758,  285,  342,  257, 12.374, 0.000, 12.374, 7360125,       0],  // A11.2 index 7
  [0.600, 10440.646,  246,  316,  343, 21.183, 0.579, 21.183, 6907498, 1028062],  // A12   index 8
  [0.600, 10739.871,  251,  318,  344, 21.190, 0.588, 20.610, 6400109,       0],  // A2    index 9
  [0.600, 10149.887,  233,  315,  344, 21.186, 0.510, 20.610, 6400109,       0],  // A3    index 10
  [0.390,  2394.758,  259,  328,  347, 17.671, 0.000, 17.213, 6907498,       0],  // A6    index 11
  [0.312,  2394.758,  270,  335,  352, 14.140, 0.000, 13.770, 7252873,       0],  // A6.1  index 12
  [0.195,  2394.758,  295,  350,  365,  5.300, 0.000,  5.163, 8634372,       0],  // A6.3  index 13
  [0.350, 10705.428,  270,  335,  352, 21.200, 0.587, 21.208, 6592112,  507389],  // A7.1  index 14
  [0.310, 10705.428,  285,  342,  257, 16.780, 0.587, 16.790, 7040120,  507389],  // A7.2  index 15
  [0.390, 10053.412,  259,  328,  347, 17.670, 0.508, 17.670, 6400109,   64833],  // A8    index 16
  [0.390, 10053.412,  258,  328,  347, 17.664, 0.508, 17.664, 6907498,   64833],  // A10   index 17
  [0.390,  2394.758,  261,  328,  347, 17.677, 0.000, 17.677, 6400109,       0],  // A11   index 18
  [0.312,  2394.758,  270,  335,  352, 14.141, 0.000, 14.141, 6720114,       0],  // A11.1 index 19
  [0.210,  2394.758,  295,  350,  365,  5.300, 0.000,  5.300, 8000136,       0],  // A11.3 index 20
  [0.600, 10053.412,  233,  315,  343, 21.180, 0.508, 21.180, 6907498,   64833],  // A13   index 21
];

// benefit = +1, cost = -1  (I1…I10 column order)
const TYPES = [1, 1, 1, 1, 1, -1, -1, -1, 1, 1];

// Joint criterion ranking (I1…I10 column order)
const RANKS = [9, 2, 3, 5, 6, 10, 7, 8, 1, 4];

// Filtered sub-matrix: the 9 selected alternatives (indices 0–8)
// Mirrors _computeResults(selectedAlts, teamId) in app.js.
const FILTERED = MATRIX.slice(0, 9);

const TOL = 0.02; // reference scores rounded to 2 d.p.

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${label}: expected ≈ ${expected}, got ${actual.toFixed(3)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOPSIS
// ─────────────────────────────────────────────────────────────────────────────

describe('TOPSIS scores — filtered 9-alt subset', () => {

  it('at p=0 (equal weights)', () => {
    const scores = topsis(FILTERED, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0], 0.42, 'A{1} A1');
    near(scores[1], 0.58, 'A{2} A4');
    near(scores[2], 0.37, 'A{3} A5');
    near(scores[3], 0.42, 'A{4} A6.2');
    near(scores[4], 0.45, 'A{5} A7');
    near(scores[5], 0.46, 'A{6} A7.3');
    near(scores[6], 0.58, 'A{7} A9');
    near(scores[7], 0.42, 'A{8} A11.2');
    near(scores[8], 0.58, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = topsis(FILTERED, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], 0.34, 'A{1} A1');
    near(scores[1], 0.65, 'A{2} A4');
    near(scores[2], 0.38, 'A{3} A5');
    near(scores[3], 0.35, 'A{4} A6.2');
    near(scores[4], 0.51, 'A{5} A7');
    near(scores[5], 0.52, 'A{6} A7.3');
    near(scores[6], 0.66, 'A{7} A9');
    near(scores[7], 0.35, 'A{8} A11.2');
    near(scores[8], 0.65, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const scores = topsis(FILTERED, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], 0.27, 'A{1} A1');
    near(scores[1], 0.71, 'A{2} A4');
    near(scores[2], 0.41, 'A{3} A5');
    near(scores[3], 0.29, 'A{4} A6.2');
    near(scores[4], 0.56, 'A{5} A7');
    near(scores[5], 0.58, 'A{6} A7.3');
    near(scores[6], 0.72, 'A{7} A9');
    near(scores[7], 0.28, 'A{8} A11.2');
    near(scores[8], 0.71, 'A{9} A12');
  });

});

describe('TOPSIS rankings — filtered 9-alt subset', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(topsis(FILTERED, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 7, 'A{1} A1');
    assert.strictEqual(ranks[1], 1, 'A{2} A4');
    assert.strictEqual(ranks[2], 9, 'A{3} A5');
    assert.strictEqual(ranks[3], 6, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 4, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 3, 'A{7} A9');
    assert.strictEqual(ranks[7], 8, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 2, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(topsis(FILTERED, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 3, 'A{2} A4');
    assert.strictEqual(ranks[2], 6, 'A{3} A5');
    assert.strictEqual(ranks[3], 7, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 4, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 1, 'A{7} A9');
    assert.strictEqual(ranks[7], 8, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 2, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(topsis(FILTERED, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 3, 'A{2} A4');
    assert.strictEqual(ranks[2], 6, 'A{3} A5');
    assert.strictEqual(ranks[3], 7, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 4, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 1, 'A{7} A9');
    assert.strictEqual(ranks[7], 8, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 2, 'A{9} A12');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// SAW
// ─────────────────────────────────────────────────────────────────────────────

describe('SAW scores — filtered 9-alt subset', () => {

  it('at p=0 (equal weights)', () => {
    const scores = saw(FILTERED, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0], 0.57, 'A{1} A1');
    near(scores[1], 0.65, 'A{2} A4');
    near(scores[2], 0.56, 'A{3} A5');
    near(scores[3], 0.62, 'A{4} A6.2');
    near(scores[4], 0.61, 'A{5} A7');
    near(scores[5], 0.66, 'A{6} A7.3');
    near(scores[6], 0.66, 'A{7} A9');
    near(scores[7], 0.61, 'A{8} A11.2');
    near(scores[8], 0.65, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = saw(FILTERED, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], 0.59, 'A{1} A1');
    near(scores[1], 0.73, 'A{2} A4');
    near(scores[2], 0.61, 'A{3} A5');
    near(scores[3], 0.64, 'A{4} A6.2');
    near(scores[4], 0.68, 'A{5} A7');
    near(scores[5], 0.73, 'A{6} A7.3');
    near(scores[6], 0.74, 'A{7} A9');
    near(scores[7], 0.63, 'A{8} A11.2');
    near(scores[8], 0.73, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const scores = saw(FILTERED, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], 0.59, 'A{1} A1');
    near(scores[1], 0.78, 'A{2} A4');
    near(scores[2], 0.65, 'A{3} A5');
    near(scores[3], 0.65, 'A{4} A6.2');
    near(scores[4], 0.73, 'A{5} A7');
    near(scores[5], 0.78, 'A{6} A7.3');
    near(scores[6], 0.80, 'A{7} A9');
    near(scores[7], 0.64, 'A{8} A11.2');
    near(scores[8], 0.79, 'A{9} A12');
  });

});

describe('SAW rankings — filtered 9-alt subset', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(saw(FILTERED, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 8, 'A{1} A1');
    assert.strictEqual(ranks[1], 4, 'A{2} A4');
    assert.strictEqual(ranks[2], 9, 'A{3} A5');
    assert.strictEqual(ranks[3], 5, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 6, 'A{5} A7');
    assert.strictEqual(ranks[5], 2, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 1, 'A{7} A9');
    assert.strictEqual(ranks[7], 7, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 3, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(saw(FILTERED, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 4, 'A{2} A4');
    assert.strictEqual(ranks[2], 8, 'A{3} A5');
    assert.strictEqual(ranks[3], 6, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 3, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 1, 'A{7} A9');
    assert.strictEqual(ranks[7], 7, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 2, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(saw(FILTERED, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 4, 'A{2} A4');
    assert.strictEqual(ranks[2], 6, 'A{3} A5');
    assert.strictEqual(ranks[3], 7, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 3, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 1, 'A{7} A9');
    assert.strictEqual(ranks[7], 8, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 2, 'A{9} A12');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// MABAC
// ─────────────────────────────────────────────────────────────────────────────

describe('MABAC scores — filtered 9-alt subset', () => {

  it('at p=0 (equal weights)', () => {
    const scores = mabac(FILTERED, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0], -0.11, 'A{1} A1');
    near(scores[1],  0.00, 'A{2} A4');
    near(scores[2], -0.11, 'A{3} A5');
    near(scores[3],  0.15, 'A{4} A6.2');
    near(scores[4],  0.05, 'A{5} A7');
    near(scores[5],  0.27, 'A{6} A7.3');
    near(scores[6],  0.12, 'A{7} A9');
    near(scores[7],  0.11, 'A{8} A11.2');
    near(scores[8],  0.03, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = mabac(FILTERED, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], -0.16, 'A{1} A1');
    near(scores[1],  0.02, 'A{2} A4');
    near(scores[2], -0.12, 'A{3} A5');
    near(scores[3],  0.13, 'A{4} A6.2');
    near(scores[4],  0.06, 'A{5} A7');
    near(scores[5],  0.31, 'A{6} A7.3');
    near(scores[6],  0.15, 'A{7} A9');
    near(scores[7],  0.07, 'A{8} A11.2');
    near(scores[8],  0.05, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const scores = mabac(FILTERED, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], -0.22, 'A{1} A1');
    near(scores[1],  0.02, 'A{2} A4');
    near(scores[2], -0.13, 'A{3} A5');
    near(scores[3],  0.12, 'A{4} A6.2');
    near(scores[4],  0.07, 'A{5} A7');
    near(scores[5],  0.34, 'A{6} A7.3');
    near(scores[6],  0.18, 'A{7} A9');
    near(scores[7],  0.05, 'A{8} A11.2');
    near(scores[8],  0.07, 'A{9} A12');
  });

});

describe('MABAC rankings — filtered 9-alt subset', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(mabac(FILTERED, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 7, 'A{2} A4');
    assert.strictEqual(ranks[2], 8, 'A{3} A5');
    assert.strictEqual(ranks[3], 2, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 1, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 3, 'A{7} A9');
    assert.strictEqual(ranks[7], 4, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 6, 'A{9} A12');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(mabac(FILTERED, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 7, 'A{2} A4');
    assert.strictEqual(ranks[2], 8, 'A{3} A5');
    assert.strictEqual(ranks[3], 3, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 1, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 2, 'A{7} A9');
    assert.strictEqual(ranks[7], 4, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 6, 'A{9} A12');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(mabac(FILTERED, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 9, 'A{1} A1');
    assert.strictEqual(ranks[1], 7, 'A{2} A4');
    assert.strictEqual(ranks[2], 8, 'A{3} A5');
    assert.strictEqual(ranks[3], 3, 'A{4} A6.2');
    assert.strictEqual(ranks[4], 5, 'A{5} A7');
    assert.strictEqual(ranks[5], 1, 'A{6} A7.3');
    assert.strictEqual(ranks[6], 2, 'A{7} A9');
    assert.strictEqual(ranks[7], 6, 'A{8} A11.2');
    assert.strictEqual(ranks[8], 4, 'A{9} A12');
  });

});
