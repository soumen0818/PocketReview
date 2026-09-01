"use client";

import { Search, Sparkles, Zap } from "lucide-react";

interface SwipeActionsProps {
  /** Route to the deep-review lane. */
  onNeedsReview: () => void;
  /** Open the explanation view. */
  onExplain: () => void;
  /** Route to the fast lane — records a triage decision, never approves. */
  onFastTrack: () => void;
  disabled?: boolean;
}

/**
 * Button equivalents of the three triage gestures.
 *
 * Deliberately mirrors the swipe directions so the deck is usable without
 * touch, and so the vocabulary is identical in both interactions.
 */
export default function SwipeActions({
  onNeedsReview,
  onExplain,
  onFastTrack,
  disabled,
}: SwipeActionsProps) {
  return (
    <div className="flex items-center justify-center gap-6 py-4">
      <button
        onClick={onNeedsReview}
        disabled={disabled}
        className="flex items-center justify-center w-14 h-14 rounded-full bg-white border-2 border-amber-300 text-amber-500 shadow-md hover:bg-amber-50 hover:border-amber-400 active:scale-95 transition-all disabled:opacity-40"
        aria-label="Needs review"
        title="Needs review"
      >
        <Search size={20} strokeWidth={2.5} />
      </button>

      <button
        onClick={onExplain}
        disabled={disabled}
        className="flex items-center justify-center w-12 h-12 rounded-full bg-white border-2 border-gray-200 text-gray-500 shadow-md hover:bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
        aria-label="Explain this PR"
        title="Explain"
      >
        <Sparkles size={18} />
      </button>

      <button
        onClick={onFastTrack}
        disabled={disabled}
        className="flex items-center justify-center w-14 h-14 rounded-full bg-white border-2 border-green-300 text-green-500 shadow-md hover:bg-green-50 hover:border-green-400 active:scale-95 transition-all disabled:opacity-40"
        aria-label="Fast-track"
        title="Fast-track"
      >
        <Zap size={20} strokeWidth={2.5} />
      </button>
    </div>
  );
}
