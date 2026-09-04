"use client";

import { UserCheck, Shield } from "lucide-react";
import type { ReviewerSuggestion } from "@/lib/engines/reviewer-engine";

interface ReviewerCardProps {
  suggestion: ReviewerSuggestion | null;
  loading?: boolean;
}

/**
 * Suggested reviewer.
 *
 * **Renders nothing when confidence is low.** Architecture §8 calls this
 * non-negotiable: a card confidently naming the wrong person casts doubt on
 * every working component beside it. Returning `null` is the correct output,
 * not a fallback.
 */
export default function ReviewerCard({
  suggestion,
  loading = false,
}: ReviewerCardProps) {
  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-[10.5px] text-gray-400">Matching reviewers…</p>
      </div>
    );
  }

  // The guard. Not a styling choice — the engine has told us it does not know.
  if (
    !suggestion ||
    suggestion.lowConfidence ||
    suggestion.matches.length === 0
  ) {
    return null;
  }

  const [best, ...rest] = suggestion.matches;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-gray-500">
        <UserCheck size={11} />
        Suggested reviewer
      </p>

      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-gray-900">
          @{best.login}
        </span>
        <span className="text-[11px] tabular-nums text-gray-400">
          {Math.round(best.score * 100)}% match
        </span>
        {best.isCodeowner && (
          <span
            className="flex items-center gap-0.5 text-[9.5px] text-gray-400"
            title="Listed in CODEOWNERS"
          >
            <Shield size={9} />
            owner
          </span>
        )}
      </div>

      <ul className="mt-1 space-y-0.5">
        {best.reasons.slice(0, 2).map((reason) => (
          <li key={reason} className="text-[10.5px] text-gray-500">
            {reason}
          </li>
        ))}
      </ul>

      {rest.length > 0 && (
        <p className="mt-1.5 border-t border-gray-100 pt-1.5 text-[10px] text-gray-400">
          Also: {rest.map((m) => `@${m.login}`).join(", ")}
        </p>
      )}
    </div>
  );
}
