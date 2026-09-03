/**
 * The priority engine.
 *
 * **Risk answers "how much attention does this need?"
 * Priority answers "what should I open right now?"**
 *
 * Conflating those two is the most common mistake in this problem space. A
 * critical PR that is already approved and blocked on failing CI is *not* the
 * thing to open next. A medium-risk PR that is two days old and blocking four
 * other PRs *is*.
 *
 * Pure and deterministic, like every engine here: the same queue produces the
 * same order on every load. **Stability is a feature.** A deck that reshuffles
 * between refreshes is a deck nobody trusts, and it is instantly visible
 * during a demo.
 */

import { clamp, round } from "../math";
import type { PRSignals } from "../signals/types";
import type { RiskAssessment } from "./types";

/**
 * Term weights.
 *
 * The architecture specifies five terms including `reviewerAvailability` at
 * 0.10, which needs the Reviewer Engine (Phase 7). Rather than let a term
 * silently contribute zero — which would cap every score at 0.90 and make the
 * breakdown lie — its weight is redistributed proportionally across the four
 * terms that can be computed today.
 *
 * Phase 7 restores 0.40 / 0.20 / 0.15 / 0.15 and reclaims 0.10 here.
 *
 * **Age carries less than a proportional share, deliberately.** It is the only
 * term every PR accrues for free — needing no risk, no urgency and nothing
 * waiting on it. At a proportional 0.17 the arithmetic inverted the thesis: a
 * week-old typo fix scored 23.7 against 24.2 for a fresh one-line auth change,
 * effectively a tie. A queue where staleness rivals criticality is the exact
 * failure this project exists to fix, and a test now pins it.
 *
 * Moving 0.05 from age to risk — with the raw age cap below — restores the
 * intended ordering with margin, while still letting a stale PR climb ~8
 * points past its equally-boring neighbours. That is all anti-starvation ever
 * needed to do.
 */
export const PRIORITY_WEIGHTS = {
  risk: 0.49, // ← 0.40 in the five-term model
  urgency: 0.22, // ← 0.20
  age: 0.12, // ← 0.15, reduced against risk; see above
  blocking: 0.17, // ← 0.15
} as const;

const WEIGHT_SUM = Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(
    `Priority weights must sum to 1.00, got ${WEIGHT_SUM.toFixed(4)}`,
  );
}

/** Hours at which age decay reaches its ceiling. */
const AGE_CEILING_HOURS = 72;

/** Superlinear exponent — a stale PR surfaces sharply, not gradually. */
const AGE_EXPONENT = 1.5;

/**
 * Ceiling on the age term's raw value.
 *
 * Anti-starvation must not become starvation of its own. Age is uncontested —
 * every PR accrues it for free, without needing to be risky, urgent or
 * blocking — so an unbounded age term lets a week-old typo fix outrank a
 * one-line auth change opened this morning. That inverts the entire thesis.
 *
 * Capping the raw value at 0.7 means age can lift a PR substantially but can
 * never, on its own, beat a genuinely risky one. A stale PR still surfaces:
 * it climbs past its equally-boring neighbours, which is what the term is for.
 */
const AGE_RAW_CEILING = 0.7;

/** Blocked PRs at which blocking impact saturates. */
const BLOCKING_CEILING = 3;

/** Labels that mark genuine urgency, matched case-insensitively. */
const URGENT_LABELS = [
  "incident",
  "p0",
  "sev1",
  "sev0",
  "security",
  "critical",
  "urgent",
  "hotfix",
  "outage",
];

/** Why a PR was suppressed or demoted. */
export type SuppressionReason = "draft" | "approved" | "own-pr" | "ci-failing";

/** One term's contribution to the priority score. */
export interface PriorityTerm {
  id: keyof typeof PRIORITY_WEIGHTS;
  label: string;
  raw: number;
  weight: number;
  contribution: number;
  reason: string;
}

/** The auditable output of the priority engine. */
export interface PriorityScore {
  /** 0..100, integer. Higher means "open this sooner". */
  score: number;
  terms: PriorityTerm[];
  /** Ranked explanation, most significant first. */
  topReasons: string[];
  /** True when this PR should not appear in the deck at all. */
  suppressed: boolean;
  /** Why it was suppressed or demoted. Empty when neither. */
  suppressionReasons: SuppressionReason[];
  /** True when the PR stays visible but is pushed down the queue. */
  demoted: boolean;
}

/**
 * Age decay — the anti-starvation term.
 *
 * A pure risk sort starves low-risk PRs forever: they sit at the bottom of the
 * deck permanently and the team notices within a day. Superlinear growth means
 * a stale PR climbs slowly at first and then sharply, so it eventually
 * surfaces regardless of how unexciting it is.
 *
 * `(hours / 72) ^ 1.5`, then capped at `AGE_RAW_CEILING` so that age can lift
 * a PR but never dominate risk. 72 hours reaches the cap.
 */
export function ageDecay(hours: number): number {
  if (hours <= 0) return 0;
  return clamp(
    Math.pow(hours / AGE_CEILING_HOURS, AGE_EXPONENT),
    0,
    AGE_RAW_CEILING,
  );
}

/** Urgency from labels: incident, P0, security, hotfix. */
function urgencyScore(signals: PRSignals): { raw: number; reason: string } {
  const all = [...signals.labels, ...signals.linkedIssueLabels].map((l) =>
    l.toLowerCase(),
  );

  const matched = URGENT_LABELS.filter((urgent) =>
    all.some((label) => label.includes(urgent)),
  );

  if (signals.isHotfix && !matched.includes("hotfix")) {
    matched.push("hotfix");
  }

  if (matched.length === 0) {
    return { raw: 0, reason: "No urgency labels" };
  }

  // One urgent label is the signal; more do not make it twice as urgent.
  const raw = matched.length === 1 ? 0.7 : 1;
  return {
    raw,
    reason: `Labelled ${matched.slice(0, 3).join(", ")}`,
  };
}

/** Blocking impact — how many other PRs are waiting on this one. */
function blockingScore(
  signals: PRSignals,
  blockedCount: number,
): { raw: number; reason: string } {
  if (blockedCount > 0) {
    return {
      raw: clamp(blockedCount / BLOCKING_CEILING),
      reason: `Blocking ${blockedCount} other PR${blockedCount === 1 ? "" : "s"}`,
    };
  }

  // `isBlockingOthers` is resolved across the queue in collect.ts; when the
  // exact count is unknown, treat the flag as one blocked PR.
  if (signals.isBlockingOthers) {
    return {
      raw: clamp(1 / BLOCKING_CEILING),
      reason: "Other PRs target this branch",
    };
  }

  return { raw: 0, reason: "Nothing waiting on this" };
}

export interface PriorityOptions {
  /**
   * Login of the person triaging. When set, their own PRs are suppressed —
   * you cannot review your own work. Resolved from the token by
   * `getViewerLogin()`; omitted in demo mode.
   */
  viewer?: string;
  /** Exact number of PRs blocked by this one, when known across the queue. */
  blockedCount?: number;
  /** Include drafts rather than suppressing them. */
  includeDrafts?: boolean;
}

/**
 * Score one pull request for queue position.
 *
 * Guarantees, all covered by tests:
 *   - `terms[].contribution` sums to `score`
 *   - the same inputs always produce the same output
 *   - no term contributes more than `weight * 100`
 *   - suppression never depends on the score
 */
export function priorityScore(
  signals: PRSignals,
  risk: RiskAssessment,
  options: PriorityOptions = {},
): PriorityScore {
  const { viewer, blockedCount = 0, includeDrafts = false } = options;

  // --- terms ---
  const urgency = urgencyScore(signals);
  const blocking = blockingScore(signals, blockedCount);
  const age = ageDecay(signals.ageHours);

  const terms: PriorityTerm[] = [
    {
      id: "risk",
      label: "Risk",
      raw: clamp(risk.score / 100),
      weight: PRIORITY_WEIGHTS.risk,
      contribution: 0,
      reason: `Risk ${risk.score}/100 (${risk.level})`,
    },
    {
      id: "urgency",
      label: "Urgency",
      raw: urgency.raw,
      weight: PRIORITY_WEIGHTS.urgency,
      contribution: 0,
      reason: urgency.reason,
    },
    {
      id: "age",
      label: "Age",
      raw: age,
      weight: PRIORITY_WEIGHTS.age,
      contribution: 0,
      reason: describeAge(signals.ageHours),
    },
    {
      id: "blocking",
      label: "Blocking impact",
      raw: blocking.raw,
      weight: PRIORITY_WEIGHTS.blocking,
      contribution: 0,
      reason: blocking.reason,
    },
  ];

  for (const term of terms) {
    term.raw = round(clamp(term.raw), 4);
    term.contribution = round(term.raw * term.weight * 100, 2);
  }

  const score = Math.round(
    clamp(
      terms.reduce((total, t) => total + t.contribution, 0),
      0,
      100,
    ),
  );

  // --- suppression ---
  // Deliberately independent of the score: these are categorical facts about
  // whether the PR belongs in *this* reviewer's deck at all.
  const suppressionReasons: SuppressionReason[] = [];

  if (signals.isDraft && !includeDrafts) suppressionReasons.push("draft");

  // An approval is only spent if nothing has been pushed since. `reviewRounds`
  // cannot tell us that, so we take the conservative reading: approved means
  // handled.
  if (signals.reviewState === "approved" && signals.existingApprovals > 0) {
    suppressionReasons.push("approved");
  }

  if (viewer && signals.author.toLowerCase() === viewer.toLowerCase()) {
    suppressionReasons.push("own-pr");
  }

  // Failing CI demotes rather than hides: the author is still iterating, but
  // the PR has not gone away.
  //
  // Critical PRs are exempt. Demotion assumes "the author will push again, so
  // don't spend attention yet" — that reasoning holds for a routine change and
  // fails badly for a critical one. A payments rewrite with red CI is still
  // the most important thing in the queue, and burying it under six trivial
  // PRs is precisely the misallocation this system exists to prevent.
  const demoted = signals.ciStatus === "failing" && risk.level !== "critical";
  if (signals.ciStatus === "failing") suppressionReasons.push("ci-failing");

  const suppressed = suppressionReasons.some((r) => r !== "ci-failing");

  const topReasons = terms
    .filter((t) => t.contribution > 0.5)
    .sort((a, b) => b.contribution - a.contribution)
    .map((t) => t.reason);

  return {
    score,
    terms,
    topReasons: topReasons.length > 0 ? topReasons : ["No priority signals"],
    suppressed,
    suppressionReasons,
    demoted,
  };
}

/** Readable age, used as the age term's reason. */
function describeAge(hours: number): string {
  if (hours < 1) return "Opened just now";
  if (hours < 24) return `Open ${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return `Open ${days} day${days === 1 ? "" : "s"}`;
}

/** A PR carrying everything the queue sort needs. */
export interface Prioritisable {
  priority: PriorityScore;
  /** Used only as a deterministic tiebreak. */
  number: number;
}

/**
 * Order a queue for the deck.
 *
 * Sorted by priority, with demoted PRs pushed below everything else, and PR
 * number as the final tiebreak so the order is **total and stable** — the same
 * queue is identical on every load, with no reliance on the input order or on
 * a non-stable sort.
 */
export function rankQueue<T extends Prioritisable>(prs: T[]): T[] {
  return [...prs].sort((a, b) => {
    if (a.priority.demoted !== b.priority.demoted) {
      return a.priority.demoted ? 1 : -1;
    }
    if (b.priority.score !== a.priority.score) {
      return b.priority.score - a.priority.score;
    }
    // Deterministic tiebreak: older PR (lower number) first.
    return a.number - b.number;
  });
}
