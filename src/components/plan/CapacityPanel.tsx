"use client";

import { AlertTriangle } from "lucide-react";
import { LEVEL_STYLES } from "@/lib/risk-display";
import { formatDuration } from "@/lib/engines/effort-estimator";
import type { CapacityReport } from "@/lib/engines/review-plan";

interface CapacityPanelProps {
  capacity: CapacityReport;
}

/**
 * The deficit panel.
 *
 * States the thesis numerically: the queue is arriving faster than it can be
 * served. Every figure here is measured — the queue minutes come from the
 * effort estimator, and capacity is the reviewer's own stated budget rather
 * than an inferred team roster.
 */
export default function CapacityPanel({ capacity }: CapacityPanelProps) {
  const { rows, totalMinutes, capacityMinutes, deficitMinutes } = capacity;

  if (rows.length === 0) return null;

  const widest = Math.max(...rows.map((r) => r.minutes), 1);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
          Queue load
        </h2>
        <span className="text-[10px] text-gray-400">today</span>
      </div>

      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.level} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 shrink-0 text-gray-500">
              {LEVEL_STYLES[row.level].label}
            </span>
            <span className="w-4 shrink-0 tabular-nums text-gray-400">
              {row.count}
            </span>

            {/* Bar length is minutes, not count — the panel is about time. */}
            <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full ${LEVEL_STYLES[row.level].bar}`}
                style={{ width: `${(row.minutes / widest) * 100}%` }}
              />
            </div>

            <span className="w-16 shrink-0 text-right tabular-nums text-gray-600">
              {formatDuration(row.minutes)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100 space-y-1 text-[11px]">
        <Row label="Total required" value={formatDuration(totalMinutes)} />
        <Row label="Your capacity" value={formatDuration(capacityMinutes)} />
      </div>

      {deficitMinutes > 0 ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-2.5 py-2">
          <AlertTriangle size={13} className="text-red-500 shrink-0" />
          <span className="text-[11px] font-semibold text-red-700">
            Deficit {formatDuration(deficitMinutes)}
          </span>
          <span className="text-[10px] text-red-500 ml-auto tabular-nums">
            {capacity.loadFactor}× capacity
          </span>
        </div>
      ) : (
        <div className="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-2">
          <span className="text-[11px] font-semibold text-emerald-700">
            The queue fits in the time you have
          </span>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900 tabular-nums">{value}</span>
    </div>
  );
}
