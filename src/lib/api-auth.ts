/**
 * API authentication & rate limiting middleware.
 *
 * Authentication: Bearer token via the `Authorization` header or
 * `x-api-key` header, matched against `API_SECRET`. When `API_SECRET`
 * is not set (development / demo), all requests are allowed through —
 * set it before any public deployment.
 *
 * Rate limiting: simple in-memory sliding-window per IP. Resets on
 * process restart. Good enough for a personal tool; swap for Redis in
 * a multi-instance deployment.
 */

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

/** Remove stale entries to keep memory bounded. */
function pruneWindows(): void {
  const cutoff = Date.now() - 60_000;
  for (const [ip, entry] of windows.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) windows.delete(ip);
  }
}

let lastPrune = 0;

/**
 * Returns true if the given IP has exceeded `maxPerMinute` requests in
 * the last 60 seconds.
 */
export function isRateLimited(ip: string, maxPerMinute = 30): boolean {
  const now = Date.now();

  // Prune stale entries at most once every 30 seconds.
  if (now - lastPrune > 30_000) {
    pruneWindows();
    lastPrune = now;
  }

  const entry = windows.get(ip) ?? { timestamps: [] };
  const cutoff = now - 60_000;
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
  entry.timestamps.push(now);
  windows.set(ip, entry);

  return entry.timestamps.length > maxPerMinute;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Returns a 401 Response if the request fails authentication, or null if
 * it passes. When `API_SECRET` is not configured, all requests pass.
 */
export function checkAuth(request: Request): Response | null {
  const secret = process.env.API_SECRET;
  if (!secret) return null; // dev / demo — open access

  const authHeader = request.headers.get("authorization") ?? "";
  const apiKeyHeader = request.headers.get("x-api-key") ?? "";

  const provided =
    authHeader.startsWith("Bearer ") ? authHeader.slice(7) : apiKeyHeader;

  if (provided !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Combined guard — call this at the top of every route handler
// ---------------------------------------------------------------------------

/**
 * Runs both auth and rate-limit checks.
 *
 * Returns a ready-to-send error Response if either check fails, or null
 * when the request is allowed through.
 *
 * Usage:
 *   const guard = guardRequest(request);
 *   if (guard) return guard;
 */
export function guardRequest(
  request: Request,
  options: { maxPerMinute?: number } = {},
): Response | null {
  const { maxPerMinute = 30 } = options;

  // Authentication first — never hand rate-limit info to an unauthenticated
  // caller, as that is information about the system's load.
  const authResult = checkAuth(request);
  if (authResult) return authResult;

  // Extract IP from standard headers set by Vercel / proxies / Next.js.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  if (isRateLimited(ip, maxPerMinute)) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please slow down." }),
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
