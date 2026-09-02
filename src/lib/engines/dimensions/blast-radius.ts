/**
 * Blast radius — how much surface area does this change touch?
 *
 * Weight: 0.20
 *
 * This is the dimension a naive scorer would use on its own. Here it is one of
 * seven, deliberately: size correlates with review effort but not with review
 * *urgency*, and treating the two as the same thing is what makes size-based
 * tools rank a 4,000-line lockfile above a one-line auth change.
 *
 * Generated files are excluded from every term. Test files are excluded from
 * the file-count and volume terms — a PR that is mostly tests is large but not
 * broad.
 */

import { clamp, saturate } from "../../math";
import { CATEGORY_LABELS } from "../../signals/path-rules";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Files at which the file-spread term saturates. */
const FILE_KNEE = 12;

/** Lines at which the volume term saturates. */
const LINE_KNEE = 500;

/** Distinct subsystems at which the cross-cutting term maxes out. */
const CATEGORY_CEILING = 5;

export const blastRadius: Dimension = {
  id: "blast-radius",
  name: "Blast radius",
  weight: 0.2,

  evaluate(signals: PRSignals): DimensionOutput {
    const reasons: string[] = [];

    // Reviewable files: what a human actually has to read.
    const reviewable = signals.files.filter((f) => !f.isGenerated && !f.isTest);
    const reviewableLines = reviewable.reduce(
      (total, f) => total + f.additions + f.deletions,
      0,
    );

    // A PR with nothing but generated or test files has no blast radius.
    if (reviewable.length === 0) {
      const only = signals.files.every((f) => f.isGenerated)
        ? "generated files"
        : "test files";
      return {
        raw: 0,
        reasons: [`Touches ${only} only`],
        signalsUsed: ["files"],
      };
    }

    const fileSpread = saturate(reviewable.length, FILE_KNEE);
    const volume = saturate(reviewableLines, LINE_KNEE);
    const spread = clamp(signals.diffEntropy);
    const crossCut = clamp(signals.distinctCategories / CATEGORY_CEILING);

    const raw = clamp(
      0.35 * fileSpread + 0.35 * volume + 0.15 * spread + 0.15 * crossCut,
    );

    // Reasons are ordered by how much they moved the result, so the card can
    // show the top few and still be telling the truth.
    if (reviewable.length >= FILE_KNEE) {
      reasons.push(`${reviewable.length} files changed`);
    } else if (reviewable.length >= 5) {
      reasons.push(`${reviewable.length} files across the codebase`);
    }

    if (reviewableLines >= LINE_KNEE) {
      reasons.push(`${reviewableLines} lines to read`);
    } else if (reviewableLines >= 150) {
      reasons.push(`${reviewableLines} lines changed`);
    }

    if (signals.distinctCategories >= 3) {
      const subsystems = [
        ...new Set(reviewable.map((f) => CATEGORY_LABELS[f.category])),
      ].slice(0, 4);
      reasons.push(`Spans ${subsystems.join(", ")}`);
    }

    if (spread > 0.8 && reviewable.length >= 4) {
      reasons.push("Changes scattered evenly across files");
    }

    if (
      signals.largestFileChange > 0 &&
      signals.largestFileChange >= reviewableLines * 0.8 &&
      reviewable.length > 1
    ) {
      reasons.push("Concentrated in a single file");
    }

    if (reasons.length === 0) {
      reasons.push(
        `Small change — ${reviewable.length} file${reviewable.length === 1 ? "" : "s"}, ${reviewableLines} lines`,
      );
    }

    return {
      raw,
      reasons,
      signalsUsed: [
        "files",
        "diffEntropy",
        "distinctCategories",
        "largestFileChange",
      ],
    };
  },
};
