"use client";

import { useState, useEffect, useCallback } from "react";
import type { PullRequest } from "@/lib/types";

export function usePRs(
  hasReviewed: (repo: string, prNumber: number) => boolean,
) {
  const [prs, setPRs] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPRs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/prs");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch PRs");
      }
      const data: PullRequest[] = await res.json();
      const filtered = data.filter(
        (pr) => !hasReviewed(pr.repository.nameWithOwner, pr.number),
      );
      setPRs(filtered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [hasReviewed]);

  useEffect(() => {
    fetchPRs();
  }, [fetchPRs]);

  const removePR = useCallback((prNumber: number) => {
    setPRs((prev) => prev.filter((pr) => pr.number !== prNumber));
  }, []);

  return { prs, loading, error, refetch: fetchPRs, removePR };
}
