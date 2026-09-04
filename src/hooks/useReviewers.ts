"use client";

import { useState, useCallback, useRef } from "react";
import type { ReviewerSuggestion } from "@/lib/engines/reviewer-engine";

/**
 * Fetches reviewer suggestions for one PR, on demand.
 *
 * Lazy and memoised per session: the expertise matrix is expensive to build,
 * and the deck must never wait on it. A failure resolves to `null`, which the
 * card renders as nothing — the same as low confidence.
 */
export function useReviewers() {
  const [suggestion, setSuggestion] = useState<ReviewerSuggestion | null>(null);
  const [loading, setLoading] = useState(false);

  const seen = useRef(new Map<string, ReviewerSuggestion | null>());
  const requestId = useRef(0);

  const fetchReviewers = useCallback(async (repo: string, prNumber: number) => {
    const key = `${repo}#${prNumber}`;
    const id = ++requestId.current;

    const memo = seen.current.get(key);
    if (memo !== undefined) {
      setSuggestion(memo);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `/api/reviewers?repo=${encodeURIComponent(repo)}&number=${prNumber}`,
      );
      if (id !== requestId.current) return;

      if (!res.ok) {
        seen.current.set(key, null);
        setSuggestion(null);
        return;
      }

      const data = (await res.json()) as ReviewerSuggestion;
      seen.current.set(key, data);
      setSuggestion(data);
    } catch {
      if (id === requestId.current) setSuggestion(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    requestId.current++;
    setSuggestion(null);
    setLoading(false);
  }, []);

  return { suggestion, loading, fetchReviewers, reset };
}
