"use client";

import { X, ArrowDown, ArrowUp } from "lucide-react";
import { levelStyle } from "@/lib/risk-display";
import type { RiskAssessment } from "@/lib/engines/types";

interface DimensionBreakdownProps {
  title: string;
  prNumber: number;
  risk: RiskAssessment;
  /** Score the naive lines-changed model would give. */
  baseline: number;
  onClose: () => void;
}

/**
 * The audit view — "show your working".
 *
 * This screen exists for one question: *why that number?* It renders the full
 * arithmetic — every dimension's raw assessment, its weight, the points it
 * contributed, and the signals it read — and shows those contributions
 * summing to the base score.
 *
 * It is deliberately dense. This is not a screen for triaging; it is the
 * screen you open when someone doubts the score, and the answer needs to be
 * complete rather than pretty.
 */
export default function DimensionBreakdown({
  title,
  prNumber,
  risk,
  baseline,
  onClose,
}: DimensionBreakdownProps) {
  const style = levelStyle(risk.level);
  const contributionSum = risk.dimensions.reduce(
    (total, d) => total + d.contribution,
    0,
  );

  return (
    <div className="fixed inset-0 z-50 bg-gray-50 flex flex-col max-w-md mx-auto">
      {/* Header */}
      <header className="flex items-start gap-3 px-4 py-3 bg-white border-b border-gray-100 shrink-0">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
            Score breakdown
          </p>
          <h2 className="text-sm font-semibold text-gray-900 truncate">
            #{prNumber} {title}
          </h2>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 -mr-1.5 rounded-full hover:bg-gray-100 text-gray-400 shrink-0"
          aria-label="Close breakdown"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* The headline claim: this number is arithmetic, not opinion. */}
        <section
          className={`rounded-xl border p-4 ${style.bg} ${style.border}`}
        >
          <div className="flex items-baseline justify-between">
            <span
              className={`text-xs font-bold uppercase tracking-widest ${style.text}`}
            >
              {style.label} risk
            </span>
            <span
              className={`font-mono tabular-nums font-bold text-3xl ${style.text}`}
            >
              {risk.score}
            </span>
          </div>
          <p
            className={`mt-1.5 text-[11px] leading-relaxed ${style.text} opacity-80`}
          >
            Computed from {risk.dimensions.length} weighted signals. No language
            model is involved — the same input always produces this same number.
          </p>
        </section>

        {/* Dimensions */}
        <section>
          <SectionHeading>Dimensions</SectionHeading>
          <div className="mt-2 bg-white rounded-xl border border-gray-100 divide-y divide-gray-50 overflow-hidden">
            {risk.dimensions.map((dimension) => {
              const maxPoints = dimension.weight * 100;
              const fill =
                maxPoints > 0 ? (dimension.contribution / maxPoints) * 100 : 0;
              const inactive = dimension.contribution < 0.05;

              return (
                <div key={dimension.id} className="px-3.5 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={`text-[13px] font-medium ${inactive ? "text-gray-400" : "text-gray-800"}`}
                    >
                      {dimension.name}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-gray-400 shrink-0">
                      <span
                        className={
                          inactive
                            ? "text-gray-300"
                            : "text-gray-900 font-semibold"
                        }
                      >
                        {dimension.contribution.toFixed(1)}
                      </span>
                      {" / "}
                      {maxPoints.toFixed(0)}
                    </span>
                  </div>

                  {/* Fill shows how much of this dimension's ceiling was used,
                      so a small weight at full strength still reads as "maxed". */}
                  <div className="mt-1.5 h-1 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${inactive ? "bg-gray-200" : style.bar}`}
                      style={{ width: `${Math.max(0, Math.min(100, fill))}%` }}
                    />
                  </div>

                  {dimension.reasons.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {dimension.reasons.map((reason, index) => (
                        <li
                          key={index}
                          className="text-[11.5px] leading-snug text-gray-500 flex gap-1.5"
                        >
                          <span className="text-gray-300 select-none">·</span>
                          <span>{reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="mt-1.5 text-[10px] text-gray-300 font-mono truncate">
                    {dimension.signalsUsed.join(" · ")}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* The arithmetic, stated explicitly. */}
        <section>
          <SectionHeading>How the score adds up</SectionHeading>
          <div className="mt-2 bg-white rounded-xl border border-gray-100 p-3.5 space-y-1.5 font-mono text-[12px]">
            <Row
              label="Weighted dimensions"
              value={contributionSum.toFixed(2)}
            />

            {risk.modifiers.map((modifier) => (
              <Row
                key={modifier.id}
                label={modifier.label}
                value={
                  modifier.delta > 0
                    ? `+${modifier.delta}`
                    : String(modifier.delta)
                }
                muted
                icon={
                  modifier.delta > 0 ? (
                    <ArrowUp size={10} className="text-red-400" />
                  ) : (
                    <ArrowDown size={10} className="text-emerald-500" />
                  )
                }
              />
            ))}

            {risk.modifiers.length > 0 && (
              <Row
                label="After modifiers"
                value={Math.max(
                  0,
                  Math.min(100, risk.baseScore + risk.modifierDelta),
                ).toFixed(2)}
              />
            )}

            {risk.floor !== null && (
              <>
                <div className="pt-1.5 border-t border-gray-100" />
                <Row
                  label={`Raised to floor`}
                  value={String(risk.floor)}
                  icon={<ArrowUp size={10} className="text-red-400" />}
                />
                {risk.floorReasons.map((reason, index) => (
                  <p
                    key={index}
                    className="text-[10.5px] text-gray-400 font-sans leading-snug pl-2"
                  >
                    {reason}
                  </p>
                ))}
              </>
            )}

            <div className="pt-1.5 border-t border-gray-200" />
            <Row label="Final score" value={String(risk.score)} bold />
          </div>

          {risk.floor !== null && (
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              A floor raises the score for facts a weighted average would dilute
              — a one-line change to authentication is not &ldquo;20%
              risky&rdquo;, it is a change a human must look at. Floors can only
              raise a score, never lower it.
            </p>
          )}
        </section>

        {/* The comparison that makes the case. */}
        <section>
          <SectionHeading>Versus a lines-changed model</SectionHeading>
          <div className="mt-2 bg-white rounded-xl border border-gray-100 p-3.5">
            <Comparison
              label="PocketReview"
              score={risk.score}
              barClass={style.bar}
            />
            <Comparison
              label="Lines changed only"
              score={baseline}
              barClass="bg-gray-300"
              className="mt-2.5"
            />
            <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
              {describeGap(risk.score, baseline)}
            </p>
          </div>
        </section>

        {/* Confidence */}
        <section>
          <SectionHeading>Signal confidence</SectionHeading>
          <div className="mt-2 bg-white rounded-xl border border-gray-100 p-3.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-gray-700">
                {Math.round(risk.confidence * 100)}% of signals available
              </span>
              {risk.lowConfidence && (
                <span className="text-[11px] font-semibold text-amber-600">
                  Limited
                </span>
              )}
            </div>
            <div className="mt-1.5 h-1 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={`h-full rounded-full ${risk.lowConfidence ? "bg-amber-400" : "bg-gray-400"}`}
                style={{ width: `${Math.round(risk.confidence * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              {risk.lowConfidence
                ? "Some sources were unavailable — history, CI or review data could not be read. The score is computed from what was measurable and reported as less certain rather than presented as complete."
                : "All signal sources were readable for this pull request."}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 px-0.5">
      {children}
    </h3>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
  icon,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className={`font-sans text-[12px] flex items-center gap-1.5 ${
          bold
            ? "font-semibold text-gray-900"
            : muted
              ? "text-gray-500"
              : "text-gray-600"
        }`}
      >
        {icon}
        {label}
      </span>
      <span
        className={`tabular-nums shrink-0 ${
          bold ? "font-bold text-gray-900 text-[14px]" : "text-gray-700"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function Comparison({
  label,
  score,
  barClass,
  className = "",
}: {
  label: string;
  score: number;
  barClass: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-gray-600">{label}</span>
        <span className="font-mono tabular-nums text-[12px] font-semibold text-gray-900">
          {score}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${barClass}`}
          style={{ width: `${Math.max(1, score)}%` }}
        />
      </div>
    </div>
  );
}

/** Plain-English summary of where the two models disagree. */
function describeGap(score: number, baseline: number): string {
  const gap = score - baseline;

  if (gap >= 25) {
    return "A size-based model would rank this far lower and bury it in the queue. The change is small but lands somewhere consequential.";
  }
  if (gap <= -25) {
    return "A size-based model would rank this near the top purely because the diff is large. Most of those lines carry no review decisions.";
  }
  if (Math.abs(gap) <= 8) {
    return "Both models broadly agree here — size happens to track consequence for this change.";
  }
  return gap > 0
    ? "This scores higher than size alone would suggest, driven by where the change lands rather than how large it is."
    : "This scores lower than size alone would suggest — much of the diff carries little review weight.";
}
