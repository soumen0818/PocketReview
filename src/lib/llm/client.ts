/**
 * Anthropic client.
 *
 * The SDK over HTTPS, not a `claude` CLI subprocess. Same reasoning as
 * Decision Log #2 for replacing `gh` with Octokit: no ~800ms process spawn per
 * call, real errors and status codes, genuine parallelism, and no dependency
 * on a CLI being installed and authenticated on the demo machine.
 *
 * Everything here degrades rather than throws upward. The explanation layer is
 * strictly additive — if the model is unreachable, out of credit, or slow, the
 * deck must still paint every score, rank and plan. That is what makes "turn
 * the LLM off and the system still works" a testable claim rather than a slogan.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Model tiering.
 *
 * Haiku for the one-line deck summaries: high volume, low stakes, ~$1/MTok in.
 * Sonnet for the full explain screen: on demand, one at a time, worth the
 * extra quality. Opus is deliberately not used — nothing here needs it, and
 * the cost difference across a demo queue is real.
 */
export const MODELS = {
  /** Deck card one-liners. */
  summary: "claude-haiku-4-5",
  /** The full explanation screen. */
  explain: "claude-sonnet-5",
} as const;

/** Parallel model calls. Matches the GitHub fan-out ceiling. */
const MAX_CONCURRENT = 6;

/** A single call may not hold the queue up forever. */
const REQUEST_TIMEOUT_MS = 30_000;

let cachedClient: Anthropic | null = null;

/** True when an API key is present. Never logs or returns the key itself. */
export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Shared client, created on first use.
 *
 * Returns null rather than throwing when no key is configured — a missing key
 * is a supported configuration (`llm.enabled: false`), not an error.
 */
export function anthropic(): Anthropic | null {
  if (cachedClient) return cachedClient;
  if (!hasApiKey()) return null;

  cachedClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
  });

  return cachedClient;
}

/** Reset the cached client. Used by tests. */
export function resetClient(): void {
  cachedClient = null;
}

/** Why an explanation is unavailable, when it is. */
export type LLMFailure =
  | "no-api-key"
  | "disabled"
  | "rate-limited"
  | "timeout"
  | "api-error";

export class LLMUnavailable extends Error {
  constructor(
    readonly kind: LLMFailure,
    message: string,
  ) {
    super(message);
    this.name = "LLMUnavailable";
  }
}

/**
 * Classify a thrown error into something the UI can say out loud.
 *
 * Typed SDK exception classes, not string matching on messages.
 */
export function classifyError(error: unknown): LLMUnavailable {
  if (error instanceof LLMUnavailable) return error;

  if (error instanceof Anthropic.RateLimitError) {
    return new LLMUnavailable(
      "rate-limited",
      "Rate limited by the Anthropic API — try again shortly.",
    );
  }

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LLMUnavailable("timeout", "The explanation request timed out.");
  }

  if (error instanceof Anthropic.AuthenticationError) {
    return new LLMUnavailable(
      "api-error",
      "ANTHROPIC_API_KEY was rejected. Check the key in .env.local.",
    );
  }

  if (error instanceof Anthropic.APIError) {
    return new LLMUnavailable(
      "api-error",
      `Anthropic API error (${error.status ?? "unknown"}).`,
    );
  }

  return new LLMUnavailable(
    "api-error",
    error instanceof Error ? error.message : "Unknown error",
  );
}

/**
 * Run tasks with bounded concurrency.
 *
 * Mirrors `mapLimit` in the GitHub layer. A 20-PR queue must not open twenty
 * simultaneous model requests and trip a rate limit.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export { MAX_CONCURRENT };
