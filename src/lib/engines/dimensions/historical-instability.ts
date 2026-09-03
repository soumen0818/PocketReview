/**
 * Historical instability — has this code gone wrong before?
 *
 * Weight: 0.15
 *
 * This is the dimension that uses the repository's own past rather than the
 * shape of the current diff. Files that churn constantly, that have been
 * reverted, or that appeared in a previous hotfix are empirically the ones
 * where the next change also goes wrong.
 *
 * It is also the first dimension to become unavailable: a new repository has
 * no history, and a shallow clone has none to read. When that happens this
 * returns a neutral 0 with an explicit reason, and the orchestrator lowers the
 * reported confidence rather than pretending the code is stable.
 */

import { clamp, saturate } from "../../math";
import { basename } from "../../signals/classify";
import type { PRSignals } from "../../signals/types";
import type { Dimension, DimensionOutput } from "../types";

/** Commits in the window at which the churn term saturates. */
const CHURN_KNEE = 15;

/** Revert rates above this are treated as maximally unstable. */
const REVERT_CEILING = 0.2;

export const historicalInstability: Dimension = {
  id: "historical-instability",
  name: "Historical instability",
  weight: 0.15,

  evaluate(signals: PRSignals): DimensionOutput {
    const signalsUsed = [
      "fileChurn",
      "fileRevertRate",
      "priorIncidentFiles",
      "hotspotScore",
    ];

    if (!signals.availability.history) {
      return {
        raw: 0,
        reasons: ["Repository history unavailable — instability not assessed"],
        signalsUsed,
      };
    }

    const relevant = signals.files.filter((f) => !f.isGenerated);
    if (relevant.length === 0) {
      return { raw: 0, reasons: [], signalsUsed };
    }

    // Churn: use the peak rather than the mean. One volatile file in an
    // otherwise-quiet PR is the thing worth flagging, and averaging would
    // dilute it away.
    const churnValues = relevant.map((f) =>
      saturate(signals.fileChurn[f.path] ?? 0, CHURN_KNEE),
    );
    const churn = churnValues.length > 0 ? Math.max(...churnValues) : 0;

    const revertRates = relevant.map(
      (f) => signals.fileRevertRate[f.path] ?? 0,
    );
    const peakRevertRate =
      revertRates.length > 0 ? Math.max(...revertRates) : 0;
    const reverts = clamp(peakRevertRate / REVERT_CEILING);

    const touchedIncidentFiles = relevant.filter((f) =>
      signals.priorIncidentFiles.includes(f.path),
    );
    const incident = touchedIncidentFiles.length > 0 ? 1 : 0;

    const raw = clamp(0.45 * churn + 0.35 * reverts + 0.2 * incident);

    const reasons: string[] = [];

    // Name the specific file. "src/payments/charge.ts was reverted twice"
    // is quotable in a way that "elevated revert rate" is not.
    if (peakRevertRate > 0) {
      const worst = relevant.reduce((best, f) =>
        (signals.fileRevertRate[f.path] ?? 0) >
        (signals.fileRevertRate[best.path] ?? 0)
          ? f
          : best,
      );
      const commits = signals.fileChurn[worst.path] ?? 0;
      const reverted = Math.round(peakRevertRate * commits);
      if (reverted > 0) {
        reasons.push(
          `${basename(worst.path)} was reverted ${reverted} time${reverted === 1 ? "" : "s"} recently`,
        );
      }
    }

    if (touchedIncidentFiles.length > 0) {
      const names = touchedIncidentFiles
        .slice(0, 2)
        .map((f) => basename(f.path))
        .join(", ");
      reasons.push(
        touchedIncidentFiles.length === 1
          ? `${names} appeared in a previous incident fix`
          : `${touchedIncidentFiles.length} files appeared in previous incident fixes (${names}…)`,
      );
    }

    if (churn > 0.6) {
      const busiest = relevant.reduce((best, f) =>
        (signals.fileChurn[f.path] ?? 0) > (signals.fileChurn[best.path] ?? 0)
          ? f
          : best,
      );
      const count = signals.fileChurn[busiest.path] ?? 0;
      reasons.push(
        `${basename(busiest.path)} changed ${count} times in the last 90 days`,
      );
    }

    if (reasons.length === 0) {
      reasons.push("No recent instability in the files touched");
    }

    return { raw, reasons, signalsUsed };
  },
};
