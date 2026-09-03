/**
 * The effort estimator.
 *
 * Answers "what does this PR cost to review, in minutes of human attention?"
 *
 * Priority ordering alone is not enough to answer *"I have 30 minutes — what
 * should I do?"*. That question needs a cost per item, and the Review Plan
 * solver (Phase 5) is a knapsack over exactly these numbers.
 *
 * The model is a **transparent linear sum**, not a learned one. Every term is
 * a named cost with a stated rationale, so an estimate can be argued with:
 * "24 minutes" decomposes into the same kind of contribution table the risk
 * score does. A regression fitted on hackathon-scale data would be less
 * accurate *and* unexplainable.
 *
 * Like the risk engine, this is pure and deterministic — same signals, same
 * minutes, every run.
 */

import { clamp } from "../math";
import type { PRSignals } from "../signals/types";

/** Fixed cost of opening a PR at all: context switch, orientation. */
const CONTEXT_SWITCH_MINUTES = 3;

/**
 * Minutes per reviewable line.
 *
 * 0.045 min/line ≈ 22 lines per minute, which is careful reading — following
 * control flow and checking edge cases, not skimming. Skim rates of 100+
 * lines/min exist but are not what this system is trying to schedule.
 */
const MINUTES_PER_LINE = 0.045;

/** Per-file orientation cost: imports, structure, "where am I". */
const MINUTES_PER_FILE = 1.2;

/** Critical domains demand slower, more deliberate reading. */
const MINUTES_PER_CRITICAL_DOMAIN = 6;

/** Untested production code must be verified by reasoning alone. */
const NO_TESTS_PENALTY = 4;

/** Each new dependency is a supply-chain question to answer. */
const MINUTES_PER_NEW_DEPENDENCY = 2;

/** Test ratio at or above which tests are considered to *speed up* review. */
const GOOD_TEST_RATIO = 0.5;

/** Discount per 100 reviewable lines when coverage is good. */
const GOOD_TESTS_DISCOUNT_PER_100_LINES = 0.5;

/** Nothing is reviewable in under 2 minutes; nothing is schedulable over 90. */
const MIN_MINUTES = 2;
const MAX_MINUTES = 90;

/** Category weight at or above which a domain counts as critical. */
const CRITICAL_THRESHOLD = 0.7;

/** One named cost in the estimate. */
export interface EffortTerm {
  label: string;
  minutes: number;
}

/** A transparent, auditable effort estimate. */
export interface EffortEstimate {
  /** Final estimate in minutes, integer, clamped to [2, 90]. */
  minutes: number;
  /** Every term that contributed, for the breakdown view. */
  terms: EffortTerm[];
  /** True when the clamp changed the result — the raw sum is then not `minutes`. */
  clamped: boolean;
  /** Human-readable summary, e.g. "~24 min". */
  label: string;
}

/**
 * Estimate review effort for one pull request.
 *
 * Only *reviewable* lines count: generated files (lockfiles, snapshots, build
 * output) are excluded entirely. A 4,000-line lockfile costs a reviewer
 * essentially nothing, and charging 180 minutes for it would wreck any plan
 * built on these numbers.
 *
 * Test files are counted, unlike in the risk engine's blast radius — reading
 * a test still takes time even though it lowers risk.
 */
export function estimateEffort(signals: PRSignals): EffortEstimate {
  const terms: EffortTerm[] = [];

  const reviewableFiles = signals.files.filter((f) => !f.isGenerated);
  const reviewableLines = reviewableFiles.reduce(
    (total, f) => total + f.additions + f.deletions,
    0,
  );

  // Distinct critical domains, not critical files: reading a second auth file
  // is far cheaper than switching from auth to payments.
  const criticalDomains = new Set(
    reviewableFiles
      .filter((f) => f.categoryWeight >= CRITICAL_THRESHOLD && !f.isTest)
      .map((f) => f.category),
  );

  terms.push({ label: "Context switch", minutes: CONTEXT_SWITCH_MINUTES });

  if (reviewableLines > 0) {
    terms.push({
      label: `${reviewableLines} reviewable lines`,
      minutes: MINUTES_PER_LINE * reviewableLines,
    });
  }

  if (reviewableFiles.length > 0) {
    terms.push({
      label: `${reviewableFiles.length} file${reviewableFiles.length === 1 ? "" : "s"}`,
      minutes: MINUTES_PER_FILE * reviewableFiles.length,
    });
  }

  if (criticalDomains.size > 0) {
    terms.push({
      label: `${criticalDomains.size} critical domain${criticalDomains.size === 1 ? "" : "s"} (${[...criticalDomains].join(", ")})`,
      minutes: MINUTES_PER_CRITICAL_DOMAIN * criticalDomains.size,
    });
  }

  if (signals.hasNoTests) {
    terms.push({
      label: "No tests — correctness verified by reading",
      minutes: NO_TESTS_PENALTY,
    });
  }

  if (signals.dependenciesAdded > 0) {
    terms.push({
      label: `${signals.dependenciesAdded} new dependenc${signals.dependenciesAdded === 1 ? "y" : "ies"}`,
      minutes: MINUTES_PER_NEW_DEPENDENCY * signals.dependenciesAdded,
    });
  }

  // Good tests let a reviewer verify intent by reading the tests rather than
  // simulating the code, so they genuinely reduce time. Kept small and
  // proportional — tests never make a large PR free.
  if (signals.testRatio >= GOOD_TEST_RATIO && reviewableLines > 0) {
    terms.push({
      label: "Well tested — verify by reading tests",
      minutes: -GOOD_TESTS_DISCOUNT_PER_100_LINES * (reviewableLines / 100),
    });
  }

  const rawMinutes = terms.reduce((total, t) => total + t.minutes, 0);
  const minutes = Math.round(clamp(rawMinutes, MIN_MINUTES, MAX_MINUTES));
  const clamped = Math.round(rawMinutes) !== minutes;

  return {
    minutes,
    terms: terms.map((t) => ({
      ...t,
      minutes: Math.round(t.minutes * 10) / 10,
    })),
    clamped,
    label: `~${minutes} min`,
  };
}

/** Total minutes for a queue — the "required" half of the capacity deficit. */
export function totalEffort(estimates: EffortEstimate[]): number {
  return estimates.reduce((total, e) => total + e.minutes, 0);
}

/** Format minutes as "1h 35m" / "47 min", for the capacity panel. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
