"use client";

import { useState, useEffect, useCallback } from "react";
import type { TriagedPR, QueueSummary } from "@/lib/types";

interface QueueResponse {
  prs: TriagedPR[];
  summary: QueueSummary;
}

const EMPTY_SUMMARY: QueueSummary = {
  total: 0,
  byLevel: { low: 0, medium: 0, high: 0, critical: 0 },
  hasLowConfidence: false,
  totalMinutes: 0,
  totalMinutesLabel: "0 min",
  minutesByLevel: { low: 0, medium: 0, high: 0, critical: 0 },
  suppressed: 0,
};

/**
 * Loads the scored triage queue.
 *
 * The response is fully deterministic, so once this resolves the deck can
 * render everything it needs — there is no second phase waiting on a model.
 */
export function usePRs(
  hasReviewed: (repo: string, prNumber: number) => boolean,
) {
  const [prs, setPRs] = useState<TriagedPR[]>([]);
  const [summary, setSummary] = useState<QueueSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPRs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prs");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const data: QueueResponse = await res.json();

      // Already-triaged PRs are filtered client-side so a refresh does not
      // resurrect decisions made moments ago.
      const remaining = data.prs.filter(
        (pr) => !hasReviewed(pr.repository.nameWithOwner, pr.number),
      );

      setPRs(remaining);
      setSummary(data.summary ?? EMPTY_SUMMARY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [hasReviewed]);

  useEffect(() => {
    fetchPRs();
  }, [fetchPRs]);

  const removePR = useCallback((repo: string, prNumber: number) => {
    setPRs((prev) =>
      prev.filter(
        (pr) =>
          !(pr.repository.nameWithOwner === repo && pr.number === prNumber),
      ),
    );
  }, []);

  return { prs, summary, loading, error, refetch: fetchPRs, removePR };
}
