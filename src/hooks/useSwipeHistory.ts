"use client";

import { useState, useCallback } from "react";
import type { TriageRecord, TriageAction } from "@/lib/types";

/**
 * In-session record of triage decisions.
 *
 * `riskAtDecision` is stored deliberately: it is the audit trail that lets the
 * queue later say "you fast-tracked this at 18; it has since been pushed to
 * and now scores 61". Cheap to keep, and it makes the decision reviewable
 * rather than merely recorded.
 *
 * State lives in memory for the session. Persistence lands with the triage
 * endpoint in Phase 8.
 */
export function useSwipeHistory() {
  const [history, setHistory] = useState<TriageRecord[]>([]);

  const addTriage = useCallback(
    (
      repo: string,
      prNumber: number,
      action: TriageAction,
      riskAtDecision: number,
    ) => {
      setHistory((prev) => [
        ...prev,
        { repo, prNumber, action, riskAtDecision, timestamp: Date.now() },
      ]);
    },
    [],
  );

  const hasReviewed = useCallback(
    (repo: string, prNumber: number) =>
      history.some((r) => r.repo === repo && r.prNumber === prNumber),
    [history],
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  return { history, addTriage, hasReviewed, clearHistory };
}
