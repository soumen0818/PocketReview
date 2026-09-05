/**
 * Domain criticality — *where* does this change land?
 *
 * Weight: 0.20
 *
 * This dimension is deliberately **size-independent**: a one-line change to
 * `src/auth/session.ts` scores the same here as a hundred-line one. That is
 * the entire point. A size-based scorer ranks this:
 *
 *     - if (user.isAdmin()) {
 *     + if (true) {
 *
 * as trivial — three lines, one file, tests still pass. Criticality is what
 * catches it.
 *
 * The dominant term is the single most critical file touched. A secondary
 * mass term nudges the score up when *many* critical files are involved, but
 * it can never pull the score down: touching one auth file is already the
 * signal, and touching five does not make it safer.
 */

import { clamp, saturate } from "../../math";
import { CATEGORY_LABELS } from "../../signals/path-rules";
import type { PRSignals, FileSignal } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Weight at or above which a file counts as critical. */
const CRITICAL_THRESHOLD = 0.7;

/** Lines of critical-path change at which the mass term saturates. */
const MASS_KNEE = 150;

/** Group critical files by category for readable reasons. */
function groupByCategory(files: FileSignal[]): Map<string, FileSignal[]> {
  const groups = new Map<string, FileSignal[]>();
  for (const file of files) {
    const existing = groups.get(file.category);
    if (existing) existing.push(file);
    else groups.set(file.category, [file]);
  }
  return groups;
}

export const domainCriticality: Dimension = {
  id: "domain-criticality",
  name: "Domain criticality",
  weight: 0.2,

  evaluate(signals: PRSignals): DimensionOutput {
    // Generated files carry no authored intent; tests are covered by their
    // own dimension and must not inflate criticality here.
    const relevant = signals.files.filter((f) => !f.isGenerated && !f.isTest);

    if (relevant.length === 0) {
      return {
        raw: 0,
        reasons: ["No production code changed"],
        signalsUsed: ["files"],
      };
    }

    // Primary term: the most critical thing this PR touches at all.
    const maxWeight = Math.max(...relevant.map((f) => f.categoryWeight));

    // Secondary term: how much critical-path code was actually modified.
    const criticalFiles = relevant.filter(
      (f) => f.categoryWeight >= CRITICAL_THRESHOLD,
    );
    const criticalLines = criticalFiles.reduce(
      (total, f) => total + f.additions + f.deletions,
      0,
    );
    const mass = saturate(criticalLines, MASS_KNEE);

    // 70/30 split: *where* dominates, *how much* modulates. Deliberately not
    // multiplicative — a small critical change must not score low.
    const raw = clamp(0.7 * maxWeight + 0.3 * mass);

    const reasons: string[] = [];

    if (criticalFiles.length > 0) {
      const groups = groupByCategory(criticalFiles);
      // Report the most critical categories first.
      const ordered = [...groups.entries()].sort(
        (a, b) => b[1][0].categoryWeight - a[1][0].categoryWeight,
      );

      for (const [category, files] of ordered.slice(0, 3)) {
        const label = CATEGORY_LABELS[files[0].category] ?? category;
        const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
        reasons.push(
          files.length === 1
            ? `${capitalise(label)} logic modified (${files[0].path}, ${lines} line${lines === 1 ? "" : "s"})`
            : `${capitalise(label)} logic modified across ${files.length} files`,
        );
      }

      // Make the size-independence explicit in the reasoning, because it is
      // the property a reader is most likely to doubt.
      //
      // Worded around "sensitive areas" rather than "critical paths" on
      // purpose. This dimension weighs everything at or above 0.7, which
      // includes infra and api — but "critical path" now has a narrower,
      // load-bearing meaning elsewhere (the risk floors and the policy gate's
      // never-fast-track set, both auth/payments/database only). Reusing the
      // phrase here made a CI workflow bump claim a critical-path change on
      // the card while the gate disagreed.
      if (criticalLines <= 10) {
        reasons.push(
          "Small diffs in sensitive areas still require careful review",
        );
      }
    } else {
      const top = relevant.reduce((best, f) =>
        f.categoryWeight > best.categoryWeight ? f : best,
      );
      reasons.push(
        `Highest-sensitivity area touched: ${CATEGORY_LABELS[top.category]}`,
      );
    }

    return {
      raw,
      reasons,
      signalsUsed: [
        "files",
        "criticalPaths",
        "touchesAuth",
        "touchesPayments",
        "touchesDatabase",
      ],
    };
  },
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
