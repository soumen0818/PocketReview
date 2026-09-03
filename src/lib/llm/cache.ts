/**
 * Explanation cache.
 *
 * Keyed on `repo:number:headSha` — **the headSha is the whole point.** A PR
 * that has not been pushed to is never re-explained, so a demo rehearsed
 * twenty times costs one run of tokens rather than twenty, and the words on
 * screen are identical every time. Keying on `repo:number` alone would serve
 * a stale explanation after a push, which is worse than not caching at all.
 *
 * In-memory only. Nothing is written to disk: the cache holds model prose and
 * never diff content, which keeps the no-persistence guarantee in
 * `docs/security.md` true. A restart costs one repopulation.
 */

/** Entries older than this are re-fetched even if the head has not moved. */
const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Hard ceiling on entries, so a long-lived server cannot grow without bound. */
const MAX_ENTRIES = 500;

interface Entry<T> {
  value: T;
  storedAt: number;
}

/**
 * A cache scoped to one kind of value.
 *
 * Separate instances keep the one-line deck summaries and the full
 * explanations from evicting each other — they have very different sizes and
 * access patterns.
 */
export class ExplanationCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number = TTL_MS,
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  /** Cache key. `headSha` is required — a key without it can serve stale prose. */
  static key(repo: string, number: number, headSha: string): string {
    return `${repo}:${number}:${headSha}`;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh recency for the LRU eviction below.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Map preserves insertion order, so the first key is the least recently
    // used once `get` re-inserts on every hit.
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

    this.entries.set(key, { value, storedAt: Date.now() });
  }

  /**
   * Read through the cache, computing on a miss.
   *
   * Concurrent callers for the same key share one in-flight computation, so a
   * queue fan-out cannot fire six identical requests for the same PR.
   */
  async resolve(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, promise);
    return promise;
  }

  private readonly pending = new Map<string, Promise<T>>();

  /** Entries currently held. Used by tests and the debug endpoint. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }
}
