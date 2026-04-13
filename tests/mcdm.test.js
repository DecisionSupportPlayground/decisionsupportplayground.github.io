/**
 * tests/mcdm.test.js
 *
 * Unit tests for the MCDM business logic in js/mcdm.js.
 * Run with:  npm test
 *
 * Test data is drawn from the class example (planning/sample_data.csv):
 *   Alternatives: A1, A2, A3
 *   Criteria:     discharge(+), cost(-), wetlands(-), forest(-), social(+)
 *   Values:       see MATRIX below
 *
 * The expected results for SAW and TOPSIS (equal weights) are taken from the
 * class exercise PDF (Part II, section 2.2):
 *   SAW ranking:    A2 > A3 > A1   (scores ≈ 0.57 / 0.43 / 0.34)
 *   TOPSIS ranking: A2 > A3 > A1   (scores ≈ 0.74 / 0.47 / 0.35)
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';

import {
  initMCDM,
  rankOrderWeights,
  saw,
  topsis,
  mabac,
  aras,
  scoreToRank,
  runMethod,
  METHODS
} from '../js/mcdm.js';

before(async () => { await initMCDM(); });

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

// Rows = alternatives [A1, A2, A3], cols = criteria
const MATRIX = [
  [2.5, 50,  500,  0.7, 0.17], // A1
  [3,   60,  850,  0.2, 0.83], // A2
  [4,   80, 1000,  0.3, 0.50]  // A3
];

// +1 = benefit (more is better), -1 = cost (less is better)
const TYPES = [1, -1, -1, -1, 1];

const EQUAL_WEIGHTS = [0.2, 0.2, 0.2, 0.2, 0.2];

// ─────────────────────────────────────────────────────────────────────────────
// rankOrderWeights
// ─────────────────────────────────────────────────────────────────────────────

describe('rankOrderWeights', () => {
  it('p=0 → equal weights regardless of ranks', () => {
    const w = rankOrderWeights([1, 2, 3, 4, 5], 0);
    w.forEach(wi => assert.ok(Math.abs(wi - 0.2) < 1e-10, `Expected 0.2, got ${wi}`));
  });

  it('weights sum to 1 for any p', () => {
    for (const p of [0, 0.5, 1, 2]) {
      const w   = rankOrderWeights([3, 1, 2], p);
      const sum = w.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - 1) < 1e-10, `Sum ${sum} ≠ 1 for p=${p}`);
    }
  });

  it('p=1 → rank-1 criterion gets the highest weight', () => {
    const ranks = [1, 2, 3];     // criterion 0 is most important
    const w = rankOrderWeights(ranks, 1);
    assert.ok(w[0] > w[1] && w[1] > w[2], 'Weights should decrease with rank');
  });

  it('p=1 with n=3 → weights are 3/6, 2/6, 1/6', () => {
    const w = rankOrderWeights([1, 2, 3], 1);
    assert.ok(Math.abs(w[0] - 3 / 6) < 1e-10);
    assert.ok(Math.abs(w[1] - 2 / 6) < 1e-10);
    assert.ok(Math.abs(w[2] - 1 / 6) < 1e-10);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(rankOrderWeights([], 1), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SAW
// ─────────────────────────────────────────────────────────────────────────────

describe('saw', () => {
  it('produces scores with correct ranking A2 > A3 > A1 (equal weights)', () => {
    const scores = saw(MATRIX, EQUAL_WEIGHTS, TYPES);
    assert.ok(scores[1] > scores[2] && scores[2] > scores[0],
      `Scores: ${scores.map(s => s.toFixed(3)).join(', ')}`);
  });

  it('scores are in [0, 1]', () => {
    const scores = saw(MATRIX, EQUAL_WEIGHTS, TYPES);
    scores.forEach(s => {
      assert.ok(s >= 0 && s <= 1 + 1e-9, `Score out of range: ${s}`);
    });
  });

  it('A2 score ≈ 0.57 (class exercise reference, max_normalization)', () => {
    const scores = saw(MATRIX, EQUAL_WEIGHTS, TYPES);
    assert.ok(Math.abs(scores[1] - 0.57) < 0.02,
      `Expected ≈ 0.57, got ${scores[1].toFixed(3)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TOPSIS
// ─────────────────────────────────────────────────────────────────────────────

describe('topsis', () => {
  it('produces correct ranking A2 > A3 > A1 (equal weights)', () => {
    const scores = topsis(MATRIX, EQUAL_WEIGHTS, TYPES);
    assert.ok(scores[1] > scores[2] && scores[2] > scores[0],
      `Scores: ${scores.map(s => s.toFixed(3)).join(', ')}`);
  });

  it('scores are in [0, 1]', () => {
    const scores = topsis(MATRIX, EQUAL_WEIGHTS, TYPES);
    scores.forEach(s => assert.ok(s >= 0 && s <= 1 + 1e-9));
  });

  it('A2 score ≈ 0.74 (class exercise reference)', () => {
    const scores = topsis(MATRIX, EQUAL_WEIGHTS, TYPES);
    assert.ok(Math.abs(scores[1] - 0.74) < 0.03,
      `Expected ≈ 0.74, got ${scores[1].toFixed(3)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MABAC
// ─────────────────────────────────────────────────────────────────────────────

describe('mabac', () => {
  it('produces the same ranking as SAW on the sample data (A2 > A3 > A1)', () => {
    const scores = mabac(MATRIX, EQUAL_WEIGHTS, TYPES);
    assert.ok(scores[1] > scores[2] && scores[2] > scores[0],
      `Scores: ${scores.map(s => s.toFixed(4)).join(', ')}`);
  });

  it('returns one score per alternative', () => {
    const scores = mabac(MATRIX, EQUAL_WEIGHTS, TYPES);
    assert.strictEqual(scores.length, MATRIX.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARAS
// ─────────────────────────────────────────────────────────────────────────────

describe('aras', () => {
  it('scores are in [0, 1]', () => {
    const scores = aras(MATRIX, EQUAL_WEIGHTS, TYPES);
    scores.forEach(s => assert.ok(s >= 0 && s <= 1 + 1e-9, `Score out of range: ${s}`));
  });

  it('best alternative has the highest score', () => {
    const scores = aras(MATRIX, EQUAL_WEIGHTS, TYPES);
    const ranks  = scoreToRank(scores);
    // A2 should be ranked 1
    assert.strictEqual(ranks[1], 1, `Expected A2 at rank 1, got ${ranks.join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreToRank
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreToRank', () => {
  it('highest score gets rank 1', () => {
    const ranks = scoreToRank([0.4, 0.7, 0.6]);
    assert.strictEqual(ranks[1], 1);
    assert.strictEqual(ranks[2], 2);
    assert.strictEqual(ranks[0], 3);
  });

  it('ties share the same rank (dense ranking)', () => {
    const ranks = scoreToRank([0.9, 0.7, 0.7]);
    assert.strictEqual(ranks[0], 1);
    assert.strictEqual(ranks[1], 2);
    assert.strictEqual(ranks[2], 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runMethod dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe('runMethod', () => {
  it('dispatches to the correct method', () => {
    const sawDirect = saw(MATRIX, EQUAL_WEIGHTS, TYPES);
    const sawVia    = runMethod('saw', MATRIX, EQUAL_WEIGHTS, TYPES);
    sawDirect.forEach((v, i) => assert.ok(Math.abs(v - sawVia[i]) < 1e-10));
  });

  it('throws for unknown method names', () => {
    assert.throws(
      () => runMethod('unknown', MATRIX, EQUAL_WEIGHTS, TYPES),
      /Unknown MCDM method/
    );
  });

  it('METHODS object contains all 13 methods with fn, label, description', () => {
    ['saw', 'topsis', 'mabac', 'aras', 'vikor', 'codas', 'copras', 'edas', 'mairca', 'marcos', 'moora', 'waspas', 'cocoso'].forEach(name => {
      assert.ok(typeof METHODS[name]?.fn === 'function', `Missing fn for: ${name}`);
      assert.ok(typeof METHODS[name]?.label === 'string', `Missing label for: ${name}`);
      assert.ok(typeof METHODS[name]?.description === 'string', `Missing description for: ${name}`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: rank-order weights + SAW
// ─────────────────────────────────────────────────────────────────────────────

describe('rankOrderWeights + SAW integration', () => {
  it('p=0 (equal weights) gives same result as hardcoded equal weights', () => {
    // Ranks: criterion order [1,2,3,4,5] → top priority = col 0
    const ranks = [1, 2, 3, 4, 5];
    const w     = rankOrderWeights(ranks, 0);
    const s1    = saw(MATRIX, w, TYPES);
    const s2    = saw(MATRIX, EQUAL_WEIGHTS, TYPES);
    s1.forEach((v, i) => assert.ok(Math.abs(v - s2[i]) < 1e-10,
      `Mismatch at alt ${i}: ${v} vs ${s2[i]}`));
  });

  it('p=1 puts more weight on rank-1 criterion', () => {
    // Make criterion 0 (discharge, benefit) rank 1 with strong weighting
    const ranksStrongFirst = [1, 2, 3, 4, 5];
    const wStrong = rankOrderWeights(ranksStrongFirst, 1);
    // Criterion 0 weight should be highest
    assert.ok(wStrong[0] > wStrong[4], 'Rank-1 criterion should outweigh rank-5');
  });
});
