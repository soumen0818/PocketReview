/**
 * GitHub data access.
 *
 * Uses Octokit over HTTP rather than shelling out to the `gh` CLI. That
 * matters for three reasons:
 *
 *   1. Speed — a process spawn costs ~800ms before any work happens. Filling
 *      a 15-PR queue needs ~90 fetches; as subprocesses that is over a minute,
 *      as parallel HTTP requests it is a couple of seconds.
 *   2. Portability — the CLI must be installed and authenticated on whatever
 *      machine runs this. A token in the environment travels with the code.
 *   3. Structure — typed responses, real status codes, rate-limit headers and
 *      ETags for cheap conditional refetches.
 */

import { Octokit } from "@octokit/rest";

/** Concurrency ceiling for parallel GitHub calls. */
const MAX_CONCURRENT = 6;

let cachedClient: Octokit | null = null;

/** Shared Octokit instance, created on first use. */
export function github(): Octokit {
  if (cachedClient) return cachedClient;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it to .env.local — a token with `repo:read` scope is enough.",
    );
  }

  cachedClient = new Octokit({
    auth: token,
    userAgent: "pocketreview",
    request: { timeout: 20000 },
  });

  return cachedClient;
}

/** Reset the cached client. Used by tests. */
export function resetClient(): void {
  cachedClient = null;
  cachedViewer = undefined;
}

let cachedViewer: string | null | undefined;

/**
 * Login of the account the token belongs to.
 *
 * Used by the priority engine to suppress the viewer's own PRs — you cannot
 * review your own work. Cached for the process lifetime: the answer cannot
 * change without the token changing.
 *
 * Returns `null` rather than throwing when the lookup fails. Own-PR
 * suppression is a convenience, and a queue that 500s because `/user` was
 * unreachable would be a much worse failure than a queue containing one PR
 * the reviewer will skip.
 */
export async function getViewerLogin(): Promise<string | null> {
  if (cachedViewer !== undefined) return cachedViewer;

  try {
    const { data } = await github().request("GET /user");
    cachedViewer = data.login ?? null;
  } catch {
    cachedViewer = null;
  }

  return cachedViewer;
}

/**
 * Whether the last GitHub call hit a rate limit, and when it resets.
 *
 * Recorded rather than thrown so the queue can fall back to cache and the UI
 * can say *why* it is showing stale data. A silent fallback would be worse
 * than the error: the reviewer would trust an out-of-date queue.
 */
export interface RateLimitState {
  limited: boolean;
  /** Unix seconds when the limit resets, when known. */
  resetAt: number | null;
  remaining: number | null;
}

let rateLimit: RateLimitState = {
  limited: false,
  resetAt: null,
  remaining: null,
};

export function rateLimitState(): RateLimitState {
  return { ...rateLimit };
}

/** Record rate-limit headers from a response or error. */
export function noteRateLimit(headers: Record<string, unknown> | undefined) {
  if (!headers) return;

  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);

  if (Number.isFinite(remaining)) {
    rateLimit = {
      remaining,
      resetAt: Number.isFinite(reset) ? reset : null,
      limited: remaining <= 0,
    };
  }
}

/** True when an error is a GitHub rate-limit or abuse-detection response. */
export function isRateLimitError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status !== 403 && status !== 429) return false;

  const headers = (
    error as { response?: { headers?: Record<string, unknown> } }
  )?.response?.headers;
  noteRateLimit(headers);

  const remaining = Number(headers?.["x-ratelimit-remaining"]);
  return status === 429 || remaining === 0;
}

/** Reset the recorded state. Used by tests. */
export function resetRateLimit(): void {
  rateLimit = { limited: false, resetAt: null, remaining: null };
}

/**
 * Run tasks with a bounded concurrency.
 *
 * Prevents a 50-PR queue from opening 300 sockets at once and tripping
 * secondary rate limits.
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

/**
 * Validate an `owner/name` repository slug.
 *
 * Deliberately stricter than "contains one slash". GitHub owners and repository
 * names are limited to alphanumerics, hyphens, underscores and dots, with
 * length caps of 39 and 100. Accepting anything looser let newlines, null bytes
 * and unbounded strings reach the HTTP layer and the cache key — none of which
 * were exploitable in practice (Octokit encodes path params and cache
 * filenames are SHA-256 hashed), but validating to the real shape is free and
 * removes the class of problem rather than one instance of it.
 */
export const REPO_SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** True when `repo` is a well-formed `owner/name` slug. */
export function isValidRepo(repo: string | null | undefined): repo is string {
  return typeof repo === "string" && REPO_SLUG.test(repo);
}

/** Split "owner/name" into its parts. Throws on a malformed slug. */
export function splitRepo(repo: string): { owner: string; name: string } {
  if (!isValidRepo(repo)) {
    throw new Error(`Invalid repository "${repo}" — expected "owner/name".`);
  }

  const [owner, name] = repo.split("/");
  return { owner, name };
}

/** Minimal PR shape returned by the list query. */
export interface PRSummary {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  url: string;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

/**
 * List open PRs where the authenticated user is a requested reviewer.
 *
 * Uses the search API, which returns matches across every repository the
 * token can see in a single request.
 */
export async function listReviewRequested(limit = 50): Promise<PRSummary[]> {
  const client = github();
  const { data } = await client.search.issuesAndPullRequests({
    q: "is:open is:pr review-requested:@me",
    per_page: Math.min(limit, 100),
    advanced_search: "true",
  });

  const refs = data.items
    .map((item) => {
      // repository_url is ".../repos/{owner}/{name}"
      const match = item.repository_url?.match(/repos\/([^/]+\/[^/]+)$/);
      return match ? { repo: match[1], number: item.number } : null;
    })
    .filter((ref): ref is { repo: string; number: number } => ref !== null);

  const details = await mapLimit(refs, MAX_CONCURRENT, async (ref) => {
    try {
      return await getPR(ref.repo, ref.number);
    } catch {
      return null;
    }
  });

  return details.filter((pr): pr is PRSummary => pr !== null);
}

/** List open PRs in a single repository. */
export async function listRepoPRs(
  repo: string,
  limit = 50,
): Promise<PRSummary[]> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const { data } = await client.pulls.list({
    owner,
    repo: name,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: Math.min(limit, 100),
  });

  // The list endpoint omits additions/deletions/changed_files, so fetch each.
  const details = await mapLimit(data, MAX_CONCURRENT, async (pr) => {
    try {
      return await getPR(repo, pr.number);
    } catch {
      return null;
    }
  });

  return details.filter((pr): pr is PRSummary => pr !== null);
}

/** Fetch a single PR's metadata. */
export async function getPR(repo: string, number: number): Promise<PRSummary> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const { data } = await client.pulls.get({
    owner,
    repo: name,
    pull_number: number,
  });

  return {
    repo,
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    author: data.user?.login ?? "unknown",
    authorIsBot: data.user?.type === "Bot",
    url: data.html_url,
    headSha: data.head.sha,
    headBranch: data.head.ref,
    baseBranch: data.base.ref,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    isDraft: data.draft ?? false,
    labels: data.labels.map((l) =>
      typeof l === "string" ? l : (l.name ?? ""),
    ),
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changed_files ?? 0,
  };
}

/** One changed file as reported by GitHub. */
export interface RawFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  patch?: string;
}

/** List the files a PR changes, following pagination up to `maxFiles`. */
export async function getPRFiles(
  repo: string,
  number: number,
  maxFiles = 300,
): Promise<RawFile[]> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const files: RawFile[] = [];
  let page = 1;

  while (files.length < maxFiles) {
    const { data } = await client.pulls.listFiles({
      owner,
      repo: name,
      pull_number: number,
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    for (const file of data) {
      files.push({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
        patch: file.patch,
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return files.slice(0, maxFiles);
}

/**
 * Fetch a PR's unified diff.
 *
 * Requests the `diff` media type, which returns the patch as plain text in a
 * single call rather than reassembling it from the files endpoint.
 */
export async function getPRDiff(repo: string, number: number): Promise<string> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const response = await client.pulls.get({
    owner,
    repo: name,
    pull_number: number,
    mediaType: { format: "diff" },
  });

  // With the diff media type the response body is a string, though the
  // generated types still describe the JSON shape.
  return response.data as unknown as string;
}

/** Aggregate CI state for a PR's head commit. */
export interface CheckSummary {
  status: "passing" | "failing" | "pending" | "none";
  failing: string[];
}

/**
 * Fetch CI state, combining check runs and legacy commit statuses.
 *
 * A repo may use either mechanism, so both are consulted and the worse
 * outcome wins.
 */
export async function getChecks(
  repo: string,
  ref: string,
): Promise<CheckSummary> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const failing: string[] = [];
  let pending = false;
  let sawAny = false;

  try {
    const { data } = await client.checks.listForRef({
      owner,
      repo: name,
      ref,
      per_page: 100,
    });

    for (const run of data.check_runs) {
      sawAny = true;
      if (run.status !== "completed") {
        pending = true;
      } else if (
        run.conclusion === "failure" ||
        run.conclusion === "timed_out" ||
        run.conclusion === "cancelled"
      ) {
        failing.push(run.name);
      }
    }
  } catch {
    // Checks API unavailable — fall through to commit statuses.
  }

  try {
    const { data } = await client.repos.getCombinedStatusForRef({
      owner,
      repo: name,
      ref,
    });

    if (data.total_count > 0) {
      sawAny = true;
      if (data.state === "failure" || data.state === "error") {
        for (const status of data.statuses) {
          if (status.state === "failure" || status.state === "error") {
            failing.push(status.context);
          }
        }
      } else if (data.state === "pending") {
        pending = true;
      }
    }
  } catch {
    // No commit statuses either.
  }

  if (!sawAny) return { status: "none", failing: [] };
  if (failing.length > 0) return { status: "failing", failing };
  if (pending) return { status: "pending", failing: [] };
  return { status: "passing", failing: [] };
}

/** Review activity on a PR. */
export interface ReviewSummary {
  state: "none" | "pending" | "commented" | "changes_requested" | "approved";
  approvals: number;
  rounds: number;
  comments: number;
  reviewers: string[];
}

/** Fetch review state, approval count and review rounds. */
export async function getReviews(
  repo: string,
  number: number,
): Promise<ReviewSummary> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const { data } = await client.pulls.listReviews({
    owner,
    repo: name,
    pull_number: number,
    per_page: 100,
  });

  if (data.length === 0) {
    return {
      state: "none",
      approvals: 0,
      rounds: 0,
      comments: 0,
      reviewers: [],
    };
  }

  // GitHub reports every review event; the current state is the latest
  // non-comment review from each distinct reviewer.
  const latestByUser = new Map<string, string>();
  const reviewers = new Set<string>();
  let comments = 0;

  for (const review of data) {
    const login = review.user?.login;
    if (!login) continue;
    reviewers.add(login);
    if (review.state === "COMMENTED") {
      comments++;
      continue;
    }
    latestByUser.set(login, review.state);
  }

  const states = [...latestByUser.values()];
  const approvals = states.filter((s) => s === "APPROVED").length;
  const changesRequested = states.some((s) => s === "CHANGES_REQUESTED");

  let state: ReviewSummary["state"] = "none";
  if (changesRequested) state = "changes_requested";
  else if (approvals > 0) state = "approved";
  else if (comments > 0) state = "commented";
  else if (states.length > 0) state = "pending";

  return {
    state,
    approvals,
    // A "round" is a submitted non-comment review — a proxy for how many
    // times this PR has been sent back.
    rounds: states.length,
    comments,
    reviewers: [...reviewers],
  };
}

/** Fetch and decode CODEOWNERS, checking each conventional location. */
export async function getCodeowners(repo: string): Promise<string | null> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const locations = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

  for (const path of locations) {
    try {
      const { data } = await client.repos.getContent({
        owner,
        repo: name,
        path,
      });
      if ("content" in data && typeof data.content === "string") {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch {
      // Not at this location — try the next.
    }
  }

  return null;
}

/** Count of an author's merged PRs in a repo, capped for cost. */
export async function getAuthorHistory(
  repo: string,
  author: string,
): Promise<{ priorPRs: number; isFirstTime: boolean }> {
  const client = github();

  try {
    const { data } = await client.search.issuesAndPullRequests({
      q: `repo:${repo} is:pr author:${author} is:merged`,
      per_page: 1,
      advanced_search: "true",
    });
    return {
      priorPRs: data.total_count,
      isFirstTime: data.total_count === 0,
    };
  } catch {
    return { priorPRs: 0, isFirstTime: false };
  }
}

/** Commits on a PR, used for cadence and co-author detection. */
export interface CommitSummary {
  sha: string;
  message: string;
  authoredAt: string;
  author: string;
}

/** Fetch a PR's commits. */
export async function getPRCommits(
  repo: string,
  number: number,
): Promise<CommitSummary[]> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const { data } = await client.pulls.listCommits({
    owner,
    repo: name,
    pull_number: number,
    per_page: 100,
  });

  return data.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    authoredAt: commit.commit.author?.date ?? "",
    author: commit.commit.author?.name ?? commit.author?.login ?? "unknown",
  }));
}

export { MAX_CONCURRENT };
