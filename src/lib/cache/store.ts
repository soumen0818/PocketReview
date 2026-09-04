/**
 * Three-tier cache.
 *
 *   L1  in-memory   — per process/instance, fast, lost on cold start
 *   L2  Upstash Redis — shared across instances, optional
 *   L3  on disk     — local development only; serverless filesystems are
 *                     read-only and instances are ephemeral, so this tier is
 *                     skipped there rather than failing on every write
 *
 * **Keyed on `headSha`**, which is the crucial choice: a PR that has not been
 * pushed to is never recomputed, so a repeated demo run is instant and
 * identical. Keying on `repo:number` alone would serve stale data after a push,
 * which is worse than not caching at all.
 *
 * **Signals and derived values only — never diff content.** `docs/security.md`
 * promises no source code is persisted, and that promise is kept here rather
 * than in prose: `write` refuses anything carrying a `patch` field.
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { Redis } from "@upstash/redis";

const CACHE_DIR = join(process.cwd(), ".pocketreview", "cache");

/**
 * Shared cache, when one is configured.
 *
 * Optional on purpose. Without Redis the app still works — a cold start simply
 * refetches from GitHub — so the project deploys with zero infrastructure and
 * gains a shared cache later by setting two environment variables. Requiring a
 * database to run a demo is a worse default than a slightly slower cold start.
 */
let redis: Redis | null | undefined;

function sharedCache(): Redis | null {
  if (redis !== undefined) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}

/** True when this process has a writable filesystem worth caching to. */
function diskAvailable(): boolean {
  // Vercel and most serverless runtimes expose a read-only filesystem outside
  // /tmp, and instances are discarded between invocations — writing there is
  // wasted work that also throws on every call.
  return !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME;
}

/** Entries older than this are ignored and swept. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** L1 ceiling, so a long-lived server cannot grow without bound. */
const MAX_MEMORY_ENTRIES = 300;

interface Envelope<T> {
  value: T;
  storedAt: number;
  /** Recorded so a stale read can tell the UI how old the data is. */
  key: string;
}

const memory = new Map<string, Envelope<unknown>>();

/**
 * Cache key.
 *
 * **The user id is not optional.** Without it, a cache entry for a private
 * pull request would be served to any user who asked for the same
 * `repo:number:headSha` — including one whose GitHub account cannot see that
 * repository at all. That is a cross-account data leak, and it is prevented
 * here rather than by remembering to check permissions at every read.
 *
 * `headSha` is equally mandatory: a PR that has been pushed to must miss.
 */
export function cacheKey(
  namespace: string,
  userId: number | string,
  repo: string,
  number: number,
  headSha: string,
): string {
  return `${namespace}:u${userId}:${repo}:${number}:${headSha}`;
}

/** Key for a whole-queue entry, which is inherently per-user. */
export function queueKey(
  userId: number | string,
  repo: string | null,
  limit: number,
): string {
  return `queue:u${userId}:${repo ?? "@me"}:${limit}`;
}

/** Filesystem-safe filename for a key. */
function filenameFor(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json";
}

/**
 * Refuse to persist anything containing raw diff text.
 *
 * A structural guard rather than a convention: the no-source-persistence
 * guarantee should not depend on every future caller remembering it.
 */
function containsPatch(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;

  if (Array.isArray(value)) {
    return value.some((item) => containsPatch(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if ("patch" in record && typeof record.patch === "string") return true;

  return Object.values(record).some((v) => containsPatch(v, depth + 1));
}

/** Read through L1 then L2. Returns undefined on a miss. */
export async function read<T>(key: string): Promise<T | undefined> {
  const hit = memory.get(key);
  if (hit) {
    if (Date.now() - hit.storedAt <= TTL_MS) {
      // Refresh recency for LRU eviction.
      memory.delete(key);
      memory.set(key, hit);
      return hit.value as T;
    }
    memory.delete(key);
  }

  const shared = sharedCache();
  if (shared) {
    try {
      const envelope = await shared.get<Envelope<T>>(key);
      if (envelope && Date.now() - envelope.storedAt <= TTL_MS) {
        remember(key, envelope);
        return envelope.value;
      }
    } catch {
      // A Redis outage must not take the app down — fall through to disk,
      // then to a miss, which simply means refetching from GitHub.
    }
  }

  if (!diskAvailable()) return undefined;

  try {
    const raw = await readFile(join(CACHE_DIR, filenameFor(key)), "utf8");
    const envelope = JSON.parse(raw) as Envelope<T>;

    if (Date.now() - envelope.storedAt > TTL_MS) return undefined;

    // Promote into L1 so the next read skips the disk.
    remember(key, envelope);
    return envelope.value;
  } catch {
    return undefined;
  }
}

/** Write to L1 and L2. Disk failures are non-fatal. */
export async function write<T>(key: string, value: T): Promise<void> {
  if (containsPatch(value)) {
    throw new Error(
      `Refusing to cache "${key}": the value contains diff content. ` +
        "The cache stores signals and derived values only — never source code.",
    );
  }

  const envelope: Envelope<T> = { value, storedAt: Date.now(), key };
  remember(key, envelope);

  const shared = sharedCache();
  if (shared) {
    try {
      // Expire in Redis too, so an abandoned key cannot occupy the free tier
      // indefinitely.
      await shared.set(key, envelope, { ex: Math.floor(TTL_MS / 1000) });
    } catch {
      // Non-fatal, as above.
    }
  }

  if (!diskAvailable()) return;

  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(
      join(CACHE_DIR, filenameFor(key)),
      JSON.stringify(envelope),
      "utf8",
    );
  } catch {
    // A read-only filesystem degrades to L1 only. Not worth failing a request.
  }
}

function remember<T>(key: string, envelope: Envelope<T>): void {
  if (memory.size >= MAX_MEMORY_ENTRIES && !memory.has(key)) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, envelope as Envelope<unknown>);
}

/** Read-through helper: compute and cache on a miss. */
export async function resolve<T>(
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = await read<T>(key);
  if (hit !== undefined) return hit;

  const value = await compute();
  await write(key, value);
  return value;
}

/**
 * Age of a cached entry in milliseconds, or null when absent.
 *
 * Used by the staleness banner: when GitHub rate-limits us and we fall back to
 * cache, the UI has to say how old what it is showing actually is.
 */
export async function ageOf(key: string): Promise<number | null> {
  const hit = memory.get(key);
  if (hit) return Date.now() - hit.storedAt;

  const shared = sharedCache();
  if (shared) {
    try {
      const envelope = await shared.get<Envelope<unknown>>(key);
      if (envelope) return Date.now() - envelope.storedAt;
    } catch {
      // Fall through.
    }
  }

  if (!diskAvailable()) return null;

  try {
    const raw = await readFile(join(CACHE_DIR, filenameFor(key)), "utf8");
    const envelope = JSON.parse(raw) as Envelope<unknown>;
    return Date.now() - envelope.storedAt;
  } catch {
    return null;
  }
}

/** Drop expired entries from disk. Safe to call at startup. */
export async function sweep(): Promise<number> {
  let removed = 0;
  try {
    const files = await readdir(CACHE_DIR);
    for (const file of files) {
      const path = join(CACHE_DIR, file);
      const info = await stat(path);
      if (Date.now() - info.mtimeMs > TTL_MS) {
        await unlink(path);
        removed++;
      }
    }
  } catch {
    // No cache directory yet.
  }
  return removed;
}

/** Clear the in-memory tier. Used by tests. */
export function clearMemory(): void {
  memory.clear();
}

/** Reset the Redis client. Used by tests. */
export function resetSharedCache(): void {
  redis = undefined;
}

/** Which tiers are active, for the health endpoint. */
export function cacheTiers(): { memory: true; redis: boolean; disk: boolean } {
  return { memory: true, redis: sharedCache() !== null, disk: diskAvailable() };
}

export const __internals = { containsPatch, filenameFor, TTL_MS };
