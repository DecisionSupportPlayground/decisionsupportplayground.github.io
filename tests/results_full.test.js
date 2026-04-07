/**
 * tests/results_full.test.js
 *
 * Validates TOPSIS and SAW against planning/MCAM_results.csv.
 *
 * The CSV was produced by pymcdm and contains two result sets:
 *
 *   Left columns  — 9-alternative subset (A{1}–A{9}, same as results_partial.test.js)
 *   Right columns — all 22 alternatives  (A{1}–A{22})
 *
 * This file tests the full 22-alternative run.  Scores are checked to ±0.02
 * (the CSV rounds to 2 d.p.).
 *
 * MATRIX row order (index → real ID):
 *   index 0   A1    Situation as is
 *   index 1   A4    1b+2
 *   index 2   A5    1p+2
 *   index 3   A6.2  3+4  (50 % water diverted)
 *   index 4   A7    1b+2+4  (20 % bypass)
 *   index 5   A7.3  1b+2+4  (40 % bypass)
 *   index 6   A9    1b+2+3+4  (full combined)
 *   index 7   A11.2 bypass only (50 %)
 *   index 8   A12   1b+2+3
 *   index 9   A2    1b
 *   index 10  A3    1p
 *   index 11  A6    3+4  (20 % bypass)
 *   index 12  A6.1  3+4  (30 % bypass)
 *   index 13  A6.3  3+4  (70 % bypass)
 *   index 14  A7.1  1b+2+4  (10 % bypass)
 *   index 15  A7.2  1b+2+4  (25 % bypass)
 *   index 16  A8    1p+2+4
 *   index 17  A10   1p+2+3+4
 *   index 18  A11   bypass only (20 %)
 *   index 19  A11.1 bypass only (30 %)
 *   index 20  A11.3 bypass only (70 %)
 *   index 21  A13   1p+2+3
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
// Source: "Joint Ranking" block in MCAM_results.csv
const RANKS = [9, 2, 3, 5, 6, 10, 7, 8, 1, 4];

const TOL = 0.02; // scores in MCAM_results.csv are rounded to 2 d.p.

function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${label}: expected ≈ ${expected}, got ${actual.toFixed(3)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOPSIS — all 22 alternatives
// ─────────────────────────────────────────────────────────────────────────────

describe('TOPSIS scores — all 22 alternatives — match MCAM_results.csv', () => {

  it('at p=0 (equal weights)', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0],  0.37, 'A1    status quo');
    near(scores[9],  0.32, 'A2    1b');
    near(scores[10], 0.32, 'A3    1p');
    near(scores[1],  0.59, 'A4    1b+2');
    near(scores[2],  0.33, 'A5    1p+2');
    near(scores[11], 0.35, 'A6    20% bypass');
    near(scores[12], 0.36, 'A6.1  30% bypass');
    near(scores[3],  0.37, 'A6.2  50% bypass');
    near(scores[13], 0.42, 'A6.3  70% bypass');
    near(scores[4],  0.43, 'A7    20% bypass');
    near(scores[14], 0.41, 'A7.1  10% bypass');
    near(scores[15], 0.43, 'A7.2  25% bypass');
    near(scores[5],  0.45, 'A7.3  40% bypass');
    near(scores[16], 0.29, 'A8    1p+2+4');
    near(scores[6],  0.60, 'A9    full combined');
    near(scores[17], 0.29, 'A10   1p+2+3+4');
    near(scores[18], 0.35, 'A11   bypass 20%');
    near(scores[19], 0.36, 'A11.1 bypass 30%');
    near(scores[7],  0.36, 'A11.2 bypass only 50%');
    near(scores[20], 0.42, 'A11.3 bypass 70%');
    near(scores[8],  0.59, 'A12   1b+2+3');
    near(scores[21], 0.33, 'A13   1p+2+3');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0],  0.30, 'A1    status quo');
    near(scores[9],  0.32, 'A2    1b');
    near(scores[10], 0.31, 'A3    1p');
    near(scores[1],  0.67, 'A4    1b+2');
    near(scores[2],  0.33, 'A5    1p+2');
    near(scores[11], 0.29, 'A6    20% bypass');
    near(scores[12], 0.30, 'A6.1  30% bypass');
    near(scores[3],  0.30, 'A6.2  50% bypass');
    near(scores[13], 0.34, 'A6.3  70% bypass');
    near(scores[4],  0.49, 'A7    20% bypass');
    near(scores[14], 0.48, 'A7.1  10% bypass');
    near(scores[15], 0.49, 'A7.2  25% bypass');
    near(scores[5],  0.51, 'A7.3  40% bypass');
    near(scores[16], 0.32, 'A8    1p+2+4');
    near(scores[6],  0.68, 'A9    full combined');
    near(scores[17], 0.32, 'A10   1p+2+3+4');
    near(scores[18], 0.29, 'A11   bypass 20%');
    near(scores[19], 0.30, 'A11.1 bypass 30%');
    near(scores[7],  0.30, 'A11.2 bypass only 50%');
    near(scores[20], 0.33, 'A11.3 bypass 70%');
    near(scores[8],  0.67, 'A12   1b+2+3');
    near(scores[21], 0.33, 'A13   1p+2+3');
  });

  it('at p=1 (linear weights)', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0],  0.23, 'A1    status quo');
    near(scores[9],  0.35, 'A2    1b');
    near(scores[10], 0.33, 'A3    1p');
    near(scores[1],  0.73, 'A4    1b+2');
    near(scores[2],  0.34, 'A5    1p+2');
    near(scores[11], 0.23, 'A6    20% bypass');
    near(scores[12], 0.24, 'A6.1  30% bypass');
    near(scores[3],  0.25, 'A6.2  50% bypass');
    near(scores[13], 0.28, 'A6.3  70% bypass');
    near(scores[4],  0.54, 'A7    20% bypass');
    near(scores[14], 0.53, 'A7.1  10% bypass');
    near(scores[15], 0.54, 'A7.2  25% bypass');
    near(scores[5],  0.55, 'A7.3  40% bypass');
    near(scores[16], 0.34, 'A8    1p+2+4');
    near(scores[6],  0.74, 'A9    full combined');
    near(scores[17], 0.35, 'A10   1p+2+3+4');
    near(scores[18], 0.23, 'A11   bypass 20%');
    near(scores[19], 0.24, 'A11.1 bypass 30%');
    near(scores[7],  0.24, 'A11.2 bypass only 50%');
    near(scores[20], 0.27, 'A11.3 bypass 70%');
    near(scores[8],  0.73, 'A12   1b+2+3');
    near(scores[21], 0.35, 'A13   1p+2+3');
  });

});

describe('TOPSIS rankings — all 22 alternatives — match MCAM_results.csv', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0],  10, 'A1    should be rank 10');
    assert.strictEqual(ranks[9],  19, 'A2    should be rank 19');
    assert.strictEqual(ranks[10], 20, 'A3    should be rank 20');
    assert.strictEqual(ranks[1],   2, 'A4    should be rank 2');
    assert.strictEqual(ranks[2],  17, 'A5    should be rank 17');
    assert.strictEqual(ranks[11], 15, 'A6    should be rank 15');
    assert.strictEqual(ranks[12], 13, 'A6.1  should be rank 13');
    assert.strictEqual(ranks[3],  11, 'A6.2  should be rank 11');
    assert.strictEqual(ranks[13],  7, 'A6.3  should be rank 7');
    assert.strictEqual(ranks[4],   5, 'A7    should be rank 5');
    assert.strictEqual(ranks[14],  9, 'A7.1  should be rank 9');
    assert.strictEqual(ranks[15],  6, 'A7.2  should be rank 6');
    assert.strictEqual(ranks[5],   4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[16], 22, 'A8    should be rank 22');
    assert.strictEqual(ranks[6],   1, 'A9    should be rank 1');
    assert.strictEqual(ranks[17], 21, 'A10   should be rank 21');
    assert.strictEqual(ranks[18], 16, 'A11   should be rank 16');
    assert.strictEqual(ranks[19], 14, 'A11.1 should be rank 14');
    assert.strictEqual(ranks[7],  12, 'A11.2 should be rank 12');
    assert.strictEqual(ranks[20],  8, 'A11.3 should be rank 8');
    assert.strictEqual(ranks[8],   3, 'A12   should be rank 3');
    assert.strictEqual(ranks[21], 18, 'A13   should be rank 18');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0],  17, 'A1    should be rank 17');
    assert.strictEqual(ranks[9],  12, 'A2    should be rank 12');
    assert.strictEqual(ranks[10], 15, 'A3    should be rank 15');
    assert.strictEqual(ranks[1],   3, 'A4    should be rank 3');
    assert.strictEqual(ranks[2],  11, 'A5    should be rank 11');
    assert.strictEqual(ranks[11], 21, 'A6    should be rank 21');
    assert.strictEqual(ranks[12], 18, 'A6.1  should be rank 18');
    assert.strictEqual(ranks[3],  16, 'A6.2  should be rank 16');
    assert.strictEqual(ranks[13],  8, 'A6.3  should be rank 8');
    assert.strictEqual(ranks[4],   5, 'A7    should be rank 5');
    assert.strictEqual(ranks[14],  7, 'A7.1  should be rank 7');
    assert.strictEqual(ranks[15],  6, 'A7.2  should be rank 6');
    assert.strictEqual(ranks[5],   4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[16], 14, 'A8    should be rank 14');
    assert.strictEqual(ranks[6],   1, 'A9    should be rank 1');
    assert.strictEqual(ranks[17], 13, 'A10   should be rank 13');
    assert.strictEqual(ranks[18], 22, 'A11   should be rank 22');
    assert.strictEqual(ranks[19], 20, 'A11.1 should be rank 20');
    assert.strictEqual(ranks[7],  19, 'A11.2 should be rank 19');
    assert.strictEqual(ranks[20],  9, 'A11.3 should be rank 9');
    assert.strictEqual(ranks[8],   2, 'A12   should be rank 2');
    assert.strictEqual(ranks[21], 10, 'A13   should be rank 10');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0],  20, 'A1    should be rank 20');
    assert.strictEqual(ranks[9],  10, 'A2    should be rank 10');
    assert.strictEqual(ranks[10], 13, 'A3    should be rank 13');
    assert.strictEqual(ranks[1],   3, 'A4    should be rank 3');
    assert.strictEqual(ranks[2],  11, 'A5    should be rank 11');
    assert.strictEqual(ranks[11], 21, 'A6    should be rank 21');
    assert.strictEqual(ranks[12], 18, 'A6.1  should be rank 18');
    assert.strictEqual(ranks[3],  16, 'A6.2  should be rank 16');
    assert.strictEqual(ranks[13], 14, 'A6.3  should be rank 14');
    assert.strictEqual(ranks[4],   6, 'A7    should be rank 6');
    assert.strictEqual(ranks[14],  7, 'A7.1  should be rank 7');
    assert.strictEqual(ranks[15],  5, 'A7.2  should be rank 5');
    assert.strictEqual(ranks[5],   4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[16], 12, 'A8    should be rank 12');
    assert.strictEqual(ranks[6],   1, 'A9    should be rank 1');
    assert.strictEqual(ranks[17],  9, 'A10   should be rank 9');
    assert.strictEqual(ranks[18], 22, 'A11   should be rank 22');
    assert.strictEqual(ranks[19], 19, 'A11.1 should be rank 19');
    assert.strictEqual(ranks[7],  17, 'A11.2 should be rank 17');
    assert.strictEqual(ranks[20], 15, 'A11.3 should be rank 15');
    assert.strictEqual(ranks[8],   2, 'A12   should be rank 2');
    assert.strictEqual(ranks[21],  8, 'A13   should be rank 8');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// SAW — all 22 alternatives
// ─────────────────────────────────────────────────────────────────────────────

describe('SAW scores — all 22 alternatives — match MCAM_results.csv', () => {

  it('at p=0 (equal weights)', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0],  0.56, 'A1    status quo');
    near(scores[9],  0.55, 'A2    1b');
    near(scores[10], 0.55, 'A3    1p');
    near(scores[1],  0.64, 'A4    1b+2');
    near(scores[2],  0.55, 'A5    1p+2');
    near(scores[11], 0.58, 'A6    20% bypass');
    near(scores[12], 0.61, 'A6.1  30% bypass');
    near(scores[3],  0.61, 'A6.2  50% bypass');
    near(scores[13], 0.71, 'A6.3  70% bypass');
    near(scores[4],  0.60, 'A7    20% bypass');
    near(scores[14], 0.57, 'A7.1  10% bypass');
    near(scores[15], 0.59, 'A7.2  25% bypass');
    near(scores[5],  0.65, 'A7.3  40% bypass');
    near(scores[16], 0.56, 'A8    1p+2+4');
    near(scores[6],  0.66, 'A9    full combined');
    near(scores[17], 0.57, 'A10   1p+2+3+4');
    near(scores[18], 0.57, 'A11   bypass 20%');
    near(scores[19], 0.60, 'A11.1 bypass 30%');
    near(scores[7],  0.60, 'A11.2 bypass only 50%');
    near(scores[20], 0.70, 'A11.3 bypass 70%');
    near(scores[8],  0.65, 'A12   1b+2+3');
    near(scores[21], 0.56, 'A13   1p+2+3');
  });

  it('at p=0.5 (moderate weights)', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0],  0.58, 'A1    status quo');
    near(scores[9],  0.60, 'A2    1b');
    near(scores[10], 0.60, 'A3    1p');
    near(scores[1],  0.72, 'A4    1b+2');
    near(scores[2],  0.61, 'A5    1p+2');
    near(scores[11], 0.60, 'A6    20% bypass');
    near(scores[12], 0.63, 'A6.1  30% bypass');
    near(scores[3],  0.63, 'A6.2  50% bypass');
    near(scores[13], 0.71, 'A6.3  70% bypass');
    near(scores[4],  0.67, 'A7    20% bypass');
    near(scores[14], 0.65, 'A7.1  10% bypass');
    near(scores[15], 0.66, 'A7.2  25% bypass');
    near(scores[5],  0.72, 'A7.3  40% bypass');
    near(scores[16], 0.62, 'A8    1p+2+4');
    near(scores[6],  0.73, 'A9    full combined');
    near(scores[17], 0.63, 'A10   1p+2+3+4');
    near(scores[18], 0.59, 'A11   bypass 20%');
    near(scores[19], 0.62, 'A11.1 bypass 30%');
    near(scores[7],  0.62, 'A11.2 bypass only 50%');
    near(scores[20], 0.70, 'A11.3 bypass 70%');
    near(scores[8],  0.72, 'A12   1b+2+3');
    near(scores[21], 0.61, 'A13   1p+2+3');
  });

  it('at p=1 (linear weights)', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0],  0.58, 'A1    status quo');
    near(scores[9],  0.64, 'A2    1b');
    near(scores[10], 0.64, 'A3    1p');
    near(scores[1],  0.77, 'A4    1b+2');
    near(scores[2],  0.64, 'A5    1p+2');
    near(scores[11], 0.61, 'A6    20% bypass');
    near(scores[12], 0.63, 'A6.1  30% bypass');
    near(scores[3],  0.64, 'A6.2  50% bypass');
    near(scores[13], 0.70, 'A6.3  70% bypass');
    near(scores[4],  0.72, 'A7    20% bypass');
    near(scores[14], 0.71, 'A7.1  10% bypass');
    near(scores[15], 0.72, 'A7.2  25% bypass');
    near(scores[5],  0.77, 'A7.3  40% bypass');
    near(scores[16], 0.66, 'A8    1p+2+4');
    near(scores[6],  0.79, 'A9    full combined');
    near(scores[17], 0.67, 'A10   1p+2+3+4');
    near(scores[18], 0.60, 'A11   bypass 20%');
    near(scores[19], 0.62, 'A11.1 bypass 30%');
    near(scores[7],  0.62, 'A11.2 bypass only 50%');
    near(scores[20], 0.69, 'A11.3 bypass 70%');
    near(scores[8],  0.77, 'A12   1b+2+3');
    near(scores[21], 0.65, 'A13   1p+2+3');
  });

});

describe('SAW rankings — all 22 alternatives — match MCAM_results.csv', () => {

  it('at p=0 (equal weights)', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0],  17, 'A1    should be rank 17');
    assert.strictEqual(ranks[9],  22, 'A2    should be rank 22');
    assert.strictEqual(ranks[10], 21, 'A3    should be rank 21');
    assert.strictEqual(ranks[1],   6, 'A4    should be rank 6');
    assert.strictEqual(ranks[2],  20, 'A5    should be rank 20');
    assert.strictEqual(ranks[11], 13, 'A6    should be rank 13');
    assert.strictEqual(ranks[12],  7, 'A6.1  should be rank 7');
    assert.strictEqual(ranks[3],   8, 'A6.2  should be rank 8');
    assert.strictEqual(ranks[13],  1, 'A6.3  should be rank 1');
    assert.strictEqual(ranks[4],   9, 'A7    should be rank 9');
    assert.strictEqual(ranks[14], 16, 'A7.1  should be rank 16');
    assert.strictEqual(ranks[15], 12, 'A7.2  should be rank 12');
    assert.strictEqual(ranks[5],   4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[16], 18, 'A8    should be rank 18');
    assert.strictEqual(ranks[6],   3, 'A9    should be rank 3');
    assert.strictEqual(ranks[17], 15, 'A10   should be rank 15');
    assert.strictEqual(ranks[18], 14, 'A11   should be rank 14');
    assert.strictEqual(ranks[19], 10, 'A11.1 should be rank 10');
    assert.strictEqual(ranks[7],  11, 'A11.2 should be rank 11');
    assert.strictEqual(ranks[20],  2, 'A11.3 should be rank 2');
    assert.strictEqual(ranks[8],   5, 'A12   should be rank 5');
    assert.strictEqual(ranks[21], 19, 'A13   should be rank 19');
  });

  it('at p=0.5 (moderate weights)', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0],  22, 'A1    should be rank 22');
    assert.strictEqual(ranks[9],  18, 'A2    should be rank 18');
    assert.strictEqual(ranks[10], 20, 'A3    should be rank 20');
    assert.strictEqual(ranks[1],   4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2],  17, 'A5    should be rank 17');
    assert.strictEqual(ranks[11], 19, 'A6    should be rank 19');
    assert.strictEqual(ranks[12], 10, 'A6.1  should be rank 10');
    assert.strictEqual(ranks[3],  11, 'A6.2  should be rank 11');
    assert.strictEqual(ranks[13],  5, 'A6.3  should be rank 5');
    assert.strictEqual(ranks[4],   7, 'A7    should be rank 7');
    assert.strictEqual(ranks[14],  9, 'A7.1  should be rank 9');
    assert.strictEqual(ranks[15],  8, 'A7.2  should be rank 8');
    assert.strictEqual(ranks[5],   3, 'A7.3  should be rank 3');
    assert.strictEqual(ranks[16], 13, 'A8    should be rank 13');
    assert.strictEqual(ranks[6],   1, 'A9    should be rank 1');
    assert.strictEqual(ranks[17], 12, 'A10   should be rank 12');
    assert.strictEqual(ranks[18], 21, 'A11   should be rank 21');
    assert.strictEqual(ranks[19], 14, 'A11.1 should be rank 14');
    assert.strictEqual(ranks[7],  15, 'A11.2 should be rank 15');
    assert.strictEqual(ranks[20],  6, 'A11.3 should be rank 6');
    assert.strictEqual(ranks[8],   2, 'A12   should be rank 2');
    assert.strictEqual(ranks[21], 16, 'A13   should be rank 16');
  });

  it('at p=1 (linear weights)', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0],  22, 'A1    should be rank 22');
    assert.strictEqual(ranks[9],  13, 'A2    should be rank 13');
    assert.strictEqual(ranks[10], 15, 'A3    should be rank 15');
    assert.strictEqual(ranks[1],   4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2],  14, 'A5    should be rank 14');
    assert.strictEqual(ranks[11], 20, 'A6    should be rank 20');
    assert.strictEqual(ranks[12], 17, 'A6.1  should be rank 17');
    assert.strictEqual(ranks[3],  16, 'A6.2  should be rank 16');
    assert.strictEqual(ranks[13],  8, 'A6.3  should be rank 8');
    assert.strictEqual(ranks[4],   5, 'A7    should be rank 5');
    assert.strictEqual(ranks[14],  7, 'A7.1  should be rank 7');
    assert.strictEqual(ranks[15],  6, 'A7.2  should be rank 6');
    assert.strictEqual(ranks[5],   3, 'A7.3  should be rank 3');
    assert.strictEqual(ranks[16], 11, 'A8    should be rank 11');
    assert.strictEqual(ranks[6],   1, 'A9    should be rank 1');
    assert.strictEqual(ranks[17], 10, 'A10   should be rank 10');
    assert.strictEqual(ranks[18], 21, 'A11   should be rank 21');
    assert.strictEqual(ranks[19], 19, 'A11.1 should be rank 19');
    assert.strictEqual(ranks[7],  18, 'A11.2 should be rank 18');
    assert.strictEqual(ranks[20],  9, 'A11.3 should be rank 9');
    assert.strictEqual(ranks[8],   2, 'A12   should be rank 2');
    assert.strictEqual(ranks[21], 12, 'A13   should be rank 12');
  });

});
