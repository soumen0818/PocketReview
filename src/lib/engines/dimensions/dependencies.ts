/**
 * Dependencies and supply chain.
 *
 * Weight: 0.10
 *
 * A new dependency is a permanent addition to the codebase's attack surface
 * and maintenance burden, and it usually gets less review attention than the
 * same number of hand-written lines — reviewers skim `package.json`.
 *
 * The critical behaviour here is that a **lockfile-only change scores near
 * zero**. A regenerated lockfile can be thousands of lines and represents no
 * authored decision at all. Treating it as risk is the single most common
 * false positive in naive diff scoring, and it is worth being explicit about.
 */

import { clamp } from "../../math";
import { basename, isLockfile } from "../../signals/classify";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Dependencies added at which the term reaches its ceiling. */
const ADD_CEILING = 4;

export const dependencies: Dimension = {
  id: "dependencies",
  name: "Dependencies",
  weight: 0.1,

  evaluate(signals: PRSignals): DimensionOutput {
    const signalsUsed = [
      "dependenciesAdded",
      "dependenciesRemoved",
      "dependencyFilesChanged",
      "lockfileOnly",
    ];

    if (signals.dependencyFilesChanged.length === 0) {
      return {
        raw: 0,
        reasons: ["No dependency changes"],
        signalsUsed,
      };
    }

    // Lockfile-only: a machine-regenerated file, however large.
    if (signals.lockfileOnly) {
      return {
        raw: 0.15,
        reasons: [
          "Lockfile regeneration only — no manifest changes",
          "Large diff, but no authored decisions to review",
        ],
        signalsUsed,
      };
    }

    const manifests = signals.dependencyFilesChanged.filter(
      (path) => !isLockfile(path),
    );

    // Manifests touched but no parsed entries changed: usually a version bump
    // or a script edit rather than a new dependency.
    if (signals.dependenciesAdded === 0 && signals.dependenciesRemoved === 0) {
      return {
        raw: 0.25,
        reasons: [
          `${manifests.map(basename).join(", ")} modified without adding dependencies`,
        ],
        signalsUsed,
      };
    }

    const added = clamp(signals.dependenciesAdded / ADD_CEILING);
    const removed = clamp(signals.dependenciesRemoved / ADD_CEILING);

    // Additions dominate: a removed dependency shrinks the surface area, and
    // its risk is that something breaks — which other dimensions capture.
    const raw = clamp(0.7 * added + 0.3 * removed + (added > 0 ? 0.3 : 0));

    const reasons: string[] = [];

    if (signals.dependenciesAdded > 0) {
      reasons.push(
        `${signals.dependenciesAdded} new dependenc${signals.dependenciesAdded === 1 ? "y" : "ies"} added`,
      );
      reasons.push("New dependencies expand the supply-chain surface");
    }

    if (signals.dependenciesRemoved > 0) {
      reasons.push(
        `${signals.dependenciesRemoved} dependenc${signals.dependenciesRemoved === 1 ? "y" : "ies"} removed`,
      );
    }

    return { raw, reasons, signalsUsed };
  },
};
