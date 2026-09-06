"use client";

/**
 * The triage deck.
 *
 * Receives the resolved auth state as a prop rather than fetching it. The
 * server already knows whether this deployment can serve data, so asking again
 * from the browser only bought a spinner and — on an unconfigured deployment —
 * a visible bounce to `/signin`. `page.tsx` resolves it and redirects before
 * anything paints; by the time this renders, the answer is already settled.
 */

import { useState, useCallback } from "react";
import Header from "@/components/Header";
import SwipeDeck from "@/components/SwipeDeck";
import SwipeActions from "@/components/SwipeActions";
import ExplainScreen from "@/components/explain/ExplainScreen";
import EmptyState from "@/components/EmptyState";
import QueueSummaryBar from "@/components/QueueSummaryBar";
import StaleBanner from "@/components/StaleBanner";
import DimensionBreakdown from "@/components/risk/DimensionBreakdown";
import VetoCard from "@/components/risk/VetoCard";
import { RepoScopeBadge } from "@/components/RepoScopeInput";
import { useSignOut, type AuthState } from "@/hooks/useAuth";
import { useSwipeHistory } from "@/hooks/useSwipeHistory";
import { useRepoScope } from "@/hooks/useRepoScope";
import { usePRs } from "@/hooks/usePRs";
import { useExplanation } from "@/hooks/useExplanation";
import { useReviewers } from "@/hooks/useReviewers";
import type { TriagedPR } from "@/lib/types";
import type { PolicyVerdict } from "@/lib/policy/gate";

type TriggerSwipe = { direction: "left" | "right" } | null;

export default function TriageApp({ auth }: { auth: AuthState }) {
  const signOut = useSignOut();
  const {
    hasReviewed,
    addTriage,
    history,
    clearHistory,
    loaded: historyLoaded,
  } = useSwipeHistory();
  const {
    repo: scopedRepo,
    setRepo: setScopedRepo,
    clearRepo: clearScopedRepo,
    loaded: scopeLoaded,
  } = useRepoScope();

  // Both gates must be open before fetching: history so triaged PRs stay
  // triaged, scope so the first request is for the right queue.
  const { prs, summary, stale, loading, error, refetch, removePR } = usePRs(
    hasReviewed,
    historyLoaded && scopeLoaded,
    scopedRepo,
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

  // Down: defer. Pushes the PR down the priority queue without removing it from GitHub.
  const handleDefer = useCallback(
    (pr: TriagedPR) => {
      addTriage(
        pr.repository.nameWithOwner,
        pr.number,
        "defer",
        pr.risk.score,
      );
      removePR(pr.repository.nameWithOwner, pr.number);
      showToast(`#${pr.number} deferred`);
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

  const handleSwipeExplain = useCallback(
    (pr: TriagedPR) => {
      setExplainPR(pr);
      fetchExplanation(pr.repository.nameWithOwner, pr.number);
      fetchReviewers(pr.repository.nameWithOwner, pr.number);
    },
    [fetchExplanation, fetchReviewers]
  );

  const triggerNeedsReview = useCallback(() => {
    if (!topPR) return;
    setTriggerSwipe({ direction: "left" });
  }, [topPR]);

  const triggerFastTrack = useCallback(() => {
    if (!topPR) return;
    setTriggerSwipe({ direction: "right" });
  }, [topPR]);

  // No auth gate here any more. `page.tsx` resolves the mode on the server and
  // redirects an unservable deployment to `/signin` before this ever renders,
  // so reaching this point already means the app can serve data.

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
        onSignOut={signOut}
      />

      {/* Outside the branching below, so it is present in every state — the
          error state included, where a mistyped repository is the likeliest
          cause and clearing the scope is the fix. */}
      {scopedRepo && (
        <RepoScopeBadge repo={scopedRepo} onClear={clearScopedRepo} />
      )}

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
            scopedRepo={scopedRepo}
            // Demo mode serves fixtures and never queries GitHub, so scoping
            // to a repository there would silently do nothing.
            onScopeRepo={auth.demoMode ? undefined : setScopedRepo}
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
                onSwipeDown={handleDefer}
                onSwipeUp={handleSwipeExplain}
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
