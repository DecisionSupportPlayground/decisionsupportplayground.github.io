/**
 * tests/results_partial.test.js
 *
 * Validates TOPSIS and SAW against planning/answers.csv.
 *
 * The Python script (Upper_lower_script.py / pymcdm) was run on a
 * 9-alternative subset of DATA_SelectedIndicators&Alternatives.csv using
 * the joint criteria ranking recorded in answers.csv.  Each test below
 * checks that our JS implementation reproduces those published scores to
 * within ±0.02 (answers.csv rounds to 2 d.p.).
 *
 * Alternatives (A{1}–A{9} labels from answers.csv → real IDs):
 *   index 0  A1    Situation as is
 *   index 1  A4    1b+2
 *   index 2  A5    1p+2
 *   index 3  A6.2  3+4  (50 % water diverted)
 *   index 4  A7    1b+2+4  (20 % bypass)
 *   index 5  A7.3  1b+2+4  (40 % bypass)
 *   index 6  A9    1b+2+3+4  (full combined)
 *   index 7  A11.2 bypass only (50 %)
 *   index 8  A12   1b+2+3
 *
 * Criteria (I1–I10 in original sheet order):
 *   I1  Bird Habitat Index          benefit   joint rank 9
 *   I2  Overall Energy Generation   benefit   joint rank 2
 *   I3  Nav. Big Vessels            benefit   joint rank 3
 *   I4  Nav. Medium Vessels         benefit   joint rank 5
 *   I5  Nav. Small Vessels          benefit   joint rank 6
 *   I6  Evaporation Downstream      cost      joint rank 10
 *   I7  Evaporation Upstream        cost      joint rank 7
 *   I8  Wetland Evaporation         cost      joint rank 8
 *   I9  Food Production Downstream  benefit   joint rank 1
 *   I10 Food Production Upstream    benefit   joint rank 4
 */


import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';

import { initMCDM, topsis, saw, rankOrderWeights, scoreToRank } from '../js/mcdm.js';

before(async () => { await initMCDM(); });

// ─────────────────────────────────────────────────────────────────────────────
// Input data — sourced from DATA_SelectedIndicators&Alternatives.csv
// ─────────────────────────────────────────────────────────────────────────────

const MATRIX = [
  //  I1       I2          I3    I4    I5      I6       I7      I8       I9         I10
  [0.600,  2394.758,  236,  316,  347, 21.193, 0.000, 20.610, 6400109,       0],  // A1
  [0.600, 10440.646,  246,  317,  344, 21.188, 0.579, 20.610, 6400109, 1028062],  // A4
  [0.600, 10053.412,  233,  315,  344, 21.186, 0.508, 20.610, 6400109,   64833],  // A5
  [0.273,  2394.758,  285,  342,  257, 12.370, 0.000, 12.050, 7943622,       0],  // A6.2
  [0.390, 10705.428,  271,  331,  347, 17.674, 0.587, 17.674, 6400109,  507389],  // A7
  [0.270, 10705.428,  295,  350,  365, 14.140, 0.587, 14.139, 7488127,  507389],  // A7.3
  [0.390, 10440.646,  267,  330,  347, 17.667, 0.579, 17.667, 6907498, 1028062],  // A9
  [0.270,  2394.758,  285,  342,  257, 12.374, 0.000, 12.374, 7360125,       0],  // A11.2
  [0.600, 10440.646,  246,  316,  343, 21.183, 0.579, 21.183, 6907498, 1028062],  // A12
  [0.600, 10739.871,  251,  318,  344, 21.190, 0.588, 20.610, 6400109,       0],  // A2
  [0.600, 10149.887,  233,  315,  344, 21.186, 0.510, 20.610, 6400109,       0],  // A3
  [0.390,  2394.758,  259,  328,  347, 17.671, 0.000, 17.213, 6907498,       0],  // A6
  [0.312,  2394.758,  270,  335,  352, 14.140, 0.000, 13.770, 7252873,       0],  // A6.1
  [0.195,  2394.758,  295,  350,  365,  5.300, 0.000,  5.163, 8634372,       0],  // A6.3
  [0.350, 10705.428,  270,  335,  352, 21.200, 0.587, 21.208, 6592112,  507389],  // A7.1
  [0.310, 10705.428,  285,  342,  257, 16.780, 0.587, 16.790, 7040120,  507389],  // A7.2
  [0.390, 10053.412,  259,  328,  347, 17.670, 0.508, 17.670, 6400109,   64833],  // A8
  [0.390, 10053.412,  258,  328,  347, 17.664, 0.508, 17.664, 6907498,   64833],  // A10
  [0.390,  2394.758,  261,  328,  347, 17.677, 0.000, 17.677, 6400109,       0],  // A11
  [0.312,  2394.758,  270,  335,  352, 14.141, 0.000, 14.141, 6720114,       0],  // A11.1
  [0.210,  2394.758,  295,  350,  365,  5.300, 0.000,  5.300, 8000136,       0],  // A11.3
  [0.600, 10053.412,  233,  315,  343, 21.180, 0.508, 21.180, 6907498,   64833],  // A13
];

// benefit = +1, cost = -1
const TYPES = [1, 1, 1, 1, 1, -1, -1, -1, 1, 1];

// Criteria ranks in the same column order as MATRIX (I1 … I10)
// Source: "Joint Ranking" block in answers.csv
const RANKS = [9, 2, 3, 5, 6, 10, 7, 8, 1, 4];

const TOL = 0.02; // scores in answers.csv are rounded to 2 d.p.

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${label}: expected ≈ ${expected}, got ${actual.toFixed(3)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOPSIS
// ─────────────────────────────────────────────────────────────────────────────

describe('TOPSIS scores match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0], 0.37, 'A1    status quo');
    near(scores[1], 0.59, 'A4    1b+2');
    near(scores[2], 0.33, 'A5    1p+2');
    near(scores[3], 0.37, 'A6.2  50% bypass');
    near(scores[4], 0.43, 'A7    20% bypass');
    near(scores[5], 0.45, 'A7.3  40% bypass');
    near(scores[6], 0.60, 'A9    full combined');
    near(scores[7], 0.36, 'A11.2 bypass only 50%');
    near(scores[8], 0.59, 'A12   1b+2+3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], 0.30, 'A1    status quo');
    near(scores[1], 0.67, 'A4    1b+2');
    near(scores[2], 0.33, 'A5    1p+2');
    near(scores[3], 0.30, 'A6.2  50% bypass');
    near(scores[4], 0.49, 'A7    20% bypass');
    near(scores[5], 0.51, 'A7.3  40% bypass');
    near(scores[6], 0.68, 'A9    full combined');
    near(scores[7], 0.30, 'A11.2 bypass only 50%');
    near(scores[8], 0.67, 'A12   1b+2+3');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], 0.23, 'A1    status quo');
    near(scores[1], 0.73, 'A4    1b+2');
    near(scores[2], 0.34, 'A5    1p+2');
    near(scores[3], 0.25, 'A6.2  50% bypass');
    near(scores[4], 0.54, 'A7    20% bypass');
    near(scores[5], 0.55, 'A7.3  40% bypass');
    near(scores[6], 0.74, 'A9    full combined');
    near(scores[7], 0.24, 'A11.2 bypass only 50%');
    near(scores[8], 0.73, 'A12   1b+2+3');
  });

});

describe('TOPSIS rankings match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 10, 'A1    should be rank 10');
    assert.strictEqual(ranks[1],  2, 'A4    should be rank 2');
    assert.strictEqual(ranks[2], 17, 'A5    should be rank 17');
    assert.strictEqual(ranks[3], 11, 'A6.2  should be rank 11');
    assert.strictEqual(ranks[4],  5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5],  4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6],  1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 12, 'A11.2 should be rank 12');
    assert.strictEqual(ranks[8],  3, 'A12   should be rank 3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 17, 'A1    should be rank 17');
    assert.strictEqual(ranks[1],  3, 'A4    should be rank 3');
    assert.strictEqual(ranks[2], 11, 'A5    should be rank 11');
    assert.strictEqual(ranks[3], 16, 'A6.2  should be rank 16');
    assert.strictEqual(ranks[4],  5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5],  4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6],  1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 19, 'A11.2 should be rank 19');
    assert.strictEqual(ranks[8],  2, 'A12   should be rank 2');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 20, 'A1    should be rank 20');
    assert.strictEqual(ranks[1],  3, 'A4    should be rank 3');
    assert.strictEqual(ranks[2], 11, 'A5    should be rank 11');
    assert.strictEqual(ranks[3], 16, 'A6.2  should be rank 16');
    assert.strictEqual(ranks[4],  6, 'A7    should be rank 6');
    assert.strictEqual(ranks[5],  4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6],  1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 17, 'A11.2 should be rank 17');
    assert.strictEqual(ranks[8],  2, 'A12   should be rank 2');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// SAW
// ─────────────────────────────────────────────────────────────────────────────

describe('SAW scores match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0], 0.56, 'A1    status quo');
    near(scores[1], 0.64, 'A4    1b+2');
    near(scores[2], 0.55, 'A5    1p+2');
    near(scores[3], 0.61, 'A6.2  50% bypass');
    near(scores[4], 0.60, 'A7    20% bypass');
    near(scores[5], 0.65, 'A7.3  40% bypass');
    near(scores[6], 0.66, 'A9    full combined');
    near(scores[7], 0.60, 'A11.2 bypass only 50%');
    near(scores[8], 0.65, 'A12   1b+2+3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], 0.58, 'A1    status quo');
    near(scores[1], 0.72, 'A4    1b+2');
    near(scores[2], 0.61, 'A5    1p+2');
    near(scores[3], 0.63, 'A6.2  50% bypass');
    near(scores[4], 0.67, 'A7    20% bypass');
    near(scores[5], 0.72, 'A7.3  40% bypass');
    near(scores[6], 0.73, 'A9    full combined');
    near(scores[7], 0.62, 'A11.2 bypass only 50%');
    near(scores[8], 0.72, 'A12   1b+2+3');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], 0.58, 'A1    status quo');
    near(scores[1], 0.77, 'A4    1b+2');
    near(scores[2], 0.64, 'A5    1p+2');
    near(scores[3], 0.64, 'A6.2  50% bypass');
    near(scores[4], 0.72, 'A7    20% bypass');
    near(scores[5], 0.77, 'A7.3  40% bypass');
    near(scores[6], 0.79, 'A9    full combined');
    near(scores[7], 0.62, 'A11.2 bypass only 50%');
    near(scores[8], 0.77, 'A12   1b+2+3');
  });

});

describe('SAW rankings match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 17, 'A1    should be rank 17');
    assert.strictEqual(ranks[1],  6, 'A4    should be rank 6');
    assert.strictEqual(ranks[2], 20, 'A5    should be rank 20');
    assert.strictEqual(ranks[3],  8, 'A6.2  should be rank 8');
    assert.strictEqual(ranks[4],  9, 'A7    should be rank 9');
    assert.strictEqual(ranks[5],  4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6],  3, 'A9    should be rank 3');
    assert.strictEqual(ranks[7], 11, 'A11.2 should be rank 11');
    assert.strictEqual(ranks[8],  5, 'A12   should be rank 5');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 22, 'A1    should be rank 22');
    assert.strictEqual(ranks[1],  4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2], 17, 'A5    should be rank 17');
    assert.strictEqual(ranks[3], 11, 'A6.2  should be rank 11');
    assert.strictEqual(ranks[4],  7, 'A7    should be rank 7');
    assert.strictEqual(ranks[5],  3, 'A7.3  should be rank 3');
    assert.strictEqual(ranks[6],  1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 15, 'A11.2 should be rank 15');
    assert.strictEqual(ranks[8],  2, 'A12   should be rank 2');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 22, 'A1    should be rank 22');
    assert.strictEqual(ranks[1],  4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2], 14, 'A5    should be rank 14');
    assert.strictEqual(ranks[3], 16, 'A6.2  should be rank 16');
    assert.strictEqual(ranks[4],  5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5],  3, 'A7.3  should be rank 3');
    assert.strictEqual(ranks[6],  1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 18, 'A11.2 should be rank 18');
    assert.strictEqual(ranks[8],  2, 'A12   should be rank 2');
  });

});


