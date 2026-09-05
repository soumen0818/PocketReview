"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Which repository the queue is scoped to, if any.
 *
 * **The default is deliberately no repository at all.** With no scope the queue
 * is every open PR across every repository where someone requested *your*
 * review — which is the question this product exists to answer. Asking a user
 * to pick a repository before showing them anything would break that: the
 * review plan solves a knapsack across the whole queue, and scoping to one repo
 * gives a locally-optimal plan that can miss the critical PR sitting elsewhere.
 *
 * The scope exists for one real case: nobody has requested your review on
 * anything, so the search returns nothing and there is no queue to triage. That
 * is a legitimate state on a working account, and "look at a specific repo
 * instead" is a better answer than an empty screen.
 *
 * Persisted so it survives a refresh and the trip to `/plan` — a scope that
 * silently reset between screens would show the plan for a different queue than
 * the deck, which is worse than having no scope at all.
 */
const STORAGE_KEY = "pocketreview:repo-scope";

/** GitHub's real slug shape. Mirrors `isValidRepo` on the server. */
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoSlug(value: string): boolean {
  return REPO_SLUG.test(value.trim());
}

export function useRepoScope() {
  const [repo, setRepoState] = useState<string | null>(null);

  /**
   * False until localStorage has been read.
   *
   * The queue must not be fetched before this resolves — an unscoped fetch
   * followed by a scoped one would show the wrong PRs for a moment and burn a
   * GitHub round trip to do it.
   */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      // Validated on read, not just on write: a hand-edited or half-written
      // value must not reach the API as a malformed slug.
      if (stored && isRepoSlug(stored)) setRepoState(stored);
    } catch {
      // Private mode, or storage disabled. No scope is a working default.
    }
    setLoaded(true);
  }, []);

  const setRepo = useCallback((next: string | null) => {
    const value = next?.trim() ?? null;

    if (value && !isRepoSlug(value)) return;

    setRepoState(value);
    try {
      if (value) window.localStorage.setItem(STORAGE_KEY, value);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Scope still applies for this session even if it cannot be persisted.
    }
  }, []);

  const clearRepo = useCallback(() => setRepo(null), [setRepo]);

  return { repo, setRepo, clearRepo, loaded };
}
