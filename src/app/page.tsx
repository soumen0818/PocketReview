"use client";

import { useState, useCallback } from "react";
import Header from "@/components/Header";
import SwipeDeck from "@/components/SwipeDeck";
import SwipeActions from "@/components/SwipeActions";
import ChatScreen from "@/components/ChatScreen";
import EmptyState from "@/components/EmptyState";
import { useSwipeHistory } from "@/hooks/useSwipeHistory";
import { usePRs } from "@/hooks/usePRs";
import { useChat } from "@/hooks/useChat";
import type { PullRequest } from "@/lib/types";

type TriggerSwipe = { direction: "left" | "right" } | null;

export default function Home() {
  const { hasReviewed, addSwipe } = useSwipeHistory();
  const { prs, loading, error, refetch, removePR } = usePRs(hasReviewed);
  const { getHistory, sendMessage, sending } = useChat();

  const [chatPR, setChatPR] = useState<PullRequest | null>(null);
  const [triggerSwipe, setTriggerSwipe] = useState<TriggerSwipe>(null);
  const [toast, setToast] = useState<string | null>(null);

  const topPR = prs[0] ?? null;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // Left: this PR needs a human to sit down with it. It enters the deep-review
  // lane rather than being dismissed.
  const handleNeedsReview = useCallback(
    (pr: PullRequest) => {
      addSwipe(pr.repository.nameWithOwner, pr.number, "left");
      removePR(pr.number);
      showToast(`#${pr.number} → needs review`);
    },
    [addSwipe, removePR],
  );

  // Right: fast-track. This records a triage decision only — it never
  // approves or merges anything on GitHub. A human still reviews the PR;
  // it simply goes into the quick lane rather than being opened first.
  const handleFastTrack = useCallback(
    (pr: PullRequest) => {
      addSwipe(pr.repository.nameWithOwner, pr.number, "right");
      removePR(pr.number);
      showToast(`#${pr.number} → fast-track`);
    },
    [addSwipe, removePR],
  );

  const triggerNeedsReview = useCallback(() => {
    if (!topPR) return;
    setTriggerSwipe({ direction: "left" });
  }, [topPR]);

  const triggerFastTrack = useCallback(() => {
    if (!topPR) return;
    setTriggerSwipe({ direction: "right" });
  }, [topPR]);

  // Chat view: replace entire screen
  if (chatPR) {
    return (
      <ChatScreen
        pr={chatPR}
        history={getHistory(chatPR)}
        onSend={(msg) => sendMessage(chatPR, msg)}
        sending={sending}
        onClose={() => setChatPR(null)}
      />
    );
  }

  return (
    <>
      <Header onRefresh={refetch} loading={loading} />

      <main className="flex flex-col flex-1 px-4 pb-4 min-h-0 overflow-hidden">
        {loading && prs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-4">
            <p className="text-red-500 font-medium">Error loading PRs</p>
            <p className="text-sm text-gray-500">{error}</p>
            <button
              onClick={refetch}
              className="px-4 py-2 bg-gray-900 text-white rounded-full text-sm"
            >
              Try again
            </button>
          </div>
        ) : prs.length === 0 ? (
          <EmptyState onRefresh={refetch} loading={loading} />
        ) : (
          <>
            <SwipeDeck
              prs={prs}
              onSwipeLeft={handleNeedsReview}
              onSwipeRight={handleFastTrack}
              triggerSwipe={triggerSwipe}
              onTriggerConsumed={() => setTriggerSwipe(null)}
            />
            <SwipeActions
              onNeedsReview={triggerNeedsReview}
              onExplain={() => setChatPR(topPR)}
              onFastTrack={triggerFastTrack}
              disabled={!topPR}
            />
          </>
        )}
      </main>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 text-white text-sm rounded-full shadow-lg whitespace-nowrap">
          {toast}
        </div>
      )}
    </>
  );
}
