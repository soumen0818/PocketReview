"use client";

import { Plus, Minus, FileText, ChevronRight, Clock } from "lucide-react";
import RiskBadge from "./risk/RiskBadge";
import RiskReasons from "./risk/RiskReasons";
import { levelStyle, timeAgo, shortRepo } from "@/lib/risk-display";
import type { TriagedPR } from "@/lib/types";

interface PRCardProps {
  pr: TriagedPR;
  /** Opens the score breakdown. Omitted on background cards in the stack. */
  onShowBreakdown?: () => void;
  style?: React.CSSProperties;
}

/**
 * The triage card.
 *
 * Deliberately shows *less* than GitHub, not the same thing smaller. Every
 * element here serves one decision — fast lane or deep review — and anything
 * that does not is left out. The PR description in particular is reduced to a
 * couple of lines: a reviewer deciding where to spend attention does not need
 * the author's full write-up, and including it would recreate the wall of text
 * this product exists to replace.
 *
 * The whole card renders from deterministic data, so it paints immediately.
 * Nothing here waits on a language model.
 */
export default function PRCard({ pr, onShowBreakdown, style }: PRCardProps) {
  const { risk } = pr;
  const level = levelStyle(risk.level);

  return (
    <div
      className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden select-none h-full flex flex-col"
      style={style}
    >
      {/* Level accent — readable at a glance while the card is mid-swipe. */}
      <div className={`h-1 shrink-0 ${level.accent}`} />

      {/* Identity */}
      <div className="px-4 pt-3.5 pb-2.5 shrink-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[11px] text-gray-400 font-medium truncate">
            {shortRepo(pr.repository.nameWithOwner)}
          </span>
          <span className="text-[11px] text-gray-400 font-mono shrink-0">
            #{pr.number}
          </span>
        </div>

        <h2 className="text-[15px] font-semibold text-gray-900 leading-snug line-clamp-2">
          {pr.title}
        </h2>

        <p className="text-[11px] text-gray-400 mt-1">
          @{pr.author.login} · {timeAgo(pr.createdAt)}
        </p>
      </div>

      {/* The score */}
      <div className="px-4 shrink-0">
        <RiskBadge
          score={risk.score}
          level={risk.level}
          lowConfidence={risk.lowConfidence}
        />
      </div>

      {/* Diff shape */}
      <div className="mx-4 mt-3 pb-2.5 border-b border-gray-100 flex items-center gap-4 text-[11px] shrink-0">
        {pr.additions != null && (
          <span className="flex items-center gap-1 text-emerald-600 font-medium">
            <Plus size={11} strokeWidth={2.5} />
            {pr.additions.toLocaleString()}
          </span>
        )}
        {pr.deletions != null && (
          <span className="flex items-center gap-1 text-red-500 font-medium">
            <Minus size={11} strokeWidth={2.5} />
            {pr.deletions.toLocaleString()}
          </span>
        )}
        {pr.changedFiles != null && (
          <span className="flex items-center gap-1 text-gray-400">
            <FileText size={11} />
            {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
          </span>
        )}

        {/* What this costs to review — the number the plan is built from. */}
        <span
          className="flex items-center gap-1 text-gray-600 font-medium ml-auto"
          title={pr.effort.terms
            .map(
              (t) => `${t.label}: ${t.minutes > 0 ? "+" : ""}${t.minutes} min`,
            )
            .join("\n")}
        >
          <Clock size={11} />
          {pr.effort.label}
        </span>
      </div>

      {/* Why this is where it is in the queue. */}
      {pr.priority.suppressionReasons.includes("ci-failing") && (
        <div className="mx-4 mt-2 px-2 py-1 rounded bg-amber-50 border border-amber-200 text-[10px] text-amber-700 shrink-0">
          {pr.priority.demoted
            ? "CI failing — author still iterating"
            : "CI failing — still critical, kept in place"}
        </div>
      )}

      {/* Why — the part that earns the score */}
      <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
          Why this score
        </p>
        <RiskReasons reasons={risk.topReasons} max={4} />
      </div>

      {/* The audit affordance. Its presence is the credibility claim: the
          number is inspectable, and one tap proves it. */}
      {onShowBreakdown && (
        <button
          onClick={onShowBreakdown}
          className="pressable shrink-0 flex items-center justify-between w-full px-4 py-2.5 border-t border-gray-100 text-[12px] text-gray-500 hover:bg-gray-50 active:bg-gray-100 transition-colors"
        >
          <span>
            See the full breakdown
            <span className="text-gray-500"> · vs baseline {pr.baseline}</span>
          </span>
          <ChevronRight size={14} className="text-gray-400" />
        </button>
      )}
    </div>
  );
}
