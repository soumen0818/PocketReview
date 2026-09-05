"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ReviewPlan, CapacityReport } from "@/lib/engines/review-plan";

interface PlanResponse {
  plan: ReviewPlan;
  capacity: CapacityReport;
}

/**
 * Loads the review plan for a time budget.
 *
 * Refetches whenever the budget changes — the solver is a pure function over
 * cached signals, so this is cheap. In-flight requests are superseded rather
 * than raced: tapping through budget presets quickly must never leave the UI
 * showing the answer to an older question.
 */
export function useReviewPlan(
  budgetMinutes: number,
  /**
   * Scope the plan to one repository. Must match whatever the deck is scoped
   * to — a plan built over a different queue than the one being triaged would
   * quietly recommend PRs the reviewer cannot see.
   */
  repo: string | null = null,
  /**
   * False until the scope has been read from storage.
   *
   * Without this the plan is fetched twice on every load — once unscoped, then
   * again once localStorage resolves — and the first answer is for the wrong
   * queue. Both are real GitHub round trips, so this is a correctness *and* a
   * rate-limit fix.
   */
  scopeLoaded = true,
) {
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Identifies the newest request, so stale responses can be discarded. */
  const requestId = useRef(0);

  const fetchPlan = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/review-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `repo` is omitted entirely when unscoped — the route treats an
        // absent field as "every repository", but rejects an explicit null.
        body: JSON.stringify(repo ? { budgetMinutes, repo } : { budgetMinutes }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const data: PlanResponse = await res.json();
      if (id !== requestId.current) return; // superseded

      setPlan(data.plan);
      setCapacity(data.capacity);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [budgetMinutes, repo]);

  useEffect(() => {
    if (scopeLoaded) fetchPlan();
  }, [fetchPlan, scopeLoaded]);

  return { plan, capacity, loading, error, refetch: fetchPlan };
}
