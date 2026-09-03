/**
 * Diff prioritisation.
 *
 * Naive truncation sends the first N characters of a diff, which in practice
 * means `package-lock.json` — alphabetically first and semantically worthless.
 * The model then writes a confident paragraph about a lockfile while the auth
 * change it should have read sits past the cut.
 *
 * Instead we rank whole files by review consequence and fill the budget from
 * the top, so the most consequential change is always inside the window. This
 * is a small detail with an outsized quality effect, and it is the answer to
 * *"how do you handle large PRs?"*.
 */

import { rankPatchesByConsequence } from "../signals/diff";
import type { FileSignal } from "../signals/types";

/** What the model is given, plus what it was not. */
export interface PrioritisedDiff {
  /** Diff text, ranked most-consequential first, within the char budget. */
  text: string;
  /** Files whose patches were included in full. */
  includedPaths: string[];
  /** Files left out entirely, for the honesty footer. */
  omittedPaths: string[];
  /** True when anything was dropped — the prompt must say so. */
  truncated: boolean;
}

/**
 * Build a prioritised diff within a character budget.
 *
 * Generated files are excluded outright rather than merely ranked last: a
 * lockfile contributes nothing a reviewer needs and would only consume budget.
 *
 * Files are included whole. A half-included patch is worse than an excluded
 * one — the model cannot tell a truncated hunk from a complete one, and will
 * happily describe a function it only saw the first half of.
 */
export function prioritiseDiff(
  files: FileSignal[],
  maxChars: number,
): PrioritisedDiff {
  const reviewable = files.filter((f) => !f.isGenerated && f.patch);

  const generated = files.filter((f) => f.isGenerated).map((f) => f.path);

  if (reviewable.length === 0) {
    return {
      text: "(no reviewable diff — the change is entirely generated files)",
      includedPaths: [],
      omittedPaths: generated,
      truncated: generated.length > 0,
    };
  }

  const ranked = rankPatchesByConsequence(reviewable);

  const sections: string[] = [];
  const includedPaths: string[] = [];
  const omittedPaths: string[] = [...generated];
  let used = 0;

  for (const file of ranked) {
    const section = `--- ${file.path} (+${file.additions} −${file.deletions})\n${file.patch}`;

    // Always include the single most consequential file, even if it alone
    // exceeds the budget: an explanation of the second-most-important change
    // is not a useful substitute.
    const isFirst = includedPaths.length === 0;
    if (!isFirst && used + section.length > maxChars) {
      omittedPaths.push(file.path);
      continue;
    }

    const clipped =
      isFirst && section.length > maxChars
        ? section.slice(0, maxChars) + "\n… (this file's diff was truncated)"
        : section;

    sections.push(clipped);
    includedPaths.push(file.path);
    used += clipped.length;
  }

  let text = sections.join("\n\n");

  if (omittedPaths.length > 0) {
    // Naming what was withheld lets the model say "I did not see X" rather
    // than implying the change is smaller than it is.
    const listed = omittedPaths.slice(0, 10).join(", ");
    const more =
      omittedPaths.length > 10 ? ` and ${omittedPaths.length - 10} more` : "";
    text += `\n\n(${omittedPaths.length} further file${omittedPaths.length === 1 ? "" : "s"} not shown: ${listed}${more})`;
  }

  return {
    text,
    includedPaths,
    omittedPaths,
    truncated: omittedPaths.length > 0,
  };
}
