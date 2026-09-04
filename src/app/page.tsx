"use client";

import { useState, useCallback, useEffect } from "react";
import Header from "@/components/Header";
import SwipeDeck from "@/components/SwipeDeck";
import SwipeActions from "@/components/SwipeActions";
import ExplainScreen from "@/components/explain/ExplainScreen";
import EmptyState from "@/components/EmptyState";
import QueueSummaryBar from "@/components/QueueSummaryBar";
import StaleBanner from "@/components/StaleBanner";
import DimensionBreakdown from "@/components/risk/DimensionBreakdown";
import VetoCard from "@/components/risk/VetoCard";
import { useAuth } from "@/hooks/useAuth";
import { useSwipeHistory } from "@/hooks/useSwipeHistory";
import { usePRs } from "@/hooks/usePRs";
import { useExplanation } from "@/hooks/useExplanation";
import { useReviewers } from "@/hooks/useReviewers";
import type { TriagedPR } from "@/lib/types";
import type { PolicyVerdict } from "@/lib/policy/gate";

type TriggerSwipe = { direction: "left" | "right" } | null;

export default function Home() {
  const auth = useAuth();
  const {
    hasReviewed,
    addTriage,
    history,
    clearHistory,
    loaded: historyLoaded,
  } = useSwipeHistory();
  const { prs, summary, stale, loading, error, refetch, removePR } = usePRs(
    hasReviewed,
    historyLoaded,
  );
  const {
    explanation,
    loading: explaining,
    error: explainError,
    errorKind,
    fetchExplanation,
    reset: resetExplanation,
  } = useExplanation();
  const {
    suggestion: reviewers,
    loading: reviewersLoading,
    fetchReviewers,
    reset: resetReviewers,
  } = useReviewers();

  const [explainPR, setExplainPR] = useState<TriagedPR | null>(null);
  const [breakdownPR, setBreakdownPR] = useState<TriagedPR | null>(null);
  const [triggerSwipe, setTriggerSwipe] = useState<TriggerSwipe>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [veto, setVeto] = useState<{
    pr: TriagedPR;
    verdict: PolicyVerdict;
  } | null>(null);

  const topPR = prs[0] ?? null;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  // Left: this PR needs a human to sit down with it. It enters the deep-review
  // lane rather than being dismissed.
  const handleNeedsReview = useCallback(
    (pr: TriagedPR) => {
      addTriage(
        pr.repository.nameWithOwner,
        pr.number,
        "needs-review",
        pr.risk.score,
      );
      removePR(pr.repository.nameWithOwner, pr.number);
      showToast(`#${pr.number} saved to Needs review`);
    },
    [addTriage, removePR],
  );

  // Right: fast-track. This records a triage decision only — it never approves
  // or merges anything on GitHub. A human still reviews the PR; it simply goes
  // into the quick lane rather than being opened first.
  const handleFastTrack = useCallback(
    async (pr: TriagedPR) => {
      const repo = pr.repository.nameWithOwner;

      // The policy gate decides, not the swipe. A vetoed PR stays in the deck
      // and the card flips to show why — the system refusing its own
      // recommendation rather than quietly accepting it.
      let gatePassed = true;
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo,
            number: pr.number,
            action: "fast-track",
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (!data.accepted && data.verdict) {
            setVeto({ pr, verdict: data.verdict });
            gatePassed = false;
          }
        } else {
          // If the server returns 5xx (e.g. rate limit, auth failure), we must NOT
          // silently wave the PR through. The gate is structural.
          showToast("Failed to verify policy gate.");
          gatePassed = false;
        }
      } catch {
        // Pure network failure (offline). Proceeding locally ensures the app
        // is usable offline, but we still log it.
        console.warn("Network offline; fast-tracking locally.");
      }

      if (!gatePassed) return;

      addTriage(repo, pr.number, "fast-track", pr.risk.score);
      removePR(repo, pr.number);
      showToast(`#${pr.number} saved to Fast-track`);
    },
    [addTriage, removePR],
  );

  // Explanations are fetched only when a card is opened — browsing the deck
  // costs no tokens, and the deck never waits on a model to paint.
  const openExplain = useCallback(() => {
    if (!topPR) return;
    setExplainPR(topPR);
    fetchExplanation(topPR.repository.nameWithOwner, topPR.number);
    fetchReviewers(topPR.repository.nameWithOwner, topPR.number);
  }, [topPR, fetchExplanation, fetchReviewers]);

  const triggerNeedsReview = useCallback(() => {
    if (!topPR) return;
    setTriggerSwipe({ direction: "left" });
  }, [topPR]);

  const triggerFastTrack = useCallback(() => {
    if (!topPR) return;
    setTriggerSwipe({ direction: "right" });
  }, [topPR]);

  // `ready` is the server's answer to "can this deployment serve data?" —
  // true for demo and local-token modes without anyone signing in. Inferring
  // it from `signedIn` here was the bug: a working local token still bounced
  // to a sign-in page that had nothing to sign in to.
  useEffect(() => {
    if (!auth.loading && !auth.ready) {
      window.location.href = "/signin";
    }
  }, [auth.loading, auth.ready]);

  if (auth.loading || !auth.ready) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
      </div>
    );
  }

  // The refusal. Rendered before anything else: a vetoed swipe must not be
  // able to fall through to the deck.
  if (veto) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-center bg-gray-50 p-4">
        <div className="mx-auto h-[70vh] w-full max-w-md">
          <VetoCard
            pr={veto.pr}
            verdict={veto.verdict}
            onDismiss={() => setVeto(null)}
          />
        </div>
      </div>
    );
  }

  // The audit view — full screen, because "why that number?" deserves the
  // whole viewport rather than a cramped popover.
  if (breakdownPR) {
    return (
      <DimensionBreakdown
        title={breakdownPR.title}
        prNumber={breakdownPR.number}
        risk={breakdownPR.risk}
        baseline={breakdownPR.baseline}
        onClose={() => setBreakdownPR(null)}
      />
    );
  }

  if (explainPR) {
    return (
      <ExplainScreen
        pr={explainPR}
        explanation={explanation}
        loading={explaining}
        error={explainError}
        errorKind={errorKind}
        onRetry={() =>
          fetchExplanation(
            explainPR.repository.nameWithOwner,
            explainPR.number,
            true,
          )
        }
        reviewers={reviewers}
        reviewersLoading={reviewersLoading}
        onClose={() => {
          setExplainPR(null);
          resetExplanation();
          resetReviewers();
        }}
      />
    );
  }

  return (
    <>
      <Header
        onRefresh={refetch}
        loading={loading}
        login={auth.login}
        avatarUrl={auth.avatarUrl}
        demoMode={auth.demoMode}
        mode={auth.mode}
        onSignOut={auth.signOut}
      />

      <main className="flex flex-col flex-1 pb-4 min-h-0 overflow-hidden">
        {loading && prs.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-700 rounded-full animate-spin" />
            <p className="text-xs text-gray-400">Scoring your queue…</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <p className="text-red-500 font-medium">Could not load the queue</p>
            <p className="text-sm text-gray-500">{error}</p>
            <button
              onClick={refetch}
              className="px-4 py-2 bg-gray-900 text-white rounded-full text-sm"
            >
              Try again
            </button>
          </div>
        ) : prs.length === 0 ? (
          <EmptyState
            onRefresh={refetch}
            loading={loading}
            history={history}
            onClearHistory={() => {
              clearHistory();
              refetch();
            }}
          />
        ) : (
          <>
            <StaleBanner stale={stale} />
            <QueueSummaryBar summary={summary} remaining={prs.length} />

            <div className="flex flex-col flex-1 min-h-0 px-4">
              <SwipeDeck
                prs={prs}
                onSwipeLeft={handleNeedsReview}
                onSwipeRight={handleFastTrack}
                onShowBreakdown={setBreakdownPR}
                triggerSwipe={triggerSwipe}
                onTriggerConsumed={() => setTriggerSwipe(null)}
              />
              <SwipeActions
                onNeedsReview={triggerNeedsReview}
                onExplain={openExplain}
                onFastTrack={triggerFastTrack}
                disabled={!topPR}
              />
            </div>
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
