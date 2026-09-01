"use client";

import { useState, useCallback } from "react";
import type { SwipeRecord, SwipeDirection } from "@/lib/types";

export function useSwipeHistory() {
  const [history, setHistory] = useState<SwipeRecord[]>([]);

  const addSwipe = useCallback(
    (repo: string, prNumber: number, direction: SwipeDirection) => {
      setHistory((prev) => [
        ...prev,
        { repo, prNumber, direction, timestamp: Date.now() },
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

  return { history, addSwipe, hasReviewed, clearHistory };
}
