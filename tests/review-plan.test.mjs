/**
 * Review plan solver — Phase 5.
 *
 * The headline test is DP-vs-brute-force: it proves the solver is *exact*,
 * which is the claim that makes "we solve a knapsack" more than decoration.
 * Everything else pins the guarantees layered on top — critical inclusion,
 * budget safety, ordering, and coverage.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewPlan,
  capacityReport,
  MIN_BUDGET_MINUTES,
  MAX_BUDGET_MINUTES,
} from "../src/lib/engines/review-plan.ts";

/** Build a candidate with sensible defaults. */
function candidate(overrides = {}) {
  const risk = overrides.risk ?? 40;
  return {
    repo: "acme/api",
    number: 1,
    title: "A pull request",
    priority: overrides.priority ?? risk,
    risk,
    riskLevel: overrides.riskLevel ?? levelFor(risk),
    minutes: 10,
    ...overrides,
  };
}

function levelFor(risk) {
  if (risk >= 75) return "critical";
  if (risk >= 50) return "high";
  if (risk >= 25) return "medium";
  return "low";
}

/** Exhaustive optimum over every subset — the ground truth for the DP. */
function bruteForce(candidates, budget) {
  let bestValue = -1;
  let bestSet = [];

  const total = 1 << candidates.length;
  for (let mask = 0; mask < total; mask++) {
    let minutes = 0;
    let value = 0;
    const set = [];

    for (let i = 0; i < candidates.length; i++) {
      if (mask & (1 << i)) {
        minutes += candidates[i].minutes;
        value += candidates[i].priority;
        set.push(candidates[i]);
      }
    }

    if (minutes <= budget && value > bestValue) {
      bestValue = value;
      bestSet = set;
    }
  }

  return { value: bestValue, set: bestSet };
}

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Exactness — the claim that matters
// ---------------------------------------------------------------------------

test("DP matches brute force across 200 random instances", () => {
  const random = rng(20260903);

  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(random() * 9); // up to 9 items — 512 subsets
    const budget = MIN_BUDGET_MINUTES + Math.floor(random() * 60);

    const candidates = Array.from({ length: n }, (_, i) =>
      candidate({
        number: i + 1,
        // Keep every item non-critical so the force-include path does not
        // interfere: this test is about the optimiser alone.
        risk: Math.floor(random() * 70),
        priority: 1 + Math.floor(random() * 100),
        minutes: 2 + Math.floor(random() * 30),
      }),
    );

    const plan = buildReviewPlan(candidates, budget, {
      forceCriticals: false,
    });
    const optimal = bruteForce(candidates, budget);

    const planValue = plan.items.reduce((sum, i) => sum + i.priority, 0);

    assert.equal(
      planValue,
      optimal.value,
      `trial ${trial}: DP got ${planValue}, optimum is ${optimal.value} ` +
        `(budget ${budget}, items ${JSON.stringify(candidates.map((c) => [c.priority, c.minutes]))})`,
    );
    assert.ok(
      plan.totalMinutes <= budget,
      `trial ${trial}: plan used ${plan.totalMinutes} of ${budget}`,
    );
  }
});

test("the classic greedy trap is solved correctly", () => {
  // Greedy by priority/minute ratio picks A (ratio 1.0) then cannot fit B or
  // C, scoring 30. The optimum is B+C at 36.
  const candidates = [
    candidate({ number: 1, priority: 30, minutes: 30, risk: 30 }),
    candidate({ number: 2, priority: 18, minutes: 20, risk: 30 }),
    candidate({ number: 3, priority: 18, minutes: 20, risk: 30 }),
  ];

  const plan = buildReviewPlan(candidates, 40, { forceCriticals: false });
  const value = plan.items.reduce((sum, i) => sum + i.priority, 0);

  assert.equal(value, 36, "must beat the greedy answer of 30");
  assert.deepEqual(plan.items.map((i) => i.number).sort(), [2, 3]);
});

// ---------------------------------------------------------------------------
// Budget safety
// ---------------------------------------------------------------------------

test("the budget is never exceeded", () => {
  const random = rng(7);

  for (let trial = 0; trial < 50; trial++) {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      candidate({
        number: i + 1,
        risk: Math.floor(random() * 100),
        priority: Math.floor(random() * 100),
        minutes: 2 + Math.floor(random() * 40),
      }),
    );

    const budget = MIN_BUDGET_MINUTES + Math.floor(random() * 90);
    const plan = buildReviewPlan(candidates, budget);

    assert.ok(
      plan.totalMinutes <= plan.budgetMinutes,
      `used ${plan.totalMinutes} of ${plan.budgetMinutes}`,
    );
    assert.equal(plan.remainingMinutes, plan.budgetMinutes - plan.totalMinutes);
  }
});

test("budgets are clamped to a sane range", () => {
  const candidates = [candidate({ minutes: 10 })];

  assert.equal(
    buildReviewPlan(candidates, 0).budgetMinutes,
    MIN_BUDGET_MINUTES,
  );
  assert.equal(
    buildReviewPlan(candidates, -50).budgetMinutes,
    MIN_BUDGET_MINUTES,
  );
  assert.equal(
    buildReviewPlan(candidates, 99_999).budgetMinutes,
    MAX_BUDGET_MINUTES,
  );
});

test("an item larger than the whole budget is never included", () => {
  const candidates = [
    candidate({ number: 1, minutes: 80, priority: 100, risk: 60 }),
  ];
  const plan = buildReviewPlan(candidates, 30);

  assert.equal(plan.items.length, 0);
  assert.equal(plan.deferred.length, 1);
  assert.match(plan.deferred[0].reason, /over the whole 30 min budget/);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Nothing fits/);
});

test("an empty queue yields an empty plan, not a crash", () => {
  const plan = buildReviewPlan([], 30);

  assert.equal(plan.items.length, 0);
  assert.equal(plan.totalMinutes, 0);
  assert.equal(plan.coveredRisk, 0);
  assert.equal(plan.remainingMinutes, 30);
  assert.deepEqual(plan.warnings, []);
});

// ---------------------------------------------------------------------------
// The critical guarantee — safety beats optimality
// ---------------------------------------------------------------------------

test("a critical PR is included even when the optimiser would drop it", () => {
  // The critical is expensive and low-priority; three cheap mediums together
  // score far better. Pure optimisation drops the critical — we must not.
  const critical = candidate({
    number: 1,
    risk: 90,
    riskLevel: "critical",
    priority: 20,
    minutes: 25,
  });
  const mediums = [2, 3, 4].map((n) =>
    candidate({ number: n, risk: 30, priority: 40, minutes: 10 }),
  );

  const optimised = buildReviewPlan([critical, ...mediums], 30, {
    forceCriticals: false,
  });
  assert.ok(
    !optimised.items.some((i) => i.number === 1),
    "without the guarantee the optimiser drops the critical",
  );

  const guarded = buildReviewPlan([critical, ...mediums], 30);
  const included = guarded.items.find((i) => i.number === 1);
  assert.ok(included, "with the guarantee it is included");
  assert.equal(included.forced, true, "and is marked as forced");
});

test("as many criticals fit as possible, cheapest first", () => {
  const criticals = [
    candidate({ number: 1, risk: 95, riskLevel: "critical", minutes: 40 }),
    candidate({ number: 2, risk: 85, riskLevel: "critical", minutes: 15 }),
    candidate({ number: 3, risk: 80, riskLevel: "critical", minutes: 20 }),
  ];

  // 40 minutes fits #2 (15) + #3 (20) = 35, but not the 40-minute #1.
  const plan = buildReviewPlan(criticals, 40);
  const numbers = plan.items.map((i) => i.number).sort();

  assert.deepEqual(numbers, [2, 3], "two criticals beat one expensive one");
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /1 critical PR does not fit/);
});

test("unfittable criticals are warned about, with the shortfall named", () => {
  const criticals = [
    candidate({ number: 1, risk: 90, riskLevel: "critical", minutes: 60 }),
    candidate({ number: 2, risk: 88, riskLevel: "critical", minutes: 70 }),
  ];

  const plan = buildReviewPlan(criticals, 30);

  assert.equal(plan.items.length, 0);
  assert.ok(plan.warnings.some((w) => /2 critical PRs do not fit/.test(w)));
  assert.ok(plan.warnings.some((w) => /smallest needs 60 min/.test(w)));
});

test("forcing criticals still leaves the remaining budget optimised", () => {
  const critical = candidate({
    number: 1,
    risk: 90,
    riskLevel: "critical",
    priority: 50,
    minutes: 20,
  });
  const others = [
    candidate({ number: 2, risk: 40, priority: 30, minutes: 10 }),
    candidate({ number: 3, risk: 40, priority: 25, minutes: 10 }),
    candidate({ number: 4, risk: 40, priority: 5, minutes: 10 }),
  ];

  // 40 min budget: critical takes 20, leaving 20 for the best two of the rest.
  const plan = buildReviewPlan([critical, ...others], 40);
  const numbers = plan.items.map((i) => i.number).sort();

  assert.deepEqual(numbers, [1, 2, 3], "picks the two highest-priority others");
  assert.equal(plan.totalMinutes, 40);
});

// ---------------------------------------------------------------------------
// Ordering, coverage, determinism
// ---------------------------------------------------------------------------

test("the plan is ordered highest-risk first", () => {
  const candidates = [
    candidate({ number: 1, risk: 20, priority: 60, minutes: 5 }),
    candidate({ number: 2, risk: 70, priority: 60, minutes: 5 }),
    candidate({ number: 3, risk: 45, priority: 60, minutes: 5 }),
  ];

  const plan = buildReviewPlan(candidates, 60);

  assert.deepEqual(
    plan.items.map((i) => i.risk),
    [70, 45, 20],
    "the reviewer is freshest at the start",
  );
  assert.deepEqual(
    plan.items.map((i) => i.position),
    [1, 2, 3],
  );
});

test("ties in the plan order break on PR number", () => {
  const candidates = [
    candidate({ number: 9, risk: 50, minutes: 5 }),
    candidate({ number: 4, risk: 50, minutes: 5 }),
  ];

  const plan = buildReviewPlan(candidates, 60);
  assert.deepEqual(
    plan.items.map((i) => i.number),
    [4, 9],
  );
});

test("cumulative minutes accumulate in reading order", () => {
  const candidates = [
    candidate({ number: 1, risk: 80, riskLevel: "critical", minutes: 12 }),
    candidate({ number: 2, risk: 60, minutes: 8 }),
    candidate({ number: 3, risk: 40, minutes: 5 }),
  ];

  const plan = buildReviewPlan(candidates, 60);

  assert.deepEqual(
    plan.items.map((i) => i.cumulativeMinutes),
    [12, 20, 25],
  );
  assert.equal(plan.totalMinutes, 25);
});

test("coveredRisk is the share of queue risk addressed", () => {
  const candidates = [
    candidate({ number: 1, risk: 60, priority: 90, minutes: 10 }),
    candidate({ number: 2, risk: 40, priority: 10, minutes: 100 }),
  ];

  // Only the first fits: 60 of 100 total risk.
  const plan = buildReviewPlan(candidates, 20);
  assert.equal(plan.coveredRisk, 60);
});

test("coveredRisk is 0 rather than NaN when the queue carries no risk", () => {
  const candidates = [
    candidate({
      number: 1,
      risk: 0,
      riskLevel: "low",
      priority: 0,
      minutes: 5,
    }),
  ];
  const plan = buildReviewPlan(candidates, 30);
  assert.equal(plan.coveredRisk, 0);
});

test("every excluded PR is deferred with a reason", () => {
  const candidates = [
    candidate({ number: 1, risk: 60, priority: 90, minutes: 10 }),
    candidate({ number: 2, risk: 50, priority: 50, minutes: 25 }),
    candidate({ number: 3, risk: 40, priority: 20, minutes: 25 }),
  ];

  const plan = buildReviewPlan(candidates, 15);

  assert.equal(plan.items.length + plan.deferred.length, candidates.length);
  for (const item of plan.deferred) {
    assert.match(item.reason, /needs \d+ min/);
  }
});

test("the plan is deterministic across 30 runs", () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    candidate({
      number: i + 1,
      risk: (i * 17) % 100,
      priority: (i * 29) % 100,
      minutes: 4 + ((i * 7) % 20),
      riskLevel: levelFor((i * 17) % 100),
    }),
  );

  const first = JSON.stringify(buildReviewPlan(candidates, 45));
  for (let i = 0; i < 29; i++) {
    assert.equal(JSON.stringify(buildReviewPlan(candidates, 45)), first);
  }
});

test("input order does not change the plan", () => {
  const candidates = Array.from({ length: 8 }, (_, i) =>
    candidate({
      number: i + 1,
      risk: (i * 13) % 100,
      priority: (i * 31) % 100,
      minutes: 3 + ((i * 5) % 15),
      riskLevel: levelFor((i * 13) % 100),
    }),
  );

  const forward = buildReviewPlan(candidates, 40);
  const reversed = buildReviewPlan([...candidates].reverse(), 40);

  assert.deepEqual(
    forward.items.map((i) => i.number),
    reversed.items.map((i) => i.number),
  );
  assert.equal(forward.totalMinutes, reversed.totalMinutes);
});

test("PRs from different repos with the same number stay distinct", () => {
  const candidates = [
    candidate({ repo: "acme/api", number: 7, risk: 60, minutes: 10 }),
    candidate({ repo: "acme/web", number: 7, risk: 50, minutes: 10 }),
  ];

  const plan = buildReviewPlan(candidates, 60);
  assert.equal(plan.items.length, 2, "identity must include the repo");
});

// ---------------------------------------------------------------------------
// Capacity analytics
// ---------------------------------------------------------------------------

test("capacity report totals minutes per level, highest first", () => {
  const candidates = [
    candidate({ number: 1, risk: 90, riskLevel: "critical", minutes: 30 }),
    candidate({ number: 2, risk: 60, riskLevel: "high", minutes: 20 }),
    candidate({ number: 3, risk: 55, riskLevel: "high", minutes: 15 }),
    candidate({ number: 4, risk: 10, riskLevel: "low", minutes: 5 }),
  ];

  const report = capacityReport(candidates, 40);

  assert.deepEqual(
    report.rows.map((r) => [r.level, r.count, r.minutes]),
    [
      ["critical", 1, 30],
      ["high", 2, 35],
      ["low", 1, 5],
    ],
    "empty levels are omitted; order is critical → low",
  );
  assert.equal(report.totalMinutes, 70);
});

test("the deficit is the queue beyond capacity, never negative", () => {
  const candidates = [
    candidate({ number: 1, risk: 50, minutes: 60 }),
    candidate({ number: 2, risk: 50, minutes: 47 }),
  ];

  const short = capacityReport(candidates, 95);
  assert.equal(short.totalMinutes, 107);
  assert.equal(short.deficitMinutes, 12);
  assert.equal(short.loadFactor, 1.13);

  const ample = capacityReport(candidates, 200);
  assert.equal(ample.deficitMinutes, 0, "surplus is not a negative deficit");
});

test("capacity of zero does not divide by zero", () => {
  const report = capacityReport([candidate({ minutes: 10 })], 0);
  assert.equal(report.loadFactor, 0);
  assert.equal(report.deficitMinutes, 10);
});
