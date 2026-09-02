"use client";

import { AlertTriangle } from "lucide-react";
import { levelStyle } from "@/lib/risk-display";
import type { RiskLevel } from "@/lib/engines/types";

interface RiskBadgeProps {
  score: number;
  level: RiskLevel;
  /** Show the "limited signals" warning. */
  lowConfidence?: boolean;
  size?: "sm" | "lg";
  className?: string;
}

/**
 * The score chip.
 *
 * Shows the number and the band together — the number alone is meaningless
 * without the scale, and the band alone hides the precision that makes the
 * breakdown worth opening.
 *
 * When confidence is low it says so. A system that quietly scores on missing
 * data is one a reviewer stops trusting the moment they notice.
 */
export default function RiskBadge({
  score,
  level,
  lowConfidence,
  size = "lg",
  className = "",
}: RiskBadgeProps) {
  const style = levelStyle(level);

  if (size === "sm") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-semibold ${style.bg} ${style.text} ${style.border} ${className}`}
      >
        <span className="font-mono tabular-nums">{score}</span>
        <span className="uppercase tracking-wide text-[10px]">
          {style.label}
        </span>
      </span>
    );
  }

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${style.bg} ${style.border} ${className}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`text-xs font-bold uppercase tracking-widest ${style.text}`}
        >
          {style.dot} {style.label} risk
        </span>
        <span className={`font-mono tabular-nums font-bold ${style.text}`}>
          <span className="text-2xl">{score}</span>
          <span className="text-sm opacity-60">/100</span>
        </span>
      </div>

      {/* The bar makes the score comparable across cards at a glance. */}
      <div className="mt-2 h-1.5 rounded-full bg-white/70 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${style.bar}`}
          style={{ width: `${Math.max(2, score)}%` }}
        />
      </div>

      {lowConfidence && (
        <p
          className={`mt-2 flex items-center gap-1.5 text-[11px] ${style.text} opacity-80`}
        >
          <AlertTriangle size={11} className="shrink-0" />
          Limited signals — some data was unavailable
        </p>
      )}
    </div>
  );
}
