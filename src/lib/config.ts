/**
 * Repository configuration.
 *
 * Path rules, thresholds and policy live in `.pocketreview.yml` rather than in
 * code, because a payments monorepo and a documentation site should not share
 * a risk scale. Everything has a working default, so the file is optional.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { parse } from "yaml";
import { DEFAULT_PATH_RULES, type PathRule } from "./signals/path-rules";
import type { FileCategory } from "./signals/types";

export interface Thresholds {
  low: number;
  medium: number;
  high: number;
}

export interface PolicyConfig {
  /** Maximum risk score still eligible for fast-track. */
  fastTrackMaxRisk: number;
  /** Categories that can never be fast-tracked, whatever the score. */
  neverFastTrack: FileCategory[];
  /** Require green CI before fast-track is offered. */
  requireCiPassing: boolean;
  /** Block fast-track when dependencies changed. */
  blockOnDependencyChange: boolean;
  /** Block fast-track when tests were removed. */
  blockOnTestRemoval: boolean;
}

export interface LLMConfig {
  /** When false, no code ever leaves the process. */
  enabled: boolean;
  /** Character budget for a prioritised diff sent to the model. */
  maxDiffChars: number;
}

export interface PocketReviewConfig {
  rules: PathRule[];
  thresholds: Thresholds;
  policy: PolicyConfig;
  llm: LLMConfig;
  /** History window in days for churn and revert signals. */
  historyWindowDays: number;
}

export const DEFAULT_CONFIG: PocketReviewConfig = {
  rules: DEFAULT_PATH_RULES,
  thresholds: { low: 25, medium: 50, high: 75 },
  policy: {
    fastTrackMaxRisk: 25,
    neverFastTrack: ["auth", "payments", "database"],
    requireCiPassing: true,
    blockOnDependencyChange: true,
    blockOnTestRemoval: true,
  },
  llm: {
    enabled: true,
    maxDiffChars: 12000,
  },
  historyWindowDays: 90,
};

/** Shape of the YAML file, all fields optional. */
interface RawConfig {
  paths?: Array<{
    category: string;
    weight: number;
    patterns: string[];
  }>;
  thresholds?: Partial<Thresholds>;
  policy?: Partial<PolicyConfig>;
  llm?: Partial<LLMConfig>;
  historyWindowDays?: number;
}

/** Every category a path rule may claim. */
const VALID_CATEGORIES: readonly FileCategory[] = [
  "auth",
  "payments",
  "database",
  "infra",
  "api",
  "config",
  "test",
  "docs",
  "ui",
  "generated",
  "other",
] as const;

/**
 * Clamp a configured number into a sane range, falling back on nonsense.
 *
 * `.pocketreview.yml` is hand-written, so a typo (`weight: 10` for `1.0`,
 * `high: "abc"`) is the expected failure — not an attack. Silently accepting
 * it is the dangerous outcome: a weight of 99 breaks the 0..1 contract every
 * dimension assumes and quietly corrupts every score in the queue.
 */
function bounded(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Thresholds must be numeric, in range, and strictly ascending. */
function sanitiseThresholds(raw: Partial<Thresholds> | undefined): Thresholds {
  const d = DEFAULT_CONFIG.thresholds;

  const low = bounded(raw?.low, d.low, 0, 100);
  const medium = bounded(raw?.medium, d.medium, 0, 100);
  const high = bounded(raw?.high, d.high, 0, 100);

  // Out-of-order bands would make `toLevel` return nonsense — a score could be
  // "critical" and "low" at once. Fall back wholesale rather than guess which
  // of the three the author meant.
  return low < medium && medium < high ? { low, medium, high } : d;
}

/** Policy values must be the right type; unknown categories are dropped. */
function sanitisePolicy(raw: Partial<PolicyConfig> | undefined): PolicyConfig {
  const d = DEFAULT_CONFIG.policy;
  const asBool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : fallback;

  return {
    fastTrackMaxRisk: bounded(
      raw?.fastTrackMaxRisk,
      d.fastTrackMaxRisk,
      0,
      100,
    ),
    neverFastTrack: Array.isArray(raw?.neverFastTrack)
      ? raw.neverFastTrack.filter((c): c is FileCategory =>
          VALID_CATEGORIES.includes(c as FileCategory),
        )
      : d.neverFastTrack,
    requireCiPassing: asBool(raw?.requireCiPassing, d.requireCiPassing),
    blockOnDependencyChange: asBool(
      raw?.blockOnDependencyChange,
      d.blockOnDependencyChange,
    ),
    blockOnTestRemoval: asBool(raw?.blockOnTestRemoval, d.blockOnTestRemoval),
  };
}

/** Convert configured entries into validated, case-insensitive path rules. */
function toRules(raw: RawConfig["paths"]): PathRule[] | null {
  if (!raw || raw.length === 0) return null;

  const rules: PathRule[] = [];
  for (const entry of raw) {
    // An unknown category would classify files into a bucket nothing reads,
    // silently removing them from criticality scoring.
    if (!VALID_CATEGORIES.includes(entry?.category as FileCategory)) continue;
    if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) continue;

    try {
      const patterns = entry.patterns
        .filter((p): p is string => typeof p === "string")
        .map((p) => new RegExp(p, "i"));

      if (patterns.length === 0) continue;

      rules.push({
        category: entry.category as FileCategory,
        // Weights outside 0..1 break the contract every dimension relies on.
        weight: bounded(entry.weight, 0.4, 0, 1),
        patterns,
      });
    } catch {
      // Skip an invalid pattern rather than failing the whole config.
    }
  }

  return rules.length > 0 ? rules : null;
}

let cached: PocketReviewConfig | null = null;

/**
 * Load configuration from `.pocketreview.yml`, falling back to defaults.
 *
 * User rules are inserted *after* the built-in generated/test/docs rules and
 * before the remaining domain rules, so a repo can add its own critical paths
 * without restating — or accidentally overriding — the generated-file and test
 * detection that the whole scoring model depends on.
 *
 * Every value is validated on the way in: a hand-written YAML typo must not
 * silently corrupt the scores.
 */
export async function loadConfig(
  cwd = process.cwd(),
): Promise<PocketReviewConfig> {
  if (cached) return cached;

  try {
    const text = await readFile(join(cwd, ".pocketreview.yml"), "utf8");
    const raw = parse(text) as RawConfig | null;

    if (!raw) {
      cached = DEFAULT_CONFIG;
      return cached;
    }

    const userRules = toRules(raw.paths);

    cached = {
      rules: userRules
        ? [
            ...DEFAULT_PATH_RULES.slice(0, 3),
            ...userRules,
            ...DEFAULT_PATH_RULES.slice(3),
          ]
        : DEFAULT_PATH_RULES,
      thresholds: sanitiseThresholds(raw.thresholds),
      policy: sanitisePolicy(raw.policy),
      llm: {
        enabled: raw.llm?.enabled ?? DEFAULT_CONFIG.llm.enabled,
        maxDiffChars: bounded(
          raw.llm?.maxDiffChars,
          DEFAULT_CONFIG.llm.maxDiffChars,
          1_000,
          200_000,
        ),
      },
      historyWindowDays: bounded(
        raw.historyWindowDays,
        DEFAULT_CONFIG.historyWindowDays,
        1,
        3650,
      ),
    };
  } catch {
    // No config file, or unreadable — defaults are a complete configuration.
    cached = DEFAULT_CONFIG;
  }

  return cached;
}

/** Clear the cached config. Used by tests. */
export function resetConfig(): void {
  cached = null;
}

/** True when the app should serve captured fixtures instead of live data. */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
}
