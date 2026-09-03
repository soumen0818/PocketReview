"use client";

import { LEVEL_STYLES } from "@/lib/risk-display";
import type { QueueSummary } from "@/lib/types";
import type { RiskLevel } from "@/lib/engines/types";

interface QueueSummaryBarProps {
  summary: QueueSummary;
  remaining: number;
}

const ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

/**
 * Queue composition at a glance.
 *
 * Answers "how bad is today?" before the reviewer touches a single card, and
 * gives the deck a sense of progress as it empties.
 */
export default function QueueSummaryBar({
  summary,
  remaining,
}: QueueSummaryBarProps) {
  if (summary.total === 0) return null;

  const present = ORDER.filter((level) => summary.byLevel[level] > 0);
  const done = summary.total - remaining;

  return (
    <div className="px-4 pt-2 pb-1 shrink-0">
      <div className="flex items-center gap-3">
        {/* Proportional band widths — the shape of the queue, not a legend. */}
        <div className="flex-1 flex h-1.5 rounded-full overflow-hidden bg-gray-100">
          {present.map((level) => (
            <div
              key={level}
              className={LEVEL_STYLES[level].bar}
              style={{
                width: `${(summary.byLevel[level] / summary.total) * 100}%`,
              }}
              title={`${summary.byLevel[level]} ${level}`}
            />
          ))}
        </div>

        <span className="text-[11px] text-gray-400 font-medium tabular-nums shrink-0">
          {done > 0
            ? `${done}/${summary.total} triaged`
            : `${summary.total} to triage`}
        </span>
      </div>

      <div className="flex items-center gap-3 mt-1.5">
        {present.map((level) => (
          <span
            key={level}
            className={`text-[10.5px] font-medium ${LEVEL_STYLES[level].text}`}
          >
            {summary.byLevel[level]} {LEVEL_STYLES[level].label.toLowerCase()}
          </span>
        ))}

        {/* The queue's cost in reviewer time — half of the Phase 5 deficit. */}
        {summary.totalMinutes > 0 && (
          <span
            className="text-[10.5px] font-medium text-gray-500 ml-auto tabular-nums"
            title={ORDER.filter((l) => summary.minutesByLevel[l] > 0)
              .map(
                (l) =>
                  `${LEVEL_STYLES[l].label}: ${summary.minutesByLevel[l]} min`,
              )
              .join("\n")}
          >
            {summary.totalMinutesLabel} of review
          </span>
        )}
      </div>
    </div>
  );
}
