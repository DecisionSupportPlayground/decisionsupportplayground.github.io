/**
 * mcdm.js: Multi-Criteria Decision Making algorithms backed by pymcdm via Pyodide.
 *
 * Usage:
 *   import { initMCDM, topsis, saw, mabac, aras,
 *            rankOrderWeights, scoreToRank, runMethod } from './mcdm.js';
 *
 *   // Call once before any algorithm functions:
 *   await initMCDM();
 *
 *   // Then use synchronously:
 *   const scores = topsis(matrix, weights, types);
 *
 * Conventions throughout this file:
 *   matrix  {number[][]}  rows = alternatives, cols = criteria
 *   weights {number[]}    one weight per criterion; must sum to 1
 *   types   {number[]}    +1 = benefit (higher value is better)
 *                         -1 = cost   (lower value is better)
 *   return  {number[]}    one score per alternative; HIGHER score = BETTER
 *
 * Algorithm implementations are delegated to pymcdm (Python library) running
 * inside Pyodide (WebAssembly).  The pure-JS helpers rankOrderWeights and
 * scoreToRank are not in pymcdm and remain as JS.
 *
 * Browser setup: app.html loads pyodide.js from CDN before this module.
 *
 * Node.js / test setup: npm install pyodide
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pyodide bootstrap
// ─────────────────────────────────────────────────────────────────────────────

let _py = null;

/**
 * Load and initialise the Pyodide + pymcdm engine.
 * Must be awaited once before calling any algorithm function.
 * Safe to call multiple times: subsequent calls resolve immediately.
 *
 * @returns {Promise<void>}
 */
export async function initMCDM() {
  if (_py) return; // already initialised

  // ── Load Pyodide runtime and numpy ────────────────────────────────────────
  let pyodide;
  if (typeof globalThis.loadPyodide === 'function') {
    // Browser: pyodide.js was loaded from CDN; indexURL must match
    pyodide = await globalThis.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/'
    });
    await pyodide.loadPackage(['numpy']);

    // Load vendored pymcdm source from the local server (no PyPI needed)
    const zipUrl = new URL('../vendor/pymcdm.zip', import.meta.url).href;
    const zipResp = await fetch(zipUrl);
    pyodide.unpackArchive(new Uint8Array(await zipResp.arrayBuffer()), 'zip', { extractDir: '/' });
  } else {
    // Node.js test environment: use the npm 'pyodide' package
    const { loadPyodide } = await import('pyodide');
    pyodide = await loadPyodide();
    await pyodide.loadPackage(['numpy']);

    // Load vendored pymcdm source from disk (no PyPI needed)
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dir = dirname(fileURLToPath(import.meta.url));
    const zipData = readFileSync(join(__dir, '../vendor/pymcdm.zip'));
    pyodide.unpackArchive(new Uint8Array(zipData), 'zip', { extractDir: '/' });
  }

  // ── Instantiate methods ───────────────────────────────────────────────────
  // pymcdm renamed SAW → WSM between versions.  We try SAW first (older API),
  // fall back to WSM (newer API).  Standard SAW uses max_normalization which
  // handles zero values (e.g. I7 Evaporation Upstream = 0 for several alternatives).
  pyodide.runPython(`
import sys
sys.path.insert(0, '/')
import numpy as np
from pymcdm.methods import TOPSIS, MABAC, ARAS, VIKOR, CODAS, COPRAS, EDAS, MAIRCA, MARCOS, MOORA, WASPAS, COCOSO
from pymcdm import normalizations

try:
    from pymcdm.methods import SAW as _SAW_cls
    _saw_inst = _SAW_cls()
except ImportError:
    from pymcdm.methods import WSM as _SAW_cls
    _saw_inst = _SAW_cls(normalization_function=normalizations.max_normalization)

_methods = {
    'topsis': TOPSIS(),
    'saw':    _saw_inst,
    'mabac':  MABAC(),
    'aras':   ARAS(normalization_function=normalizations.max_normalization),
    'vikor':  VIKOR(),
    'codas':  CODAS(normalization_function=normalizations.max_normalization),
    'copras': COPRAS(),
    'edas':   EDAS(),
    'mairca': MAIRCA(),
    'marcos': MARCOS(normalization_function=lambda x, cost=False: (x[-2] + 1e-10) / (x + 1e-10) if cost else x / (x[-2] + 1e-10)),
    'moora':  MOORA(),
    'waspas': WASPAS(normalization_function=normalizations.max_normalization),
    'cocoso': COCOSO(),
}
`);

  _py = pyodide;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function _call(name, matrix, weights, types) {
  if (!_py) {
    throw new Error('MCDM engine not initialised; call initMCDM() first');
  }
  _py.globals.set('_matrix',  _py.toPy(matrix));
  _py.globals.set('_weights', _py.toPy(weights));
  _py.globals.set('_types',   _py.toPy(types));
  const result = _py.runPython(`
import numpy as np
list(_methods['${name}'](
    np.array(_matrix,  dtype=float),
    np.array(_weights, dtype=float),
    np.array(_types,   dtype=int)
))
`);
  return Array.from(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public algorithm exports  (same signatures as the original pure-JS versions)
// ─────────────────────────────────────────────────────────────────────────────

export const topsis = (matrix, weights, types) => _call('topsis', matrix, weights, types);
export const saw    = (matrix, weights, types) => _call('saw',    matrix, weights, types);
export const mabac  = (matrix, weights, types) => _call('mabac',  matrix, weights, types);
export const aras   = (matrix, weights, types) => _call('aras',   matrix, weights, types);
export const vikor  = (matrix, weights, types) => _call('vikor',  matrix, weights, types);
export const codas  = (matrix, weights, types) => _call('codas',  matrix, weights, types);
export const copras = (matrix, weights, types) => _call('copras', matrix, weights, types);
export const edas   = (matrix, weights, types) => _call('edas',   matrix, weights, types);
export const mairca = (matrix, weights, types) => _call('mairca', matrix, weights, types);
export const marcos = (matrix, weights, types) => _call('marcos', matrix, weights, types);
export const moora  = (matrix, weights, types) => _call('moora',  matrix, weights, types);
export const waspas = (matrix, weights, types) => _call('waspas', matrix, weights, types);
export const cocoso = (matrix, weights, types) => _call('cocoso', matrix, weights, types);

/** Maps method-name strings to their implementation functions, plus a description for the UI. */
export const METHODS = {
  topsis: { fn: topsis, label: 'TOPSIS', description: "Ranks alternatives by how close they sit to the best-case outcome and how far from the worst-case. Penalises 'one-trick ponies' (alternatives that excel on some criteria while failing on others). Use it when you want balanced across-the-board performance rewarded over specialisation." },
  saw:    { fn: saw,    label: 'SAW',    description: "The simplest method: multiply each normalised score by its weight and sum. Fully compensatory: excellent performance on one criterion can completely offset poor performance on another. Use it as a baseline. If other methods disagree with SAW, that disagreement is itself worth investigating." },
  mabac:  { fn: mabac,  label: 'MABAC',  description: "Compares each alternative to a border approximation area (the geometric mean of all alternatives on each criterion). Alternatives consistently above this border score highest. Use it when alternatives cluster closely together and you need a method sensitive enough to differentiate small margins." },
  aras:   { fn: aras,   label: 'ARAS',   description: "Creates a theoretical 'perfect' alternative built from the best value in each criterion, then scores every real alternative as a percentage of that optimum. The output is a plain ratio: 'this option achieves 73% of the best theoretically possible score.' Use it when you want results that are easy to explain to stakeholders: the percentage framing is more concrete than an abstract index." },
  vikor:  { fn: vikor,  label: 'VIKOR',  description: "Finds a compromise solution by balancing group utility (overall closeness to ideal) against individual regret (worst-criterion performance). Use it when stakeholders disagree on whether a big win on one criterion can offset losses elsewhere." },
  codas:  { fn: codas,  label: 'CODAS',  description: "Euclidean distance is the primary ranking criterion; Manhattan distance breaks ties. Euclidean distance amplifies large deviations: one very bad criterion score hurts here more than in TOPSIS. Use it when you want to be especially harsh toward alternatives with any severe weakness." },
  copras: { fn: copras, label: 'COPRAS', description: "Aggregates benefit and cost criteria through separate summations rather than simply flipping cost criteria into benefits. Alternatives with exceptionally low costs are rewarded non-linearly rather than just proportionally. Use it when cost-type criteria dominate and you want a very strong cost performer to stand out clearly." },
  edas:   { fn: edas,   label: 'EDAS',   description: "Scores alternatives on how far they deviate above or below the group average, rewarding those consistently above average on benefits and below average on costs. Use it when your question is 'which alternative stands out from the pack?' rather than 'which is closest to theoretical perfection?'. Note that rankings can shift if the set of alternatives changes." },
  mairca: { fn: mairca, label: 'MAIRCA', description: "Calculates a theoretical baseline from the assumption that each alternative is equally likely to be chosen, then measures how far each real alternative falls from that ideal. Use it when you want a ranking that tends to stay stable if alternatives are added or removed, as it is less sensitive to set composition than TOPSIS." },
  marcos: { fn: marcos, label: 'MARCOS', description: "Places alternatives between an ideal and an anti-ideal reference point, then applies a non-linear utility function to that ratio. Being much better than the worst counts for less as you approach the best. Use it when a few outlier alternatives (very strong or very weak) exist and you do not want them distorting the relative ranking of the middle-ground options." },
  moora:  { fn: moora,  label: 'MOORA',  description: "Normalises each criterion using vector normalisation (divide by the square-root of the sum of squares), then subtracts the weighted cost scores from the weighted benefit scores to get a net benefit. Use it when your criteria have very different units or scales, as vector normalisation is less distorted by outliers than the min-max normalisation used by SAW." },
  waspas: { fn: waspas, label: 'WASPAS', description: "Blends two conflicting views of trade-offs: SAW (additive, meaning a high score on one criterion fully compensates a low score on another) and a multiplicative model (where poor performance on any single criterion drags the total score down more harshly). The \u03bb parameter (default 0.5) controls the blend. Use it when you are genuinely uncertain how much compensation between criteria should be allowed." },
  cocoso: { fn: cocoso, label: 'CoCoSo', description: "Runs three different aggregation formulas and combines their results. The logic is triangulation: if all three formulas agree on a ranking, you can be more confident in it; where they disagree, the combined score softens extreme positions. Use it as a robustness check: if your top choice ranks first under CoCoSo, it is more defensible than if it only wins under one specific aggregation assumption." },
};

/**
 * Run a named MCDM method.
 *
 * @param {string}     name     One of the keys in METHODS
 * @param {number[][]} matrix
 * @param {number[]}   weights
 * @param {number[]}   types
 * @returns {number[]}  Scores: higher is better.
 * @throws {Error} for unknown method names.
 */
export function runMethod(name, matrix, weights, types) {
  const entry = METHODS[name];
  if (!entry) {
    throw new Error(
      `Unknown MCDM method: "${name}". Valid options: ${Object.keys(METHODS).join(', ')}`
    );
  }
  return entry.fn(matrix, weights, types);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-JS helpers  (class-specific utilities not in pymcdm)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute rank-order weights from an ordered list of criterion ranks.
 *
 * Formula:  w_i = (n − r_i + 1)^p  /  Σ_j (n − r_j + 1)^p
 *
 *   n   = number of criteria
 *   r_i = rank of criterion i  (r = 1 → highest priority)
 *   p   = non-negative exponent controlling weight distribution
 *
 *   p = 0  →  equal weights  (all get 1/n, regardless of rank)
 *   p = 1  →  rank-sum weights  (linear decay)
 *   p > 1  →  super-linear; amplifies the top-ranked criteria
 *
 * @param {number[]} ranks  Rank of each criterion (1 = most important).
 * @param {number}   p      Non-negative exponent (0, 0.5, or 1 for the UI).
 * @returns {number[]}      Normalised weights that sum to 1.
 */
export function rankOrderWeights(ranks, p) {
  const n = ranks.length;
  if (n === 0) return [];
  const raw = ranks.map(r => Math.pow(n - r + 1, p));
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map(v => (total === 0 ? 1 / n : v / total));
}

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

/**
 * Normalise scores to [0, 1] using min-max scaling.
 * Used by the method-comparison spider chart so all methods share a common axis.
 *
 * If all scores are identical (flat), returns 0.5 for every element so the
 * spider chart still renders a visible polygon rather than collapsing to a point.
 *
 * @param {number[]} scores  Raw scores from any MCDM method.
 * @returns {number[]}       Values in [0, 1]; higher = better.
 */
export function normaliseScores(scores) {
  const min = Math.min(...scores), max = Math.max(...scores);
  return max === min
    ? scores.map(() => 0.5)
    : scores.map(s => (s - min) / (max - min));
}

/**
 * Convert scores to inverted display values for a radar/spider chart where
 * "further from centre = better rank".
 *
 * Rank 1 (best score) maps to n (farthest from centre).
 * Rank n (worst score) maps to 1 (closest to centre).
 *
 * Formula: display = n - sorted_position(score)
 *   where sorted_position is the 0-based index in descending-sorted scores.
 *
 * @param {number[]} scores  Raw scores (higher = better).
 * @returns {number[]}       Integer display values in [1, n].
 */
export function invertRanksForDisplay(scores) {
  const n = scores.length;
  const sorted = [...scores].sort((a, b) => b - a); // descending: index 0 = best
  return scores.map(s => n - sorted.indexOf(s));    // rank 1 (index 0) -> n
}

