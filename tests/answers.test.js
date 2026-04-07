/**
 * tests/answers.test.js
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

// Prerequisites:
//   npm install pyodide          (Node.js Pyodide runtime)
//   network access to PyPI       (micropip installs pymcdm on first run)

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
    near(scores[0], 0.24, 'A1    status quo');
    near(scores[1], 0.76, 'A4    1b+2');
    near(scores[2], 0.48, 'A5    1p+2');
    near(scores[3], 0.24, 'A6.2  50% bypass');
    near(scores[4], 0.64, 'A7    20% bypass');
    near(scores[5], 0.64, 'A7.3  40% bypass');
    near(scores[6], 0.78, 'A9    full combined');
    near(scores[7], 0.24, 'A11.2 bypass only 50%');
    near(scores[8], 0.76, 'A12   1b+2+3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], 0.17, 'A1    status quo');
    near(scores[1], 0.81, 'A4    1b+2');
    near(scores[2], 0.46, 'A5    1p+2');
    near(scores[3], 0.19, 'A6.2  50% bypass');
    near(scores[4], 0.65, 'A7    20% bypass');
    near(scores[5], 0.66, 'A7.3  40% bypass');
    near(scores[6], 0.84, 'A9    full combined');
    near(scores[7], 0.17, 'A11.2 bypass only 50%');
    near(scores[8], 0.82, 'A12   1b+2+3');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const scores = topsis(MATRIX, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], 0.11, 'A1    status quo');
    near(scores[1], 0.83, 'A4    1b+2');
    near(scores[2], 0.46, 'A5    1p+2');
    near(scores[3], 0.17, 'A6.2  50% bypass');
    near(scores[4], 0.65, 'A7    20% bypass');
    near(scores[5], 0.67, 'A7.3  40% bypass');
    near(scores[6], 0.87, 'A9    full combined');
    near(scores[7], 0.15, 'A11.2 bypass only 50%');
    near(scores[8], 0.84, 'A12   1b+2+3');
  });

});

describe('TOPSIS rankings match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 8, 'A1    should be rank 8');
    assert.strictEqual(ranks[1], 2, 'A4    should be rank 2');
    assert.strictEqual(ranks[2], 6, 'A5    should be rank 6');
    assert.strictEqual(ranks[3], 7, 'A6.2  should be rank 7');
    assert.strictEqual(ranks[4], 5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5], 4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6], 1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 9, 'A11.2 should be rank 9');
    assert.strictEqual(ranks[8], 3, 'A12   should be rank 3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 9, 'A1    should be rank 9');
    assert.strictEqual(ranks[1], 3, 'A4    should be rank 3');
    assert.strictEqual(ranks[2], 6, 'A5    should be rank 6');
    assert.strictEqual(ranks[3], 7, 'A6.2  should be rank 7');
    assert.strictEqual(ranks[4], 5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5], 4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6], 1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 8, 'A11.2 should be rank 8');
    assert.strictEqual(ranks[8], 2, 'A12   should be rank 2');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const ranks = scoreToRank(topsis(MATRIX, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 9, 'A1    should be rank 9');
    assert.strictEqual(ranks[1], 3, 'A4    should be rank 3');
    assert.strictEqual(ranks[2], 6, 'A5    should be rank 6');
    assert.strictEqual(ranks[3], 7, 'A6.2  should be rank 7');
    assert.strictEqual(ranks[4], 5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5], 4, 'A7.3  should be rank 4');
    assert.strictEqual(ranks[6], 1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 8, 'A11.2 should be rank 8');
    assert.strictEqual(ranks[8], 2, 'A12   should be rank 2');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// SAW
// ─────────────────────────────────────────────────────────────────────────────

describe('SAW scores match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 0), TYPES);
    near(scores[0], 0.47, 'A1    status quo');
    near(scores[1], 0.75, 'A4    1b+2');
    near(scores[2], 0.63, 'A5    1p+2');
    near(scores[3], 0.52, 'A6.2  50% bypass');
    near(scores[4], 0.71, 'A7    20% bypass');
    near(scores[5], 0.76, 'A7.3  40% bypass');
    near(scores[6], 0.76, 'A9    full combined');
    near(scores[7], 0.51, 'A11.2 bypass only 50%');
    near(scores[8], 0.75, 'A12   1b+2+3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES);
    near(scores[0], 0.50, 'A1    status quo');
    near(scores[1], 0.81, 'A4    1b+2');
    near(scores[2], 0.68, 'A5    1p+2');
    near(scores[3], 0.55, 'A6.2  50% bypass');
    near(scores[4], 0.77, 'A7    20% bypass');
    near(scores[5], 0.82, 'A7.3  40% bypass');
    near(scores[6], 0.83, 'A9    full combined');
    near(scores[7], 0.54, 'A11.2 bypass only 50%');
    near(scores[8], 0.82, 'A12   1b+2+3');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const scores = saw(MATRIX, rankOrderWeights(RANKS, 1), TYPES);
    near(scores[0], 0.52, 'A1    status quo');
    near(scores[1], 0.85, 'A4    1b+2');
    near(scores[2], 0.71, 'A5    1p+2');
    near(scores[3], 0.58, 'A6.2  50% bypass');
    near(scores[4], 0.80, 'A7    20% bypass');
    near(scores[5], 0.86, 'A7.3  40% bypass');
    near(scores[6], 0.87, 'A9    full combined');
    near(scores[7], 0.56, 'A11.2 bypass only 50%');
    near(scores[8], 0.86, 'A12   1b+2+3');
  });

});

describe('SAW rankings match answers.csv', () => {

  it('at p=0 (equal weights) — all alternatives match', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 0), TYPES));
    assert.strictEqual(ranks[0], 9, 'A1    should be rank 9');
    assert.strictEqual(ranks[1], 4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2], 6, 'A5    should be rank 6');
    assert.strictEqual(ranks[3], 7, 'A6.2  should be rank 7');
    assert.strictEqual(ranks[4], 5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5], 2, 'A7.3  should be rank 2');
    assert.strictEqual(ranks[6], 1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 8, 'A11.2 should be rank 8');
    assert.strictEqual(ranks[8], 3, 'A12   should be rank 3');
  });

  it('at p=0.5 (moderate weights) — all alternatives match', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 0.5), TYPES));
    assert.strictEqual(ranks[0], 9, 'A1    should be rank 9');
    assert.strictEqual(ranks[1], 4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2], 6, 'A5    should be rank 6');
    assert.strictEqual(ranks[3], 7, 'A6.2  should be rank 7');
    assert.strictEqual(ranks[4], 5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5], 3, 'A7.3  should be rank 3');
    assert.strictEqual(ranks[6], 1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 8, 'A11.2 should be rank 8');
    assert.strictEqual(ranks[8], 2, 'A12   should be rank 2');
  });

  it('at p=1 (linear weights) — all alternatives match', () => {
    const ranks = scoreToRank(saw(MATRIX, rankOrderWeights(RANKS, 1), TYPES));
    assert.strictEqual(ranks[0], 9, 'A1    should be rank 9');
    assert.strictEqual(ranks[1], 4, 'A4    should be rank 4');
    assert.strictEqual(ranks[2], 6, 'A5    should be rank 6');
    assert.strictEqual(ranks[3], 7, 'A6.2  should be rank 7');
    assert.strictEqual(ranks[4], 5, 'A7    should be rank 5');
    assert.strictEqual(ranks[5], 3, 'A7.3  should be rank 3');
    assert.strictEqual(ranks[6], 1, 'A9    should be rank 1');
    assert.strictEqual(ranks[7], 8, 'A11.2 should be rank 8');
    assert.strictEqual(ranks[8], 2, 'A12   should be rank 2');
  });

});
