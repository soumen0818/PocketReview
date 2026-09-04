"use client";

import {
  ArrowLeft,
  Loader2,
  Eye,
  HelpCircle,
  AlertTriangle,
} from "lucide-react";
import RiskBadge from "../risk/RiskBadge";
import VoiceButton from "./VoiceButton";
import { shortRepo } from "@/lib/risk-display";
import type { TriagedPR } from "@/lib/types";
import type { Explanation } from "@/lib/llm/explain";

interface ExplainScreenProps {
  pr: TriagedPR;
  explanation: Explanation | null;
  loading: boolean;
  error: string | null;
  /** Machine-readable failure kind, when the model was unavailable. */
  errorKind: string | null;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * The explanation screen.
 *
 * The score and its reasons come from the risk engine and render immediately.
 * Only the prose waits on the model — so a slow or missing LLM costs a
 * paragraph, never the screen.
 */
export default function ExplainScreen({
  pr,
  explanation,
  loading,
  error,
  errorKind,
  onRetry,
  onClose,
}: ExplainScreenProps) {
  const spoken = explanation
    ? [
        explanation.oneLine,
        explanation.whatChanged,
        explanation.whyItMatters,
      ].join(". ")
    : "";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-4 py-3">
        <button
          onClick={onClose}
          className="-ml-1 rounded-full p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
          aria-label="Back to the deck"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-gray-900">
            {pr.title}
          </p>
          <p className="text-[10.5px] text-gray-400">
            {shortRepo(pr.repository.nameWithOwner)} #{pr.number}
          </p>
        </div>
        {explanation && <VoiceButton text={spoken} />}
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Deterministic — always present, never waits on the model. */}
        <RiskBadge
          score={pr.risk.score}
          level={pr.risk.level}
          lowConfidence={pr.risk.lowConfidence}
          size="lg"
        />

        {loading && (
          <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-6">
            <Loader2 size={14} className="animate-spin text-gray-400" />
            <span className="text-[12px] text-gray-500">
              Writing an explanation…
            </span>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-[12px] font-medium text-amber-800">
              Explanation unavailable
            </p>
            <p className="mt-1 text-[11px] text-amber-700">{error}</p>
            <p className="mt-2 text-[10.5px] text-amber-600">
              The score, its breakdown and the review plan are computed in code
              and are unaffected.
            </p>
            {/* A missing key is a configuration state, not a transient fault —
                offering "try again" for it would be dishonest. */}
            {errorKind !== "no-api-key" && errorKind !== "disabled" && (
              <button
                onClick={onRetry}
                className="mt-2 text-[11px] font-medium text-amber-800 underline"
              >
                Try again
              </button>
            )}
          </div>
        )}

        {explanation && !loading && (
          <>
            <p className="text-[15px] font-medium leading-snug text-gray-900">
              {explanation.oneLine}
            </p>

            <Section title="What changed">
              <p>{explanation.whatChanged}</p>
            </Section>

            <Section title="Why it matters">
              <p>{explanation.whyItMatters}</p>
            </Section>

            {explanation.whereToLookFirst.length > 0 && (
              <Section title="Where to look first" icon={<Eye size={11} />}>
                <ol className="space-y-1.5">
                  {explanation.whereToLookFirst.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 font-semibold text-gray-300">
                        {i + 1}
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ol>
              </Section>
            )}

            {explanation.questionsToAsk.length > 0 && (
              <Section title="Questions to ask" icon={<HelpCircle size={11} />}>
                <ul className="space-y-1.5">
                  {explanation.questionsToAsk.map((q, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-gray-300">·</span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {explanation.diffTruncated && (
              <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <AlertTriangle
                  size={11}
                  className="mt-0.5 shrink-0 text-gray-400"
                />
                <p className="text-[10.5px] text-gray-500">
                  Some files were too large to include. The most consequential
                  changes were prioritised.
                </p>
              </div>
            )}

            {/* Saying which model wrote this, and that it wrote only words, is
                the credibility claim restated where it can be checked. */}
            <p className="pt-1 text-[10px] text-gray-300">
              Prose by {explanation.model}. The score above was computed in code
              — no model produced it.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">
        {icon}
        {title}
      </p>
      <div className="text-[13px] leading-relaxed text-gray-700">
        {children}
      </div>
    </div>
  );
}
