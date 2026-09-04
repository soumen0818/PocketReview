/**
 * Request rate limiting.
 *
 * A crude per-IP sliding window in front of every API route. It exists to stop
 * one client — a runaway `useEffect`, a script, an impatient refresh — from
 * exhausting a user's GitHub rate limit or running up an Anthropic bill.
 *
 * **This is not authentication.** Identity is settled by `withAuth`
 * (`src/lib/auth/guard.ts`), which binds each request to the signed-in user's
 * own GitHub token. An earlier version of this file also checked a shared
 * `API_SECRET` header; that was removed:
 *
 *   - it duplicated a check `withAuth` already performs, and
 *   - a browser cannot send an `Authorization` header on a normal page load,
 *     so setting `API_SECRET` in production would have 401'd every real user
 *     while leaving `curl` working — a trap that only fires once someone sets
 *     the variable.
 *
 * **Serverless caveat.** The window lives in process memory, so on Vercel each
 * function instance counts separately: a limit of 30/min is really "30/min per
 * warm instance". That makes this a backstop against runaway clients rather
 * than a precise quota. Moving the counter to Upstash would make it exact —
 * worth doing only if abuse becomes real, since the per-user GitHub rate limit
 * is the actual ceiling that matters.
 */

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

/** Requests older than this fall out of the window. */
const WINDOW_MS = 60_000;

/** How often to sweep idle clients out of the map. */
const PRUNE_INTERVAL_MS = 30_000;

/**
 * Ceiling on tracked clients.
 *
 * Without it, a spray of requests from many spoofed `x-forwarded-for` values
 * would grow the map without bound — a memory-exhaustion vector in the thing
 * meant to prevent resource exhaustion.
 */
const MAX_TRACKED_CLIENTS = 10_000;

let lastPrune = 0;

/** Drop entries whose requests have all aged out. */
function pruneWindows(): void {
  const cutoff = Date.now() - WINDOW_MS;

  for (const [client, entry] of windows.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) windows.delete(client);
  }
}

/**
 * True when this client has exceeded `maxPerMinute` in the last 60 seconds.
 *
 * Exported for tests; routes should call `guardRequest`.
 */
export function isRateLimited(client: string, maxPerMinute = 30): boolean {
  const now = Date.now();

  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    pruneWindows();
    lastPrune = now;
  }

  const entry = windows.get(client) ?? { timestamps: [] };
  const cutoff = now - WINDOW_MS;

  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
  entry.timestamps.push(now);

  // Evict the coldest client rather than let the map grow without bound.
  if (windows.size >= MAX_TRACKED_CLIENTS && !windows.has(client)) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }

  windows.set(client, entry);

  return entry.timestamps.length > maxPerMinute;
}

/**
 * Identify the caller.
 *
 * `x-forwarded-for` is client-controllable in general, but on Vercel the proxy
 * overwrites it, so the first entry is the real client. Falls back to a shared
 * bucket when no header is present — which throttles unidentifiable traffic
 * collectively rather than not at all.
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Rate-limit guard for a route handler.
 *
 * Returns a ready-to-send 429 when the caller is over the limit, or null when
 * the request may proceed.
 *
 *   const limited = guardRequest(request);
 *   if (limited) return limited;
 */
export function guardRequest(
  request: Request,
  options: { maxPerMinute?: number } = {},
): Response | null {
  const { maxPerMinute = 30 } = options;

  if (isRateLimited(clientKey(request), maxPerMinute)) {
    return new Response(
      JSON.stringify({
        error: "Too many requests. Please slow down.",
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      },
    );
  }

  return null;
}

/** Clear all windows. Used by tests. */
export function resetRateLimits(): void {
  windows.clear();
  lastPrune = 0;
}
