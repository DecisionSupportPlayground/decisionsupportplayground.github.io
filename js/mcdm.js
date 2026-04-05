/**
 * mcdm.js — Multi-Criteria Decision Making algorithms.
 *
 * All functions are pure: no side effects, no DOM access, no mutation of
 * input arguments. Safe to import in both browser and Node test environments.
 *
 * Conventions throughout this file:
 *   matrix  {number[][]}  rows = alternatives, cols = criteria
 *   weights {number[]}    one weight per criterion; must sum to 1
 *   types   {number[]}    +1 = benefit (higher value is better)
 *                         -1 = cost   (lower value is better)
 *   return  {number[]}    one score per alternative; HIGHER score = BETTER
 *                         rank, regardless of which method is used
 */

// ─────────────────────────────────────────────────────────────────────────────
// Weighting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute rank-order weights from an ordered list of criterion ranks.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Formula:  w_i = (n − r_i + 1)^p  /  Σ_j (n − r_j + 1)^p          │
 * │                                                                      │
 * │  n   = number of criteria                                            │
 * │  r_i = rank of criterion i  (r = 1 → highest priority)              │
 * │  p   = non-negative exponent controlling weight distribution         │
 * │                                                                      │
 * │  p = 0  →  equal weights  (all get 1/n, regardless of rank)         │
 * │  p = 1  →  rank-sum weights  (linear decay)                         │
 * │  p > 1  →  super-linear; amplifies the top-ranked criteria          │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Reference: Stillwell, W. G., Seaver, D. A., & Edwards, W. (1981).
 * "A comparison of weight approximation techniques in multiattribute
 * utility decision making." Organizational Behavior and Human
 * Performance, 28(1), 62–77.
 *
 * To replace this weighting scheme, swap out this function only.
 * All other code calls weights exclusively through `rankOrderWeights`.
 *
 * @param {number[]} ranks  Rank of each criterion (1 = most important).
 *                          Must contain every integer from 1 to n exactly once.
 * @param {number}   p      Non-negative exponent (0, 0.5, or 1 for the UI).
 * @returns {number[]}      Normalised weights that sum to 1.
 */
export function rankOrderWeights(ranks, p) {
  const n = ranks.length;
  if (n === 0) return [];
  const raw = ranks.map(r => Math.pow(n - r + 1, p));
  const total = raw.reduce((a, b) => a + b, 0);
  // When p = 0 every raw value = 1, total = n, so each weight = 1/n  ✓
  return raw.map(v => (total === 0 ? 1 / n : v / total));
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Min-max normalisation — scales each column to [0, 1].
 *
 * Benefit column  (type = +1):  n_ij = (x_ij − min_j) / (max_j − min_j)
 * Cost column     (type = −1):  n_ij = (max_j − x_ij) / (max_j − min_j)
 *
 * Columns where max = min have no discriminating power and are set to 0.
 *
 * Used by: SAW, MABAC.
 *
 * @param {number[][]} matrix
 * @param {number[]}   types
 * @returns {number[][]}
 */
export function minMaxNormalize(matrix, types) {
  const m = matrix.length;
  const n = types.length;
  const result = Array.from({ length: m }, () => new Array(n).fill(0));

  for (let j = 0; j < n; j++) {
    const col = matrix.map(row => row[j]);
    const minVal = Math.min(...col);
    const maxVal = Math.max(...col);
    const range = maxVal - minVal;

    for (let i = 0; i < m; i++) {
      if (range === 0) {
        result[i][j] = 0;
      } else if (types[j] === 1) {
        result[i][j] = (matrix[i][j] - minVal) / range;
      } else {
        result[i][j] = (maxVal - matrix[i][j]) / range;
      }
    }
  }
  return result;
}

/**
 * Vector (Euclidean) normalisation.
 *
 * n_ij = x_ij / sqrt( Σ_i x_ij² )
 *
 * Benefit/cost direction is NOT applied here; it is handled at the
 * ideal-point selection step inside TOPSIS.
 * Columns with zero magnitude are set to 0.
 *
 * Used by: TOPSIS.
 *
 * @param {number[][]} matrix
 * @returns {number[][]}
 */
export function vectorNormalize(matrix) {
  const m = matrix.length;
  const n = matrix[0].length;
  const result = Array.from({ length: m }, () => new Array(n).fill(0));

  for (let j = 0; j < n; j++) {
    const magnitude = Math.sqrt(
      matrix.map(row => row[j] ** 2).reduce((a, b) => a + b, 0)
    );
    for (let i = 0; i < m; i++) {
      result[i][j] = magnitude === 0 ? 0 : matrix[i][j] / magnitude;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCDM methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SAW — Simple Additive Weighting  (also known as WSM).
 *
 * Steps:
 *   1. Min-max normalise the decision matrix (benefit/cost aware).
 *   2. Multiply each normalised value by its criterion weight.
 *   3. Sum across criteria for each alternative.
 *
 * Score range: [0, 1]. Higher = better.
 *
 * @param {number[][]} matrix
 * @param {number[]}   weights
 * @param {number[]}   types
 * @returns {number[]}
 */
export function saw(matrix, weights, types) {
  const norm = minMaxNormalize(matrix, types);
  return norm.map(row =>
    row.reduce((sum, val, j) => sum + weights[j] * val, 0)
  );
}

/**
 * TOPSIS — Technique for Order Preference by Similarity to Ideal Solution.
 *
 * Steps:
 *   1. Vector-normalise the matrix.
 *   2. Weight the normalised values.
 *   3. Determine ideal best (A⁺) and ideal worst (A⁻), respecting types.
 *   4. Compute Euclidean distance of each alternative to A⁺ and A⁻.
 *   5. Score = d⁻ / (d⁺ + d⁻).
 *
 * Score range: [0, 1]. Higher = closer to ideal = better.
 *
 * Reference: Hwang, C. L., & Yoon, K. (1981). Multiple Attribute Decision
 * Making: Methods and Applications. Springer.
 *
 * @param {number[][]} matrix
 * @param {number[]}   weights
 * @param {number[]}   types
 * @returns {number[]}
 */
export function topsis(matrix, weights, types) {
  const norm = vectorNormalize(matrix);
  const n = types.length;

  // Weighted normalised matrix
  const v = norm.map(row => row.map((val, j) => val * weights[j]));

  // Ideal best A⁺ and ideal worst A⁻
  const aPlus = types.map((t, j) =>
    t === 1
      ? Math.max(...v.map(r => r[j]))
      : Math.min(...v.map(r => r[j]))
  );
  const aMinus = types.map((t, j) =>
    t === 1
      ? Math.min(...v.map(r => r[j]))
      : Math.max(...v.map(r => r[j]))
  );

  return v.map(row => {
    const dPlus  = Math.sqrt(row.reduce((s, val, j) => s + (val - aPlus[j])  ** 2, 0));
    const dMinus = Math.sqrt(row.reduce((s, val, j) => s + (val - aMinus[j]) ** 2, 0));
    return dPlus + dMinus === 0 ? 0 : dMinus / (dPlus + dMinus);
  });
}

/**
 * MABAC — Multi-Attributive Border Approximation area Comparison.
 *
 * Steps:
 *   1. Min-max normalise (benefit/cost aware).
 *   2. Weighted matrix: v_ij = w_j × (n_ij + 1).
 *   3. Border Approximation Area (BAA): g_j = geometric mean of v_ij
 *      over all alternatives.
 *   4. Distance from BAA: q_ij = v_ij − g_j.
 *   5. Score = Σ_j q_ij  (sum of distances per alternative).
 *
 * Scores are centred around 0; positive = above BAA = preferred.
 * Higher score = better.
 *
 * Reference: Pamučar, D., & Ćirović, G. (2015). "The selection of
 * transport and handling resources in logistics centers using
 * Multi-Attributive Border Approximation area Comparison (MABAC)."
 * Expert Systems with Applications, 42(6), 3016–3028.
 *
 * @param {number[][]} matrix
 * @param {number[]}   weights
 * @param {number[]}   types
 * @returns {number[]}
 */
export function mabac(matrix, weights, types) {
  const norm = minMaxNormalize(matrix, types);
  const m = matrix.length;
  const n = types.length;

  // Step 2: weighted normalised + 1
  const v = norm.map(row => row.map((val, j) => weights[j] * (val + 1)));

  // Step 3: BAA — geometric mean per criterion
  const g = Array.from({ length: n }, (_, j) => {
    const product = v.reduce((prod, row) => prod * row[j], 1);
    return Math.pow(product, 1 / m);
  });

  // Steps 4–5: distance from BAA, summed across criteria
  return v.map(row =>
    row.reduce((sum, val, j) => sum + (val - g[j]), 0)
  );
}

/**
 * ARAS — Additive Ratio Assessment.
 *
 * Steps:
 *   1. Prepend an optimal alternative x₀:
 *        benefit → max value in column; cost → min value in column.
 *   2. Normalise:
 *        benefit → n_ij = x_ij / Σ_i x_ij
 *        cost    → n_ij = (1/x_ij) / Σ_i (1/x_ij)
 *   3. Weighted normalised decision matrix: v_ij = w_j × n_ij.
 *   4. Optimality function: S_i = Σ_j v_ij.
 *   5. Utility score: K_i = S_i / S₀.
 *
 * Score range: [0, 1]. Higher = higher utility relative to optimum.
 *
 * Reference: Zavadskas, E. K., & Turskis, Z. (2010). "A new additive
 * ratio assessment (ARAS) method in multicriteria decision-making."
 * Technological and Economic Development of Economy, 16(2), 159–172.
 *
 * @param {number[][]} matrix
 * @param {number[]}   weights
 * @param {number[]}   types
 * @returns {number[]}
 */
export function aras(matrix, weights, types) {
  const m = matrix.length;
  const n = types.length;

  // Step 1: optimal alternative x₀ (prepended)
  const x0 = types.map((t, j) => {
    const col = matrix.map(row => row[j]);
    return t === 1 ? Math.max(...col) : Math.min(...col);
  });
  const extended = [x0, ...matrix]; // m+1 rows; row 0 is optimal

  // Step 2: normalisation (column-by-column)
  const norm = Array.from({ length: extended.length }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const col = extended.map(row => row[j]);
    if (types[j] === 1) {
      const colSum = col.reduce((a, b) => a + b, 0);
      for (let i = 0; i < extended.length; i++) {
        norm[i][j] = colSum === 0 ? 0 : col[i] / colSum;
      }
    } else {
      // Cost: work with reciprocals (guard against division by zero)
      const inv = col.map(v => (v === 0 ? 0 : 1 / v));
      const invSum = inv.reduce((a, b) => a + b, 0);
      for (let i = 0; i < extended.length; i++) {
        norm[i][j] = invSum === 0 ? 0 : inv[i] / invSum;
      }
    }
  }

  // Steps 3–4: weighted sum (optimality function S_i)
  const S = norm.map(row =>
    row.reduce((sum, val, j) => sum + weights[j] * val, 0)
  );

  // Step 5: utility ratio K_i = S_i / S₀  (skip the prepended row)
  const S0 = S[0];
  return S.slice(1).map(si => (S0 === 0 ? 0 : si / S0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert scores to 1-based ranks.  Rank 1 = highest score = best alternative.
 *
 * Uses dense ranking: ties share the same rank and the next rank is not
 * skipped (e.g. scores [0.9, 0.7, 0.7] → ranks [1, 2, 2]).
 *
 * @param {number[]} scores
 * @returns {number[]}
 */
export function scoreToRank(scores) {
  const sorted = [...scores].sort((a, b) => b - a); // descending
  return scores.map(s => sorted.indexOf(s) + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/** Maps method-name strings to their implementation functions. */
export const METHODS = { saw, topsis, mabac, aras };

/**
 * Run a named MCDM method.
 *
 * @param {string}     name     One of 'saw' | 'topsis' | 'mabac' | 'aras'
 * @param {number[][]} matrix
 * @param {number[]}   weights
 * @param {number[]}   types
 * @returns {number[]}  Scores — higher is better.
 * @throws {Error} for unknown method names.
 */
export function runMethod(name, matrix, weights, types) {
  const fn = METHODS[name];
  if (!fn) {
    throw new Error(
      `Unknown MCDM method: "${name}". Valid options: ${Object.keys(METHODS).join(', ')}`
    );
  }
  return fn(matrix, weights, types);
}
