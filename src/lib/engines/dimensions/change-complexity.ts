/**
 * Change complexity — how hard is this diff to hold in your head?
 *
 * Weight: 0.12
 *
 * Structural and language-agnostic by design. Parsing per-language ASTs would
 * be more precise, but a triage system has to produce a usable ranking on a
 * TypeScript repo, a Go repo and a Python repo without per-language support.
 * Breadth beats precision here.
 *
 * The signals are: added branching, deepened nesting, new functions, and
 * deletion-heavy changes. That last one is counterintuitive but real —
 * removed logic is under-reviewed, because a reader can see what was added
 * far more easily than they can reason about the absence of what was removed.
 */

import { clamp, saturate } from "../../math";
import { analyseComplexity } from "../../signals/diff";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Net control-flow additions at which that term saturates. */
const CONTROL_FLOW_KNEE = 12;

/** New functions at which that term saturates. */
const FUNCTION_KNEE = 8;

/** Indent levels at which nesting is considered deep. */
const NESTING_KNEE = 4;

export const changeComplexity: Dimension = {
  id: "change-complexity",
  name: "Change complexity",
  weight: 0.12,

  evaluate(signals: PRSignals): DimensionOutput {
    const signalsUsed = ["files", "availability.patches"];

    // Patches are what this dimension reads; without them there is nothing to
    // analyse. Fall back to a mild size proxy rather than claiming zero.
    const analysable = signals.files.filter(
      (f) => !f.isGenerated && !f.isTest && f.patch,
    );

    if (analysable.length === 0) {
      if (!signals.availability.patches) {
        const lines = signals.additions + signals.deletions;
        return {
          raw: clamp(saturate(lines, 800) * 0.5),
          reasons: ["Diff content unavailable — complexity estimated by size"],
          signalsUsed,
        };
      }
      return {
        raw: 0,
        reasons: ["No production code to analyse"],
        signalsUsed,
      };
    }

    let controlFlowDelta = 0;
    let functionsAdded = 0;
    let maxNesting = 0;
    let deletionHeavyFiles = 0;

    for (const file of analysable) {
      const result = analyseComplexity(file.patch!);
      controlFlowDelta += result.controlFlowDelta;
      functionsAdded += result.functionsAdded;
      maxNesting = Math.max(maxNesting, result.maxNestingAdded);
      if (result.deletionHeavy) deletionHeavyFiles++;
    }

    const branching = saturate(
      Math.max(0, controlFlowDelta),
      CONTROL_FLOW_KNEE,
    );
    const functions = saturate(functionsAdded, FUNCTION_KNEE);
    const nesting = clamp(maxNesting / NESTING_KNEE);
    const deletions = clamp(
      deletionHeavyFiles / Math.max(1, analysable.length),
    );

    const raw = clamp(
      0.35 * branching + 0.2 * functions + 0.2 * nesting + 0.25 * deletions,
    );

    const reasons: string[] = [];

    if (controlFlowDelta >= CONTROL_FLOW_KNEE) {
      reasons.push(`${controlFlowDelta} new branches or conditions`);
    } else if (controlFlowDelta > 0) {
      reasons.push(
        `Adds ${controlFlowDelta} branch point${controlFlowDelta === 1 ? "" : "s"}`,
      );
    } else if (controlFlowDelta < 0) {
      reasons.push(
        `Removes ${-controlFlowDelta} branch point${controlFlowDelta === -1 ? "" : "s"} — simplification`,
      );
    }

    if (deletionHeavyFiles > 0) {
      reasons.push(
        `${deletionHeavyFiles} file${deletionHeavyFiles === 1 ? "" : "s"} mostly deletions — removed logic is easy to under-review`,
      );
    }

    if (maxNesting >= NESTING_KNEE) {
      reasons.push(`Deeply nested code added (${maxNesting} levels)`);
    }

    if (functionsAdded >= FUNCTION_KNEE) {
      reasons.push(`${functionsAdded} new functions introduced`);
    }

    if (reasons.length === 0) {
      reasons.push("Structurally simple change");
    }

    return { raw, reasons, signalsUsed };
  },
};
