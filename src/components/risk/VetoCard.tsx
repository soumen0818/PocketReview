"use client";

import { ShieldAlert, ArrowLeft } from "lucide-react";
import { shortRepo } from "@/lib/risk-display";
import type { PolicyVerdict } from "@/lib/policy/gate";
import type { TriagedPR } from "@/lib/types";

interface VetoCardProps {
  pr: TriagedPR;
  verdict: PolicyVerdict;
  onDismiss: () => void;
}

/**
 * The refusal.
 *
 * When the policy gate vetoes a fast-track, the card **does not leave the
 * deck** — it flips to show why. A system visibly refusing its own
 * recommendation is the strongest thing it can do in front of an audience, and
 * it is the honest behaviour regardless.
 */
export default function VetoCard({ pr, verdict, onDismiss }: VetoCardProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-red-200 bg-white shadow-lg">
      <div className="h-1 shrink-0 bg-red-500" />

      <div className="flex shrink-0 items-start gap-2.5 px-4 pb-3 pt-4">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-red-500" />
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-red-700">
            Fast-track refused
          </p>
          <p className="mt-0.5 text-[11px] text-gray-400">
            {shortRepo(pr.repository.nameWithOwner)} #{pr.number}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4">
        {verdict.vetoes.map((veto) => (
          <div
            key={veto.reason}
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
          >
            <p className="text-[12px] font-semibold text-gray-900">
              {veto.label}
            </p>
            <p className="mt-0.5 text-[10.5px] text-gray-500">{veto.detail}</p>
          </div>
        ))}

        {verdict.structurallyBlocked && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
            <p className="text-[11px] font-semibold text-red-800">
              This cannot be overridden
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-red-700">
              Auth, payments and database changes can never be fast-tracked, at
              any score and under any configuration. The rule is in code, not in
              a settings file.
            </p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-gray-100 px-4 py-3">
        <p className="mb-2.5 text-[10.5px] leading-relaxed text-gray-400">
          The PR stays in your queue. Nothing was approved or merged — this app
          has no write access to GitHub.
        </p>
        <button
          onClick={onDismiss}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-gray-900 px-4 py-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-gray-800 active:bg-gray-700"
        >
          <ArrowLeft size={13} />
          Back to the deck
        </button>
      </div>
    </div>
  );
}
