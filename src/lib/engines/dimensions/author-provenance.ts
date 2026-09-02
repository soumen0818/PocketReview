/**
 * Author and provenance.
 *
 * Weight: 0.08 — the lowest, deliberately.
 *
 * This is where AI authorship enters the score, and the weighting is the
 * argument. At 0.08 weight and a 0.4 maximum contribution from the AI term,
 * provenance can move a score by roughly **three points out of a hundred**.
 *
 * PocketReview is source-agnostic. We do not claim AI-written code is worse.
 * We observe that AI-authored PRs have different *review characteristics* —
 * larger, more numerous, thinner descriptions — and those are already measured
 * by blast radius, test posture and complexity. Provenance is a small
 * corroborating nudge, never a verdict.
 *
 * That distinction is what makes the system defensible when someone asks
 * "so what about human-written PRs?" The answer: they are scored identically,
 * because six of the seven dimensions never look at who wrote the code.
 */

import { clamp } from "../../math";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Revert rate above which an author's history is treated as a signal. */
const REVERT_THRESHOLD = 0.15;

export const authorProvenance: Dimension = {
  id: "author-provenance",
  name: "Author & provenance",
  weight: 0.08,

  evaluate(signals: PRSignals): DimensionOutput {
    const signalsUsed = [
      "authorIsFirstTimeContributor",
      "authorRevertRate",
      "authorPriorPRs",
      "likelyAIAuthored",
      "aiAuthorshipHints",
    ];

    let value = 0;
    const reasons: string[] = [];

    if (signals.authorIsFirstTimeContributor) {
      value += 0.5;
      reasons.push("First contribution to this repository");
    }

    if (signals.authorRevertRate > REVERT_THRESHOLD) {
      value += 0.3;
      reasons.push(
        `Author's recent changes reverted at ${Math.round(signals.authorRevertRate * 100)}%`,
      );
    }

    if (signals.likelyAIAuthored) {
      value += 0.4;

      // Name the evidence. An unexplained "AI-generated" label is exactly the
      // kind of unfalsifiable claim this system exists to avoid.
      const hints = signals.aiAuthorshipHints;
      const evidence: string[] = [];
      if (hints.botAuthor) evidence.push("agent account");
      if (hints.coAuthoredByTrailer) evidence.push("co-author trailer");
      if (hints.branchNamePattern) evidence.push("branch naming");
      if (hints.commitCadence) evidence.push("commit cadence");
      if (hints.templatedBody) evidence.push("templated description");

      reasons.push(`Likely agent-authored (${evidence.join(", ")})`);
    }

    // Established contributors with a clean record earn a small discount.
    if (
      !signals.authorIsFirstTimeContributor &&
      signals.authorPriorPRs >= 20 &&
      signals.authorRevertRate === 0
    ) {
      value -= 0.15;
      reasons.push(
        `Established contributor — ${signals.authorPriorPRs} merged PRs, no reverts`,
      );
    }

    if (reasons.length === 0) {
      reasons.push("No notable authorship signals");
    }

    return { raw: clamp(value), reasons, signalsUsed };
  },
};
