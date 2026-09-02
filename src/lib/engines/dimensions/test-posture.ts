/**
 * Test posture — is this change defended by tests?
 *
 * Weight: 0.15
 *
 * Tests are the reviewer's proxy for correctness. A well-tested change lets a
 * reviewer verify intent by reading the tests; an untested one forces them to
 * simulate the code in their head. That difference is review *effort*, which
 * is what this system ranks.
 *
 * The scale is tiered rather than continuous because the meaningful
 * distinctions are coarse: "no tests at all" is categorically different from
 * "some tests", and the exact ratio beyond that matters little.
 */

import { clamp } from "../../math";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Ratio tiers: test lines added per production line added. */
const TIERS: Array<{ minRatio: number; score: number; label: string }> = [
  { minRatio: 0.5, score: 0.1, label: "Well covered" },
  { minRatio: 0.25, score: 0.35, label: "Moderately covered" },
  { minRatio: 0.1, score: 0.6, label: "Thin coverage" },
  { minRatio: 0, score: 0.85, label: "Minimal coverage" },
];

export const testPosture: Dimension = {
  id: "test-posture",
  name: "Test posture",
  weight: 0.15,

  evaluate(signals: PRSignals): DimensionOutput {
    const signalsUsed = [
      "testRatio",
      "hasNoTests",
      "testsRemoved",
      "testFilesChanged",
      "productionLinesAdded",
    ];

    // Removing tests alongside new production code is the strongest negative
    // signal available here, and it overrides the ratio entirely.
    if (signals.testsRemoved) {
      const net = signals.testLinesDeleted - signals.testLinesAdded;
      return {
        raw: 1,
        reasons: [
          `Tests removed — ${net} more test line${net === 1 ? "" : "s"} deleted than added`,
          "Production code changed without replacement coverage",
        ],
        signalsUsed,
      };
    }

    // No production code changed: docs, config or test-only PRs have nothing
    // for tests to defend.
    if (signals.productionLinesAdded === 0) {
      if (signals.testFilesChanged > 0) {
        return {
          raw: 0,
          reasons: ["Test-only change"],
          signalsUsed,
        };
      }
      return {
        raw: 0,
        reasons: ["No production code added"],
        signalsUsed,
      };
    }

    if (signals.hasNoTests) {
      return {
        raw: 1,
        reasons: [
          `${signals.productionLinesAdded} lines of production code added with no tests`,
          "Correctness must be verified by reading alone",
        ],
        signalsUsed,
      };
    }

    const ratio = clamp(signals.testRatio, 0, 10);
    const tier =
      TIERS.find((t) => ratio >= t.minRatio) ?? TIERS[TIERS.length - 1];

    const reasons: string[] = [
      `${tier.label} — ${signals.testLinesAdded} test lines for ${signals.productionLinesAdded} production lines`,
    ];

    if (signals.testFilesChanged > 0 && ratio >= 0.5) {
      reasons.push(
        `${signals.testFilesChanged} test file${signals.testFilesChanged === 1 ? "" : "s"} updated alongside the change`,
      );
    }

    return { raw: tier.score, reasons, signalsUsed };
  },
};
