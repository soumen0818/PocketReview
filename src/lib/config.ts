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

/** Convert configured string patterns into case-insensitive regexes. */
function toRules(raw: RawConfig["paths"]): PathRule[] | null {
  if (!raw || raw.length === 0) return null;

  const rules: PathRule[] = [];
  for (const entry of raw) {
    try {
      rules.push({
        category: entry.category as FileCategory,
        weight: entry.weight,
        patterns: entry.patterns.map((p) => new RegExp(p, "i")),
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
 * User rules are prepended to the defaults rather than replacing them, so a
 * repo can add its own critical paths without having to restate the built-in
 * generated-file and test detection.
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
        ? [...DEFAULT_PATH_RULES.slice(0, 3), ...userRules, ...DEFAULT_PATH_RULES.slice(3)]
        : DEFAULT_PATH_RULES,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...raw.thresholds },
      policy: { ...DEFAULT_CONFIG.policy, ...raw.policy },
      llm: { ...DEFAULT_CONFIG.llm, ...raw.llm },
      historyWindowDays:
        raw.historyWindowDays ?? DEFAULT_CONFIG.historyWindowDays,
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
