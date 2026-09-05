/**
 * The risk engine.
 *
 * Combines seven weighted dimensions into a single 0..100 score, applies
 * bounded modifiers, and reports how confident it is given what could actually
 * be measured.
 *
 * The engine is **pure and deterministic**: the same `PRSignals` always yields
 * the same `RiskAssessment`, byte for byte. No LLM is involved at any point.
 * That is what makes "why 87?" answerable — the answer is a table of
 * contributions that sums to 87.
 *
 * Definition of risk used here: *the probability this PR needs careful human
 * attention* — not the probability it contains a bug. That distinction is
 * deliberate. Predicting bugs is unsolved; ranking by required attention is
 * both tractable and closer to the actual bottleneck.
 */

import { clamp, round } from "../math";
import { signalConfidence, type PRSignals } from "../signals/types";
import { DEFAULT_CONFIG, type Thresholds } from "../config";
import {
  MODIFIER_CAP,
  LOW_CONFIDENCE_THRESHOLD,
  type Dimension,
  type DimensionResult,
  type Modifier,
  type RiskAssessment,
  type RiskLevel,
} from "./types";

import { blastRadius } from "./dimensions/blast-radius";
import { domainCriticality } from "./dimensions/domain-criticality";
import { testPosture } from "./dimensions/test-posture";
import { historicalInstability } from "./dimensions/historical-instability";
import { changeComplexity } from "./dimensions/change-complexity";
import { dependencies } from "./dimensions/dependencies";
import { authorProvenance } from "./dimensions/author-provenance";

/**
 * The seven dimensions, in fixed display order.
 *
 * Weights sum to 1.00. This is asserted at module load so a mistaken edit
 * fails immediately rather than silently skewing every score.
 */
export const DIMENSIONS: Dimension[] = [
  blastRadius, // 0.20
  domainCriticality, // 0.20
  testPosture, // 0.15
  historicalInstability, // 0.15
  changeComplexity, // 0.12
  dependencies, // 0.10
  authorProvenance, // 0.08
];

const WEIGHT_SUM = DIMENSIONS.reduce((total, d) => total + d.weight, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(
    `Risk dimension weights must sum to 1.00, got ${WEIGHT_SUM.toFixed(4)}`,
  );
}

/**
 * Conditions that adjust the score after the weighted sum.
 *
 * Modifiers exist for facts that are not matters of degree: CI either fails or
 * it does not. Each is bounded, every one that fires is reported, and their
 * aggregate is capped at ±MODIFIER_CAP so no combination can overwhelm the
 * dimensional score.
 */
interface ModifierRule {
  id: string;
  label: string;
  delta: number;
  applies(signals: PRSignals): boolean;
}

export const MODIFIER_RULES: ModifierRule[] = [
  {
    id: "ci-failing",
    label: "CI is failing",
    delta: 8,
    applies: (s) => s.ciStatus === "failing",
  },
  {
    id: "hotfix-branch",
    label: "Targets a release or hotfix branch",
    delta: 10,
    applies: (s) => s.isHotfix,
  },
  {
    id: "urgent-label",
    label: "Labelled as an incident or security issue",
    delta: 6,
    applies: (s) => s.linkedIssueLabels.length > 0,
  },
  {
    id: "already-approved",
    label: "Already approved by a reviewer",
    delta: -15,
    applies: (s) => s.reviewState === "approved" && s.existingApprovals > 0,
  },
  {
    id: "draft",
    label: "Draft — author is still working",
    delta: -20,
    applies: (s) => s.isDraft,
  },
  {
    id: "generated-only",
    label: "Generated files only",
    delta: -25,
    applies: (s) => s.files.length > 0 && s.files.every((f) => f.isGenerated),
  },
  {
    id: "docs-only",
    label: "Documentation only",
    delta: -30,
    applies: (s) =>
      s.files.length > 0 &&
      s.files.every((f) => f.category === "docs" || f.isGenerated),
  },
];

/**
 * Floors applied after modifiers.
 *
 * A weighted sum averages, and averaging is wrong for categorical facts. A
 * one-line change to authentication is not "20% of a risky PR" — it is a
 * change that a human must look at, full stop. With six of seven dimensions
 * structurally near-zero for a tiny diff, the weighted sum alone caps such a
 * PR at roughly 35/100 and buries it in the queue.
 *
 * A floor fixes this without distorting anything else: it can only raise a
 * score, it is bounded, and the reason is reported alongside it. Raising the
 * criticality weight instead would inflate every large PR that happens to
 * touch a critical directory, which is a worse trade.
 *
 * Floors are deliberately set at band boundaries: "this must be at least
 * `high`" is a statement a reviewer can argue with, which is the point.
 */
interface FloorRule {
  id: string;
  label: string;
  floor: number;
  applies(signals: PRSignals): boolean;
}

/**
 * Categories a floor may fire on.
 *
 * **Not the same thing as `signals.criticalPaths`,** and the difference is the
 * point. That list is every path at category weight ≥ 0.7, which also catches
 * `infra` (0.75) and `api` (0.70) — useful for explanation text, far too broad
 * to force a score to 55.
 *
 * Using it here produced a real misfire: a Dependabot bump of
 * `actions/checkout` from v6 to v7 — four one-line edits under
 * `.github/workflows/` — floored to 55 and rendered the reason *"Critical-path
 * change with no test coverage"*. A workflow file has no tests by definition,
 * so the untested floor fired automatically, and the label named auth, payments
 * and database, none of which the PR went near.
 *
 * These three categories match `ALWAYS_BLOCKED` in the policy gate exactly. One
 * definition of "critical path" across the system, so a floor label and a
 * fast-track veto can never disagree about what the phrase means.
 */
const FLOOR_CRITICAL_CATEGORIES: ReadonlySet<string> = new Set([
  "auth",
  "payments",
  "database",
]);

/** Paths that justify a floor — the narrow reading, not the weight threshold. */
function floorCriticalPaths(signals: PRSignals): string[] {
  return signals.files
    .filter((f) => !f.isGenerated && FLOOR_CRITICAL_CATEGORIES.has(f.category))
    .map((f) => f.path);
}

export const FLOOR_RULES: FloorRule[] = [
  {
    id: "critical-path-untested",
    label: "Critical-path change with no test coverage",
    floor: 55,
    applies: (s) =>
      floorCriticalPaths(s).length > 0 && (s.hasNoTests || s.testsRemoved),
  },
  {
    id: "critical-path",
    label: "Touches a critical path (auth, payments or database)",
    floor: 40,
    applies: (s) => floorCriticalPaths(s).length > 0,
  },
  {
    id: "tests-removed",
    label: "Tests removed alongside production changes",
    floor: 35,
    applies: (s) => s.testsRemoved,
  },
];

/**
 * Highest applicable floor, and the rules that set it.
 *
 * Floors never apply to drafts or already-approved PRs: both are explicitly
 * outside the "needs attention now" question this score answers.
 */
function resolveFloor(signals: PRSignals): {
  floor: number;
  applied: FloorRule[];
} {
  if (signals.isDraft || signals.reviewState === "approved") {
    return { floor: 0, applied: [] };
  }

  const applied = FLOOR_RULES.filter((rule) => rule.applies(signals));
  const floor = applied.reduce((max, rule) => Math.max(max, rule.floor), 0);
  return { floor, applied };
}

/** Map a score onto a band using the configured thresholds. */
export function toLevel(score: number, thresholds: Thresholds): RiskLevel {
  if (score >= thresholds.high) return "critical";
  if (score >= thresholds.medium) return "high";
  if (score >= thresholds.low) return "medium";
  return "low";
}

export interface AssessOptions {
  thresholds?: Thresholds;
}

/**
 * Score a pull request.
 *
 * Guarantees, all covered by tests:
 *   - `dimensions[].contribution` sums to `baseScore`
 *   - `baseScore + modifierDelta`, clamped to [0,100], equals `score`
 *   - the same input always produces the same output
 *   - no dimension can contribute more than `weight * 100` points
 */
export function assessRisk(
  signals: PRSignals,
  options: AssessOptions = {},
): RiskAssessment {
  const thresholds = options.thresholds ?? DEFAULT_CONFIG.thresholds;

  // --- dimensions ---
  const dimensions: DimensionResult[] = DIMENSIONS.map((dimension) => {
    const output = dimension.evaluate(signals);
    // Clamp defensively: a dimension returning out-of-range breaks the
    // sum-to-score guarantee, and that guarantee is the product.
    const raw = clamp(output.raw);
    return {
      id: dimension.id,
      name: dimension.name,
      raw: round(raw, 4),
      weight: dimension.weight,
      contribution: round(raw * dimension.weight * 100, 2),
      reasons: output.reasons,
      signalsUsed: output.signalsUsed,
    };
  });

  const baseScore = round(
    dimensions.reduce((total, d) => total + d.contribution, 0),
    2,
  );

  // --- modifiers ---
  const modifiers: Modifier[] = MODIFIER_RULES.filter((rule) =>
    rule.applies(signals),
  ).map((rule) => ({ id: rule.id, label: rule.label, delta: rule.delta }));

  const rawDelta = modifiers.reduce((total, m) => total + m.delta, 0);
  const modifierDelta = clamp(rawDelta, -MODIFIER_CAP, MODIFIER_CAP);

  const scored = clamp(baseScore + modifierDelta, 0, 100);

  // --- floors ---
  // A floor can only raise a score, never lower it, and only for categorical
  // facts a weighted average would otherwise dilute.
  const { floor, applied } = resolveFloor(signals);
  const floorApplied = floor > scored;
  const score = Math.round(Math.max(scored, floor));

  // --- reasons ---
  // Ranked by the points each dimension actually put on the board, so the
  // card's "top reasons" genuinely are the top reasons.
  //
  // **Breadth before depth.** Taking two reasons per dimension filled the card
  // with near-duplicates — "392 lines added with no tests" followed by
  // "correctness must be verified by reading alone" — and pushed distinct
  // evidence from other dimensions off the visible list. On the payments
  // fixture that cost the single most useful line on the card:
  // *"settlement.ts was reverted 3 times recently"*.
  //
  // So one reason per dimension comes first, in contribution order, and any
  // remaining slots are backfilled with the seconds.
  // A dimension can score points and still have nothing worrying to say —
  // historical instability reports "no recent instability in the files
  // touched" while contributing a baseline amount. True, but it is reassurance
  // occupying a slot on a card whose whole job is to explain risk, so it is
  // held back for the breakdown screen.
  const REASSURING =
    /^(No recent instability|No significant|Well covered|Test-only change|No production code)/i;

  const contributing = dimensions
    .filter((d) => d.contribution > 0.5 && d.reasons.length > 0)
    .sort((a, b) => b.contribution - a.contribution);

  const concerning = (reason: string) => !REASSURING.test(reason);

  const dimensionReasons = [
    ...contributing.map((d) => d.reasons[0]),
    ...contributing.flatMap((d) => d.reasons.slice(1, 2)),
  ].filter(concerning);

  // When a floor decided the score, say so first — otherwise the number and
  // the stated reasons would not add up, which is exactly the opacity this
  // engine exists to avoid.
  //
  // Only the *highest* floor is named, though. Listing every floor that fired
  // put two near-identical lines at the top ("Critical-path change with no
  // test coverage" and "Touches a critical path") and pushed the concrete
  // evidence — *"settlement.ts was reverted 3 times recently"* — off the card
  // entirely. The generic label explains the number; the specific one is what
  // a reviewer actually acts on, so it must not be the thing that gets cut.
  const highestFloor = applied.reduce<FloorRule | null>(
    (best, rule) => (best === null || rule.floor > best.floor ? rule : best),
    null,
  );

  const ranked = (
    floorApplied && highestFloor
      ? [highestFloor.label, ...dimensionReasons]
      : dimensionReasons
  ).slice(0, 5);

  // A genuinely unremarkable PR has nothing concerning to say. Falling back to
  // the reassuring lines is better than an empty "why this score" panel.
  const topReasons =
    ranked.length > 0
      ? ranked
      : contributing.flatMap((d) => d.reasons.slice(0, 1)).slice(0, 5);

  // --- confidence ---
  const confidence = round(signalConfidence(signals.availability), 3);

  return {
    score,
    level: toLevel(score, thresholds),
    baseScore,
    modifierDelta,
    floor: floorApplied ? floor : null,
    floorReasons: floorApplied ? applied.map((r) => r.label) : [],
    dimensions,
    modifiers,
    topReasons:
      topReasons.length > 0 ? topReasons : ["No significant risk signals"],
    confidence,
    lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
  };
}

/**
 * Baseline scorer: risk purely as a function of lines changed.
 *
 * This exists to be beaten. The evaluation harness compares the real engine
 * against it, and the gap is the headline number — it is what turns "we built
 * a scoring system" into "our scoring system beats the naive approach by N
 * points of recall".
 */
export function baselineScore(signals: PRSignals): number {
  const lines = signals.additions + signals.deletions;
  // Saturating at 1000 lines keeps the baseline on the same 0..100 scale.
  return Math.round(clamp(lines / 1000) * 100);
}
