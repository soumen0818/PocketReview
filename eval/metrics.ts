/**
 * Ranking metrics.
 *
 * We validate a **ranking**, not a classification. The question is not "did we
 * label this PR correctly" — it is "of the PRs that genuinely needed careful
 * attention, how many did we put near the top?"
 *
 * Recall@K is the headline because it maps directly onto the product: a
 * reviewer works down the queue from the top and stops when they run out of
 * time. Recall@K is literally "what fraction of the risky PRs did they reach".
 *
 * Pure functions, no I/O — unit-tested offline like every other engine here.
 */

/** One scored item with its ground-truth label. */
export interface ScoredItem {
  id: string;
  score: number;
  attentionWorthy: boolean;
}

/**
 * Sort by score descending, breaking ties deterministically by id.
 *
 * The tiebreak matters: with many equal scores, an unstable order would make
 * the metric jitter between runs and the numbers unreproducible.
 */
export function rankItems(items: ScoredItem[]): ScoredItem[] {
  return [...items].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}

/**
 * Recall@K — of all attention-worthy PRs, how many are in the top K?
 *
 * Returns 0 when nothing is attention-worthy, since the metric is undefined
 * rather than perfect in that case.
 */
export function recallAt(items: ScoredItem[], k: number): number {
  const total = items.filter((i) => i.attentionWorthy).length;
  if (total === 0) return 0;

  const found = rankItems(items)
    .slice(0, k)
    .filter((i) => i.attentionWorthy).length;

  return found / total;
}

/** Precision@K — of our top K, how many were justified? */
export function precisionAt(items: ScoredItem[], k: number): number {
  const top = rankItems(items).slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((i) => i.attentionWorthy).length / top.length;
}

/**
 * Normalised discounted cumulative gain.
 *
 * Rewards putting relevant items high rather than merely inside the top K, so
 * it captures ranking quality across the whole queue rather than at one cut-off.
 */
export function ndcg(items: ScoredItem[], k?: number): number {
  const ranked = rankItems(items);
  const cut = k ?? ranked.length;

  const dcg = (list: ScoredItem[]) =>
    list
      .slice(0, cut)
      .reduce(
        (sum, item, index) =>
          sum + (item.attentionWorthy ? 1 : 0) / Math.log2(index + 2),
        0,
      );

  const ideal = [...items].sort(
    (a, b) => Number(b.attentionWorthy) - Number(a.attentionWorthy),
  );

  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(ranked) / idealDcg;
}

/** Mean absolute error, for the effort calibration. */
export function meanAbsoluteError(
  pairs: Array<{ predicted: number; actual: number }>,
): number {
  if (pairs.length === 0) return 0;
  const total = pairs.reduce(
    (sum, p) => sum + Math.abs(p.predicted - p.actual),
    0,
  );
  return total / pairs.length;
}

/** Everything measured for one scorer. */
export interface ScorerResult {
  name: string;
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  precisionAt10: number;
  ndcg: number;
}

export function evaluateScorer(
  name: string,
  items: ScoredItem[],
): ScorerResult {
  return {
    name,
    recallAt5: recallAt(items, 5),
    recallAt10: recallAt(items, 10),
    recallAt20: recallAt(items, 20),
    precisionAt10: precisionAt(items, 10),
    ndcg: ndcg(items),
  };
}

/** Format a 0..1 metric as a percentage string. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
