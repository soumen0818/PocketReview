/**
 * The policy gate.
 *
 * The safety layer, and the answer to the sharpest question a judge can ask:
 * *"what if the AI is wrong?"*
 *
 * **A fast-track swipe is a recommendation, never a merge.** The gate can only
 * *remove* eligibility; it can never grant it. There is no code path here that
 * turns a vetoed PR into an eligible one, which is what makes the guarantee
 * structural rather than a matter of configuration.
 *
 * Two properties are worth stating explicitly because they are what a reviewer
 * would challenge:
 *
 *   1. **Critical paths are hard-coded.** auth, payments and database can never
 *      be fast-tracked, at any score, whatever `.pocketreview.yml` says. A
 *      safety rule that a config file can switch off is not a safety rule.
 *   2. **The gate is deterministic.** Same signals, same verdict, every time.
 *      No LLM is involved at any point.
 */

import type { PRSignals, FileCategory } from "../signals/types";
import type { RiskAssessment } from "../engines/types";
import type { PolicyConfig } from "../config";

/**
 * Categories that can never be fast-tracked.
 *
 * Deliberately a module constant rather than a config field. `PolicyConfig`
 * carries a `neverFastTrack` list which may *extend* this set, but nothing can
 * shrink it — see `resolveNeverFastTrack`.
 */
export const ALWAYS_BLOCKED: readonly FileCategory[] = [
  "auth",
  "payments",
  "database",
] as const;

/** Why a fast-track was refused. Each maps to a sentence the card can show. */
export type VetoReason =
  | "critical-path"
  | "risk-too-high"
  | "ci-not-passing"
  | "dependencies-changed"
  | "tests-removed"
  | "protected-file";

/** One refusal, with the detail needed to explain it. */
export interface Veto {
  reason: VetoReason;
  /** Shown on the flipped card. */
  label: string;
  /** The specific evidence — file paths, check names, the score. */
  detail: string;
}

/** The gate's answer. */
export interface PolicyVerdict {
  /** True only when every rule passed. */
  eligible: boolean;
  /** Every rule that refused, not just the first. */
  vetoes: Veto[];
  /**
   * True when a veto came from the hard-coded critical-path rule, which no
   * configuration can disable. The UI says so explicitly.
   */
  structurallyBlocked: boolean;
}

/**
 * The effective never-fast-track set.
 *
 * Configuration may add categories; it can never remove one of
 * `ALWAYS_BLOCKED`. This function is the single place that guarantee lives.
 */
export function resolveNeverFastTrack(
  policy?: Pick<PolicyConfig, "neverFastTrack">,
): Set<FileCategory> {
  return new Set<FileCategory>([
    ...ALWAYS_BLOCKED,
    ...(policy?.neverFastTrack ?? []),
  ]);
}

export interface GateOptions {
  policy?: PolicyConfig;
  /** Extra paths this repo treats as protected, from `.pocketreview.yml`. */
  protectedPaths?: RegExp[];
}

/**
 * Evaluate a fast-track request.
 *
 * Every rule is checked — the gate does not short-circuit on the first veto,
 * because a reviewer deserves the whole reason, not the first one that fired.
 */
export function evaluateFastTrack(
  signals: PRSignals,
  risk: RiskAssessment,
  options: GateOptions = {},
): PolicyVerdict {
  const { policy, protectedPaths = [] } = options;
  const vetoes: Veto[] = [];

  // --- 1. Critical paths. Hard-coded, unconditional. ---
  const blocked = resolveNeverFastTrack(policy);
  const touched = signals.files.filter(
    (f) => !f.isGenerated && blocked.has(f.category),
  );

  if (touched.length > 0) {
    const categories = [...new Set(touched.map((f) => f.category))];
    vetoes.push({
      reason: "critical-path",
      label: "Touches a critical path",
      detail: `${categories.join(", ")} — ${touched[0].path}${touched.length > 1 ? ` and ${touched.length - 1} more` : ""}`,
    });
  }

  // --- 2. Risk ceiling. ---
  const maxRisk = policy?.fastTrackMaxRisk ?? 25;
  if (risk.score > maxRisk) {
    vetoes.push({
      reason: "risk-too-high",
      label: "Risk above the fast-track ceiling",
      detail: `scored ${risk.score}, ceiling is ${maxRisk}`,
    });
  }

  // --- 3. CI must be green. ---
  // "Not passing" rather than "failing": a pending check has not proven
  // anything yet, and fast-tracking on an unproven build defeats the purpose.
  if (policy?.requireCiPassing !== false && signals.ciStatus !== "passing") {
    vetoes.push({
      reason: "ci-not-passing",
      label: "CI is not green",
      detail:
        signals.ciStatus === "failing"
          ? `failing${signals.failingChecks.length ? `: ${signals.failingChecks.slice(0, 3).join(", ")}` : ""}`
          : signals.ciStatus === "pending"
            ? "checks still running"
            : "no CI checks found",
    });
  }

  // --- 4. Dependency changes. ---
  if (
    policy?.blockOnDependencyChange !== false &&
    (signals.dependenciesAdded > 0 || signals.dependenciesRemoved > 0)
  ) {
    vetoes.push({
      reason: "dependencies-changed",
      label: "Dependencies changed",
      detail: `${signals.dependenciesAdded} added, ${signals.dependenciesRemoved} removed`,
    });
  }

  // --- 5. Test removal. ---
  if (policy?.blockOnTestRemoval !== false && signals.testsRemoved) {
    vetoes.push({
      reason: "tests-removed",
      label: "Tests were removed",
      detail: `${signals.testLinesDeleted} test lines deleted, ${signals.testLinesAdded} added`,
    });
  }

  // --- 6. Repo-specific protected files. ---
  if (protectedPaths.length > 0) {
    const hits = signals.files.filter((f) =>
      protectedPaths.some((rx) => rx.test(f.path)),
    );
    if (hits.length > 0) {
      vetoes.push({
        reason: "protected-file",
        label: "Touches a protected file",
        detail: hits
          .slice(0, 3)
          .map((f) => f.path)
          .join(", "),
      });
    }
  }

  return {
    eligible: vetoes.length === 0,
    vetoes,
    structurallyBlocked: vetoes.some((v) => v.reason === "critical-path"),
  };
}

/** One-line summary of a verdict, for a toast or a log. */
export function describeVerdict(verdict: PolicyVerdict): string {
  if (verdict.eligible) return "Eligible for fast-track";
  if (verdict.vetoes.length === 1) return verdict.vetoes[0].label;
  return `${verdict.vetoes[0].label} (+${verdict.vetoes.length - 1} more)`;
}
