"use client";

import { useState, useCallback, useEffect } from "react";
import type { TriageRecord, TriageAction } from "@/lib/types";

/**
 * Record of triage decisions, persisted per browser.
 *
 * `riskAtDecision` is stored deliberately: it is the audit trail that lets the
 * queue later say "you fast-tracked this at 18; it has since been pushed to
 * and now scores 61". Cheap to keep, and it makes the decision reviewable
 * rather than merely recorded.
 *
 * **Why `localStorage` rather than a database.** Triage decisions are personal
 * and disposable — nobody else needs to read them, and losing them costs a
 * re-swipe. Keeping them client-side means no user table, no server-side store
 * to secure, and nothing to clean up when someone stops using the app. If
 * decisions ever need to be shared across devices or between teammates, that
 * is the point to add a database, not before.
 *
 * Previously this was plain `useState`, so a refresh silently resurrected every
 * PR you had just triaged.
 */

const STORAGE_KEY = "pocketreview.triage.v1";

/** Records older than this are dropped — a stale decision is not evidence. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Hard cap, so a heavy user cannot fill the storage quota. */
const MAX_RECORDS = 500;

/**
 * Load and prune stored decisions.
 *
 * Every failure mode here is survivable and none should break the deck:
 * storage can be disabled (private browsing), full, or hold data written by an
 * older version of the app. All of them fall back to an empty history.
 */
function load(): TriageRecord[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const cutoff = Date.now() - MAX_AGE_MS;

    return parsed
      .filter(
        (r): r is TriageRecord =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as TriageRecord).repo === "string" &&
          typeof (r as TriageRecord).prNumber === "number" &&
          typeof (r as TriageRecord).timestamp === "number" &&
          (r as TriageRecord).timestamp > cutoff,
      )
      .slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

function save(records: TriageRecord[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(records.slice(-MAX_RECORDS)),
    );
  } catch {
    // Quota exceeded, or storage disabled. The session still works; only the
    // memory of it is lost, which is not worth interrupting triage for.
  }
}

export function useSwipeHistory() {
  // Starts empty on both server and client so the markup matches; the stored
  // history is loaded in an effect to avoid a hydration mismatch.
  const [history, setHistory] = useState<TriageRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setHistory(load());
    setLoaded(true);
  }, []);

  useEffect(() => {
    // Do not write before the first read, or an empty initial state would
    // overwrite everything the user did in a previous session.
    if (loaded) save(history);
  }, [history, loaded]);

  const addTriage = useCallback(
    (
      repo: string,
      prNumber: number,
      action: TriageAction,
      riskAtDecision: number,
    ) => {
      setHistory((prev) => [
        // A PR triaged twice keeps only the latest decision.
        ...prev.filter((r) => !(r.repo === repo && r.prNumber === prNumber)),
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

  /** The decision made about one PR, if any. */
  const decisionFor = useCallback(
    (repo: string, prNumber: number): TriageRecord | undefined =>
      history.find((r) => r.repo === repo && r.prNumber === prNumber),
    [history],
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    save([]);
  }, []);

  return {
    history,
    /** False until stored decisions have been read — the queue waits for this. */
    loaded,
    addTriage,
    hasReviewed,
    decisionFor,
    clearHistory,
  };
}
