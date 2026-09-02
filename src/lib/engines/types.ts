/**
 * Scoring engine contracts.
 *
 * The central guarantee of this layer: a `RiskAssessment` is fully auditable.
 * Its `dimensions` carry contributions that sum to `baseScore`, its `modifiers`
 * account for the remaining delta, and `baseScore + modifierDelta` clamps to
 * `score`. Nothing is hidden and nothing is generated — the number is
 * arithmetic over measured signals, reproducible on every run.
 *
 * This is what makes "why 87?" answerable.
 */

import type { PRSignals } from "../signals/types";

/** Risk bands. Thresholds are configurable per repository. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * One dimension's contribution to the score.
 *
 * `raw` is the dimension's own 0..1 assessment; `contribution` is
 * `raw * weight * 100`, i.e. the points this dimension put on the board.
 */
export interface DimensionResult {
  /** Stable identifier, used by the UI and tests. */
  id: DimensionId;
  /** Display name. */
  name: string;
  /** The dimension's own assessment, 0..1. */
  raw: number;
  /** Fixed weight from the dimension table. */
  weight: number;
  /** Points contributed to the base score: raw * weight * 100. */
  contribution: number;
  /** Why this dimension scored as it did, ranked most significant first. */
  reasons: string[];
  /** Which `PRSignals` fields this dimension read. Powers the audit view. */
  signalsUsed: string[];
}

export type DimensionId =
  | "blast-radius"
  | "domain-criticality"
  | "test-posture"
  | "historical-instability"
  | "change-complexity"
  | "dependencies"
  | "author-provenance";

/**
 * A bounded adjustment applied after the weighted sum.
 *
 * Modifiers exist for conditions that are not a matter of degree — CI is
 * either failing or it is not. They are capped in aggregate so that no
 * combination of them can dominate the dimensional score.
 */
export interface Modifier {
  id: string;
  label: string;
  /** Points added or removed. */
  delta: number;
}

/** The complete, auditable output of the risk engine. */
export interface RiskAssessment {
  /** Final score, 0..100, integer. */
  score: number;
  level: RiskLevel;
  /** Weighted sum of dimensions before modifiers, 0..100. */
  baseScore: number;
  /** Net points from modifiers, after the aggregate cap. */
  modifierDelta: number;
  /**
   * The floor that decided this score, or null when the weighted sum stood on
   * its own. A floor raises a score for a categorical fact that averaging
   * would otherwise dilute — a one-line auth change being the canonical case.
   */
  floor: number | null;
  /** Why the floor applied. Empty unless `floor` is set. */
  floorReasons: string[];
  /** Always all seven, in fixed order. */
  dimensions: DimensionResult[];
  /** Only modifiers that actually fired. */
  modifiers: Modifier[];
  /** Top reasons across all dimensions, ranked by contribution. */
  topReasons: string[];
  /** 0..1 — how much of the signal set was actually available. */
  confidence: number;
  /** True when confidence is low enough that the UI should say so. */
  lowConfidence: boolean;
}

/**
 * A dimension is a pure function from signals to a 0..1 assessment.
 *
 * Purity is not stylistic here: it is what makes the score reproducible and
 * unit-testable without a network.
 */
export interface Dimension {
  id: DimensionId;
  name: string;
  weight: number;
  evaluate(signals: PRSignals): DimensionOutput;
}

/** What a dimension returns before weighting. */
export interface DimensionOutput {
  /** 0..1. Values outside the range are clamped by the orchestrator. */
  raw: number;
  reasons: string[];
  signalsUsed: string[];
}

/** Maximum total points modifiers may move the score, in either direction. */
export const MODIFIER_CAP = 30;

/** Confidence below which the UI should warn that signals were limited. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
