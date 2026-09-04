/**
 * Two-tier cache.
 *
 *   L1  in-memory   — per process, fast, lost on restart
 *   L2  on disk     — `.pocketreview/cache/`, survives restart
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

const CACHE_DIR = join(process.cwd(), ".pocketreview", "cache");

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

/** Cache key. `headSha` is mandatory — see the module comment. */
export function cacheKey(
  namespace: string,
  repo: string,
  number: number,
  headSha: string,
): string {
  return `${namespace}:${repo}:${number}:${headSha}`;
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

/** Clear both tiers. Used by tests. */
export function clearMemory(): void {
  memory.clear();
}

export const __internals = { containsPatch, filenameFor, TTL_MS };
