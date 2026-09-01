/**
 * Shared numeric helpers for the scoring engines.
 *
 * Every function here is pure and deterministic. This is deliberate: the risk
 * score must be reproducible across runs so that "why 87?" always has the same
 * answer.
 */

/** Clamp a value into a range (defaults to the 0..1 sub-score range). */
export function clamp(value: number, min = 0, max = 1): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Saturating growth curve: `1 - e^(-x/k)`.
 *
 * Gives diminishing returns so that extreme inputs do not dominate a score.
 * A 5000-line PR is not 10x riskier than a 500-line one — both are simply
 * "large". `k` is the soft knee: at `x = k` the result is ~0.63.
 */
export function saturate(value: number, knee: number): number {
  if (knee <= 0) return 0;
  if (value <= 0) return 0;
  return clamp(1 - Math.exp(-value / knee));
}

/** Arithmetic mean, 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Weighted mean, 0 when all weights are 0 or the list is empty. */
export function weightedMean(values: number[], weights: number[]): number {
  if (values.length === 0 || values.length !== weights.length) return 0;
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return 0;
  const weighted = values.reduce((sum, v, i) => sum + v * weights[i], 0);
  return weighted / totalWeight;
}

/**
 * Shannon entropy of a distribution, normalised to 0..1.
 *
 * Used to measure how evenly a diff is spread across files. A change
 * concentrated in one file scores near 0; one scattered evenly across many
 * files scores near 1. Scattered changes are harder to review because the
 * reviewer must hold more context at once.
 */
export function normalisedEntropy(counts: number[]): number {
  const positive = counts.filter((c) => c > 0);
  if (positive.length <= 1) return 0;

  const total = positive.reduce((sum, c) => sum + c, 0);
  if (total === 0) return 0;

  const entropy = -positive.reduce((sum, c) => {
    const p = c / total;
    return sum + p * Math.log(p);
  }, 0);

  // Maximum entropy for n buckets is ln(n); normalise against it.
  return clamp(entropy / Math.log(positive.length));
}

/** Exponential decay by half-life, used for recency weighting. */
export function decay(age: number, halfLife: number): number {
  if (halfLife <= 0) return 0;
  return clamp(Math.exp(-age / halfLife));
}

/** Round to a fixed number of decimal places (avoids float noise in output). */
export function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Percentage of `part` in `whole`, 0 when whole is 0. */
export function ratio(part: number, whole: number): number {
  if (whole === 0) return 0;
  return part / whole;
}
