"use client";

import { useState, useCallback, useRef } from "react";
import type { Explanation } from "@/lib/llm/explain";

interface State {
  explanation: Explanation | null;
  loading: boolean;
  error: string | null;
  errorKind: string | null;
}

const IDLE: State = {
  explanation: null,
  loading: false,
  error: null,
  errorKind: null,
};

/**
 * Fetches the explanation for one PR, on demand.
 *
 * **Lazy by design.** Nothing is requested until the reviewer opens a card, so
 * browsing the deck costs no tokens. Results are memoised per PR for the
 * session, on top of the server's `headSha` cache, so reopening a card is free
 * and instant.
 */
export function useExplanation() {
  const [state, setState] = useState<State>(IDLE);

  /** Per-session memo, keyed repo#number. */
  const seen = useRef(new Map<string, Explanation>());
  /** Identifies the newest request so stale responses are discarded. */
  const requestId = useRef(0);

  const fetchExplanation = useCallback(
    async (repo: string, prNumber: number, force = false) => {
      const key = `${repo}#${prNumber}`;
      const id = ++requestId.current;

      if (!force) {
        const memo = seen.current.get(key);
        if (memo) {
          setState({ ...IDLE, explanation: memo });
          return;
        }
      }

      setState({ ...IDLE, loading: true });

      try {
        const res = await fetch(
          `/api/prs/${encodeURIComponent(repo)}/${prNumber}/explain`,
        );
        const data = await res.json().catch(() => ({}));

        if (id !== requestId.current) return; // superseded

        if (!res.ok) {
          setState({
            explanation: null,
            loading: false,
            error: data.error || `Request failed (${res.status})`,
            errorKind: data.kind ?? null,
          });
          return;
        }

        seen.current.set(key, data.explanation);
        setState({ ...IDLE, explanation: data.explanation });
      } catch (err) {
        if (id !== requestId.current) return;
        setState({
          explanation: null,
          loading: false,
          error: err instanceof Error ? err.message : "Unknown error",
          errorKind: null,
        });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    requestId.current++;
    setState(IDLE);
  }, []);

  return { ...state, fetchExplanation, reset };
}
