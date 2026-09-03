/**
 * The review plan solver.
 *
 * Every other tool answers *"here are your PRs, sorted."* This answers the
 * question a reviewer actually has:
 *
 *   > "I have 30 minutes before my next meeting. What should I do?"
 *
 * That is a **0/1 knapsack with a priority-weighted objective**:
 *
 *   maximise   Σ priority(pr) · x(pr)
 *   subject to Σ minutes(pr) · x(pr) ≤ budget,   x(pr) ∈ {0,1}
 *
 * Solved **exactly** by dynamic programming, not approximated by a greedy
 * value/weight sort. With n ≤ 50 PRs and integer minutes the table is
 * `O(n · budget)` — microseconds — so there is no reason to approximate, and
 * "we solve it exactly with DP" is a far better answer than "we sort by ratio".
 * A test checks the DP result against brute force on small inputs.
 *
 * Pure and deterministic, like every engine here: the same queue and budget
 * produce the same plan on every run.
 */

import { round } from "../math";
import type { RiskLevel } from "./types";

/** The minimum a plan can be asked for. Below this nothing fits. */
export const MIN_BUDGET_MINUTES = 5;

/** Guard against a pathological budget blowing up the DP table. */
export const MAX_BUDGET_MINUTES = 480;

/** What the solver needs to know about one PR. */
export interface PlanCandidate {
  repo: string;
  number: number;
  title: string;
  /** Queue position score, 0..100 — the objective being maximised. */
  priority: number;
  /** Risk score, 0..100 — used for coverage and ordering within the plan. */
  risk: number;
  riskLevel: RiskLevel;
  /** Review cost in minutes — the knapsack weight. */
  minutes: number;
}

/** A PR that made it into the plan. */
export interface PlanItem extends PlanCandidate {
  /** 1-based position in the reading order. */
  position: number;
  /** Cumulative minutes once this item is done. */
  cumulativeMinutes: number;
  /** True when included by the critical guarantee rather than by the DP. */
  forced: boolean;
}

/** A PR that did not make it, and why. */
export interface DeferredItem extends PlanCandidate {
  reason: string;
}

/** The complete, auditable output of the solver. */
export interface ReviewPlan {
  budgetMinutes: number;
  items: PlanItem[];
  totalMinutes: number;
  /** Minutes of the budget left unused. */
  remainingMinutes: number;
  /** Percentage of the queue's total risk this plan addresses, 0..100. */
  coveredRisk: number;
  deferred: DeferredItem[];
  /** Conditions the reviewer must know about — unfittable criticals, etc. */
  warnings: string[];
}

export interface PlanOptions {
  /**
   * Guarantee critical PRs a place before optimising the rest.
   *
   * Safety beats optimality: a plan that leaves a critical PR out because two
   * cheap medium PRs scored marginally better is a plan that fails the one
   * job this product has. Defaults on.
   */
  forceCriticals?: boolean;
}

/**
 * Build a review plan for a time budget.
 *
 * The budget is clamped to `[MIN_BUDGET_MINUTES, MAX_BUDGET_MINUTES]` and
 * rounded to an integer, because the DP table is indexed by minute.
 */
export function buildReviewPlan(
  candidates: PlanCandidate[],
  budgetMinutes: number,
  options: PlanOptions = {},
): ReviewPlan {
  const { forceCriticals = true } = options;

  const budget = Math.round(
    Math.min(Math.max(budgetMinutes, MIN_BUDGET_MINUTES), MAX_BUDGET_MINUTES),
  );

  const warnings: string[] = [];
  const totalQueueRisk = candidates.reduce((sum, c) => sum + c.risk, 0);

  if (candidates.length === 0) {
    return emptyPlan(budget);
  }

  // --- the critical guarantee ---
  //
  // Reserved cheapest-first so the largest number of criticals fit. Ordering
  // by risk instead would let one expensive critical crowd out two slightly
  // less critical ones that would both have made it.
  const criticals = candidates.filter((c) => c.riskLevel === "critical");
  const forced: PlanCandidate[] = [];
  let forcedMinutes = 0;

  if (forceCriticals && criticals.length > 0) {
    const byCost = [...criticals].sort(
      (a, b) => a.minutes - b.minutes || a.number - b.number,
    );

    for (const critical of byCost) {
      if (forcedMinutes + critical.minutes <= budget) {
        forced.push(critical);
        forcedMinutes += critical.minutes;
      }
    }

    const unfitted = criticals.filter((c) => !forced.includes(c));
    if (unfitted.length > 0) {
      const cheapest = Math.min(...unfitted.map((c) => c.minutes));
      warnings.push(
        unfitted.length === 1
          ? `1 critical PR does not fit in this budget — #${unfitted[0].number} needs ${unfitted[0].minutes} min`
          : `${unfitted.length} critical PRs do not fit in this budget — the smallest needs ${cheapest} min`,
      );
    }
  }

  // --- the knapsack over everything else ---
  const forcedIds = new Set(forced.map(identity));
  const remaining = candidates.filter((c) => !forcedIds.has(identity(c)));
  const chosen = knapsack(remaining, budget - forcedMinutes);

  const chosenIds = new Set(chosen.map(identity));
  const included = [...forced, ...chosen];

  // --- ordering within the plan ---
  //
  // Highest risk first, while the reviewer is freshest. Attention degrades
  // over a session, so the item that most needs careful reading should not be
  // the one read last. PR number breaks ties, keeping the order total.
  const ordered = [...included].sort(
    (a, b) => b.risk - a.risk || a.number - b.number,
  );

  let cumulative = 0;
  const items: PlanItem[] = ordered.map((c, index) => {
    cumulative += c.minutes;
    return {
      ...c,
      position: index + 1,
      cumulativeMinutes: cumulative,
      forced: forcedIds.has(identity(c)),
    };
  });

  const totalMinutes = cumulative;
  const remainingMinutes = budget - totalMinutes;

  // --- deferred, with a reason each ---
  const deferred: DeferredItem[] = candidates
    .filter((c) => !forcedIds.has(identity(c)) && !chosenIds.has(identity(c)))
    .sort((a, b) => b.priority - a.priority || a.number - b.number)
    .map((c) => ({
      ...c,
      reason:
        c.minutes > budget
          ? `needs ${c.minutes} min, over the whole ${budget} min budget`
          : `needs ${c.minutes} min, ${remainingMinutes} remaining`,
    }));

  const coveredRisk =
    totalQueueRisk === 0
      ? 0
      : round(
          (items.reduce((sum, i) => sum + i.risk, 0) / totalQueueRisk) * 100,
          1,
        );

  if (items.length === 0 && candidates.length > 0) {
    const cheapest = Math.min(...candidates.map((c) => c.minutes));
    warnings.push(
      `Nothing fits in ${budget} min — the smallest PR needs ${cheapest} min`,
    );
  }

  return {
    budgetMinutes: budget,
    items,
    totalMinutes,
    remainingMinutes,
    coveredRisk,
    deferred,
    warnings,
  };
}

/**
 * Exact 0/1 knapsack by dynamic programming.
 *
 * `table[w]` holds the best achievable objective using at most `w` minutes.
 * Iterating `w` downward is what keeps it 0/1 rather than unbounded — each
 * item is considered at most once per capacity.
 *
 * Items costing more than the budget, or nothing at all, are filtered first:
 * a zero-minute item would otherwise be free to include infinitely often in
 * the reconstruction, and the effort estimator's floor of 2 makes that
 * impossible in practice, but the solver should not depend on that.
 */
function knapsack(
  candidates: PlanCandidate[],
  capacity: number,
): PlanCandidate[] {
  if (capacity <= 0 || candidates.length === 0) return [];

  const items = candidates.filter(
    (c) => c.minutes > 0 && c.minutes <= capacity,
  );
  if (items.length === 0) return [];

  const n = items.length;

  // best[i][w] = max objective using the first i items within w minutes.
  // The full table is kept so the chosen set can be reconstructed exactly.
  const best: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(capacity + 1).fill(0),
  );

  for (let i = 1; i <= n; i++) {
    const item = items[i - 1];
    const cost = item.minutes;
    const value = item.priority;

    for (let w = 0; w <= capacity; w++) {
      const without = best[i - 1][w];
      if (cost > w) {
        best[i][w] = without;
      } else {
        const withItem = best[i - 1][w - cost] + value;
        best[i][w] = Math.max(without, withItem);
      }
    }
  }

  // Reconstruct by walking the table backwards. An item is in the solution
  // exactly when including it changed the optimum at that capacity.
  const chosen: PlanCandidate[] = [];
  let w = capacity;
  for (let i = n; i > 0; i--) {
    if (best[i][w] !== best[i - 1][w]) {
      const item = items[i - 1];
      chosen.push(item);
      w -= item.minutes;
    }
  }

  return chosen.reverse();
}

/** Stable identity for a PR across repositories. */
function identity(c: PlanCandidate): string {
  return `${c.repo}#${c.number}`;
}

function emptyPlan(budgetMinutes: number): ReviewPlan {
  return {
    budgetMinutes,
    items: [],
    totalMinutes: 0,
    remainingMinutes: budgetMinutes,
    coveredRisk: 0,
    deferred: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Capacity analytics
// ---------------------------------------------------------------------------

/** One row of the capacity panel. */
export interface CapacityRow {
  level: RiskLevel;
  count: number;
  minutes: number;
}

/**
 * Queue load against available capacity.
 *
 * This is the panel that states the thesis numerically: **the queue is
 * arriving faster than it can be served.** Capacity is the reviewer's own
 * stated budget rather than an inferred team roster — a number they control
 * and can vouch for, instead of a fabricated one that collapses under a
 * follow-up question.
 */
export interface CapacityReport {
  rows: CapacityRow[];
  totalMinutes: number;
  capacityMinutes: number;
  /** Positive when the queue exceeds capacity. Zero when it does not. */
  deficitMinutes: number;
  /** Queue minutes as a multiple of capacity, e.g. 1.75. */
  loadFactor: number;
}

const LEVEL_ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

export function capacityReport(
  candidates: PlanCandidate[],
  capacityMinutes: number,
): CapacityReport {
  const rows: CapacityRow[] = LEVEL_ORDER.map((level) => {
    const inLevel = candidates.filter((c) => c.riskLevel === level);
    return {
      level,
      count: inLevel.length,
      minutes: inLevel.reduce((sum, c) => sum + c.minutes, 0),
    };
  }).filter((row) => row.count > 0);

  const totalMinutes = candidates.reduce((sum, c) => sum + c.minutes, 0);
  const capacity = Math.max(0, Math.round(capacityMinutes));

  return {
    rows,
    totalMinutes,
    capacityMinutes: capacity,
    deficitMinutes: Math.max(0, totalMinutes - capacity),
    loadFactor: capacity === 0 ? 0 : round(totalMinutes / capacity, 2),
  };
}
