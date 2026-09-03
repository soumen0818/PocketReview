/**
 * Eval metrics — Phase 8.
 *
 * The metrics decide whether the headline number is real, so they get the same
 * scrutiny as the engines. Hand-computed expectations throughout: a metric
 * that agrees with its own implementation proves nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  rankItems,
  recallAt,
  precisionAt,
  ndcg,
  meanAbsoluteError,
  evaluateScorer,
  pct,
} from "../eval/metrics.ts";

/** Compact fixture: "1" marks attention-worthy, "0" does not. */
function items(spec) {
  return spec.split("").map((flag, i) => ({
    id: `pr-${String(i).padStart(2, "0")}`,
    // Descending score so string order equals rank order.
    score: 100 - i,
    attentionWorthy: flag === "1",
  }));
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test("items rank by score descending", () => {
  const ranked = rankItems([
    { id: "a", score: 10, attentionWorthy: false },
    { id: "b", score: 90, attentionWorthy: true },
    { id: "c", score: 50, attentionWorthy: false },
  ]);

  assert.deepEqual(
    ranked.map((i) => i.id),
    ["b", "c", "a"],
  );
});

test("ties break deterministically by id", () => {
  const tied = [
    { id: "z", score: 50, attentionWorthy: false },
    { id: "a", score: 50, attentionWorthy: true },
  ];

  assert.deepEqual(
    rankItems(tied).map((i) => i.id),
    ["a", "z"],
  );
  // Reversing the input must not change the output.
  assert.deepEqual(
    rankItems([...tied].reverse()).map((i) => i.id),
    ["a", "z"],
  );
});

// ---------------------------------------------------------------------------
// Recall@K — the headline metric
// ---------------------------------------------------------------------------

test("recall@K counts the worthy items inside the top K", () => {
  // 4 worthy overall; 2 of them in the top 5.
  const set = items("1010000001" + "1");
  assert.equal(recallAt(set, 5), 2 / 4);
  assert.equal(recallAt(set, 11), 1);
});

test("a perfect ranking has recall 1 at K = number of worthy items", () => {
  assert.equal(recallAt(items("111000000"), 3), 1);
});

test("the worst ranking has recall 0 at that same K", () => {
  assert.equal(recallAt(items("000000111"), 3), 0);
});

test("recall is 0, not 1, when nothing is attention-worthy", () => {
  // Undefined rather than perfect — a scorer gets no credit for an empty set.
  assert.equal(recallAt(items("0000"), 2), 0);
});

test("K larger than the set does not exceed 1", () => {
  assert.equal(recallAt(items("101"), 99), 1);
});

// ---------------------------------------------------------------------------
// Precision@K
// ---------------------------------------------------------------------------

test("precision@K is the worthy share of the top K", () => {
  assert.equal(precisionAt(items("1100000000"), 4), 0.5);
  assert.equal(precisionAt(items("1111000000"), 4), 1);
});

test("precision is 0 on an empty set rather than NaN", () => {
  assert.equal(precisionAt([], 5), 0);
});

// ---------------------------------------------------------------------------
// NDCG
// ---------------------------------------------------------------------------

test("NDCG is 1 for a perfect ranking", () => {
  assert.equal(ndcg(items("1110000")), 1);
});

test("NDCG rewards putting worthy items higher", () => {
  const better = ndcg(items("1010000"));
  const worse = ndcg(items("0000101"));

  assert.ok(better > worse, `${better} should exceed ${worse}`);
  assert.ok(better <= 1 && worse >= 0);
});

test("NDCG is 0 when nothing is worthy", () => {
  assert.equal(ndcg(items("0000")), 0);
});

// ---------------------------------------------------------------------------
// Effort calibration
// ---------------------------------------------------------------------------

test("MAE averages absolute error", () => {
  assert.equal(
    meanAbsoluteError([
      { predicted: 10, actual: 15 },
      { predicted: 20, actual: 10 },
    ]),
    7.5,
  );
});

test("MAE is 0 on an empty set rather than NaN", () => {
  assert.equal(meanAbsoluteError([]), 0);
});

test("MAE is sign-agnostic", () => {
  const over = meanAbsoluteError([{ predicted: 30, actual: 20 }]);
  const under = meanAbsoluteError([{ predicted: 10, actual: 20 }]);
  assert.equal(over, under);
});

// ---------------------------------------------------------------------------
// The comparison the eval exists to make
// ---------------------------------------------------------------------------

test("a better scorer measurably beats a worse one", () => {
  const worthy = new Set(["a", "b", "c"]);
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

  // Good: worthy items score highest. Bad: exactly inverted.
  const good = ids.map((id, i) => ({
    id,
    score: worthy.has(id) ? 100 - i : 10 - i,
    attentionWorthy: worthy.has(id),
  }));
  const bad = ids.map((id, i) => ({
    id,
    score: worthy.has(id) ? 10 - i : 100 - i,
    attentionWorthy: worthy.has(id),
  }));

  const g = evaluateScorer("good", good);
  const b = evaluateScorer("bad", bad);

  assert.equal(g.recallAt5, 1);
  assert.ok(g.ndcg > b.ndcg);
  assert.ok(g.recallAt5 > b.recallAt5);
});

test("evaluateScorer reports every metric", () => {
  const result = evaluateScorer("x", items("1010101010"));

  for (const key of [
    "recallAt5",
    "recallAt10",
    "recallAt20",
    "precisionAt10",
    "ndcg",
  ]) {
    assert.equal(typeof result[key], "number", `${key} missing`);
    assert.ok(
      result[key] >= 0 && result[key] <= 1,
      `${key} out of range: ${result[key]}`,
    );
  }
  assert.equal(result.name, "x");
});

test("pct formats for the results table", () => {
  assert.equal(pct(0.783), "78.3%");
  assert.equal(pct(1), "100.0%");
  assert.equal(pct(0), "0.0%");
});
