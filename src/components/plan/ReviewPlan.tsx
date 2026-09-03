"use client";

import { AlertTriangle, Clock, Shield } from "lucide-react";
import { LEVEL_STYLES, shortRepo } from "@/lib/risk-display";
import { formatDuration } from "@/lib/engines/effort-estimator";
import type { ReviewPlan as Plan } from "@/lib/engines/review-plan";

interface ReviewPlanProps {
  plan: Plan;
}

/**
 * The plan.
 *
 * Not a sorted list — a knapsack solved exactly, maximising risk coverage
 * inside the time the reviewer actually has. Ordered highest-risk first, so
 * the item that most needs careful reading is read while attention is freshest.
 */
export default function ReviewPlan({ plan }: ReviewPlanProps) {
  const {
    items,
    totalMinutes,
    budgetMinutes,
    coveredRisk,
    deferred,
    warnings,
  } = plan;

  return (
    <div className="space-y-3">
      {warnings.map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2"
        >
          <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
          <span className="text-[11px] text-amber-800">{warning}</span>
        </div>
      ))}

      {items.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="flex items-baseline justify-between px-4 py-2.5 border-b border-gray-100">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Your plan
            </h2>
            <span className="text-[11px] text-gray-500 tabular-nums">
              {items.length} PR{items.length === 1 ? "" : "s"} ·{" "}
              {formatDuration(totalMinutes)} of {formatDuration(budgetMinutes)}
            </span>
          </div>

          <ol>
            {items.map((item) => {
              const style = LEVEL_STYLES[item.riskLevel];
              return (
                <li
                  key={`${item.repo}#${item.number}`}
                  className="flex items-start gap-3 px-4 py-2.5 border-b border-gray-50 last:border-b-0"
                >
                  <span className="mt-0.5 w-5 shrink-0 text-[11px] font-semibold text-gray-300 tabular-nums">
                    {item.position}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase ${style.bg} ${style.text}`}
                      >
                        {style.label}
                      </span>
                      {item.forced && (
                        <span
                          className="shrink-0 flex items-center gap-0.5 text-[9.5px] text-gray-400"
                          title="Included because critical PRs are never left out"
                        >
                          <Shield size={9} />
                          always included
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-[13px] font-medium text-gray-900 leading-snug line-clamp-2">
                      {item.title}
                    </p>
                    <p className="text-[10.5px] text-gray-400 mt-0.5">
                      {shortRepo(item.repo)} #{item.number}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="flex items-center gap-1 text-[11px] font-medium text-gray-600">
                      <Clock size={10} />
                      {item.minutes}m
                    </div>
                    <div className="text-[10px] text-gray-300 tabular-nums mt-0.5">
                      {item.cumulativeMinutes}m in
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {/* The claim the plan is making, stated as a number. */}
          <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100">
            <p className="text-[11px] text-gray-600">
              Covers{" "}
              <span className="font-bold text-gray-900">{coveredRisk}%</span> of
              the queue&apos;s total risk in{" "}
              <span className="font-bold text-gray-900">
                {formatDuration(totalMinutes)}
              </span>
              .
            </p>
          </div>
        </div>
      )}

      {deferred.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Not this session ({deferred.length})
            </h2>
          </div>
          <ul>
            {deferred.map((item) => (
              <li
                key={`${item.repo}#${item.number}`}
                className="flex items-start gap-3 px-4 py-2 border-b border-gray-50 last:border-b-0"
              >
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_STYLES[item.riskLevel].bar}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-gray-600 leading-snug line-clamp-1">
                    {item.title}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {item.reason}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
