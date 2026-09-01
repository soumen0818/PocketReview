/**
 * Historical instability signals.
 *
 * Churn, revert rate and prior-incident membership are the signals that make
 * the risk score feel like engineering rather than a heuristic guess — they
 * use the repository's own past to say "changes here have gone wrong before".
 *
 * They are also the most expensive signals to compute and the first to be
 * unavailable (a new repo has no history). Everything here degrades to a
 * neutral value rather than throwing, and the caller records the omission so
 * confidence can be reported honestly.
 */

import { github, splitRepo } from "./github";

/** Aggregated history for the files a PR touches. */
export interface HistorySignals {
  /** Commits touching each file in the window. */
  fileChurn: Record<string, number>;
  /** Reverts / commits per file, 0..1. */
  fileRevertRate: Record<string, number>;
  /** Files that appeared in a revert or hotfix commit. */
  priorIncidentFiles: string[];
  /** Whether history was readable at all. */
  available: boolean;
}

/** How far back to look. Long enough to be meaningful, short enough to matter. */
const WINDOW_DAYS = 90;

/** Commit messages indicating a revert or an incident fix. */
const REVERT_PATTERN = /\b(revert|rollback|roll back)\b/i;
const HOTFIX_PATTERN = /\b(hotfix|hot-fix|incident|outage|urgent fix|emergency)\b/i;

/**
 * Collect history for a specific set of paths.
 *
 * Queries commits per file rather than walking the whole log: the number of
 * files in a PR is small and bounded, whereas a repository's full history is
 * not. Bounded work regardless of repo size.
 */
export async function collectHistory(
  repo: string,
  paths: string[],
  windowDays = WINDOW_DAYS,
): Promise<HistorySignals> {
  const empty: HistorySignals = {
    fileChurn: {},
    fileRevertRate: {},
    priorIncidentFiles: [],
    available: false,
  };

  if (paths.length === 0) return empty;

  const client = github();
  const { owner, name } = splitRepo(repo);
  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const fileChurn: Record<string, number> = {};
  const fileRevertRate: Record<string, number> = {};
  const priorIncidentFiles: string[] = [];
  let anySucceeded = false;

  // Bound the work: history for the 40 most relevant paths is plenty for a
  // score, and keeps a 300-file PR from issuing 300 requests.
  const targets = paths.slice(0, 40);

  const { mapLimit } = await import("./github");

  await mapLimit(targets, 6, async (path) => {
    try {
      const { data } = await client.repos.listCommits({
        owner,
        repo: name,
        path,
        since,
        per_page: 100,
      });

      anySucceeded = true;
      fileChurn[path] = data.length;

      if (data.length === 0) {
        fileRevertRate[path] = 0;
        return;
      }

      let reverts = 0;
      let incident = false;

      for (const commit of data) {
        const message = commit.commit.message;
        if (REVERT_PATTERN.test(message)) {
          reverts++;
          incident = true;
        }
        if (HOTFIX_PATTERN.test(message)) {
          incident = true;
        }
      }

      fileRevertRate[path] = reverts / data.length;
      if (incident) priorIncidentFiles.push(path);
    } catch {
      // This path has no readable history — leave it absent rather than
      // recording a misleading zero.
    }
  });

  return {
    fileChurn,
    fileRevertRate,
    priorIncidentFiles,
    available: anySucceeded,
  };
}

/**
 * Revert rate for an author's recent commits.
 *
 * A weak signal on its own, which is why it sits inside the lowest-weighted
 * risk dimension.
 */
export async function getAuthorRevertRate(
  repo: string,
  author: string,
  windowDays = 180,
): Promise<number> {
  try {
    const client = github();
    const { owner, name } = splitRepo(repo);
    const since = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data } = await client.repos.listCommits({
      owner,
      repo: name,
      author,
      since,
      per_page: 100,
    });

    if (data.length === 0) return 0;

    const reverted = data.filter((c) =>
      REVERT_PATTERN.test(c.commit.message),
    ).length;

    return reverted / data.length;
  } catch {
    return 0;
  }
}

/**
 * Build a contributor expertise matrix from recent commits.
 *
 * Maps author -> path -> { commits, lastTouch }. Expensive, so it is built
 * once per repository and cached rather than computed per request.
 *
 * Note: this powers the reviewer engine, which produces meaningful output
 * only on repositories with several active contributors. On a single-author
 * repository every lookup returns the same name, and the caller should
 * suppress the recommendation rather than display it.
 */
export interface ExpertiseMatrix {
  /** author -> directory -> commit count */
  byAuthor: Record<string, Record<string, number>>;
  /** author -> ISO timestamp of most recent commit */
  lastTouch: Record<string, string>;
  /** Distinct contributors seen. */
  contributors: string[];
  /** Total commits scanned. */
  totalCommits: number;
}

/** Directory prefix used as the expertise unit (two levels deep). */
function expertiseKey(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || "/";
}

/**
 * Build the expertise matrix for a repository.
 *
 * Scans recent commits and attributes touched directories to their authors.
 */
export async function buildExpertiseMatrix(
  repo: string,
  windowDays = 180,
  maxCommits = 200,
): Promise<ExpertiseMatrix> {
  const result: ExpertiseMatrix = {
    byAuthor: {},
    lastTouch: {},
    contributors: [],
    totalCommits: 0,
  };

  try {
    const client = github();
    const { owner, name } = splitRepo(repo);
    const since = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: commits } = await client.repos.listCommits({
      owner,
      repo: name,
      since,
      per_page: Math.min(maxCommits, 100),
    });

    const { mapLimit } = await import("./github");

    // The list endpoint omits per-commit file lists, so fetch each commit.
    // Bounded to keep this affordable.
    const detailed = await mapLimit(
      commits.slice(0, maxCommits),
      6,
      async (commit) => {
        try {
          const { data } = await client.repos.getCommit({
            owner,
            repo: name,
            ref: commit.sha,
          });
          return data;
        } catch {
          return null;
        }
      },
    );

    for (const commit of detailed) {
      if (!commit) continue;

      const author = commit.author?.login ?? commit.commit.author?.name;
      if (!author) continue;

      result.totalCommits++;

      if (!result.byAuthor[author]) result.byAuthor[author] = {};

      const date = commit.commit.author?.date ?? "";
      if (date && (!result.lastTouch[author] || date > result.lastTouch[author])) {
        result.lastTouch[author] = date;
      }

      for (const file of commit.files ?? []) {
        const key = expertiseKey(file.filename);
        result.byAuthor[author][key] = (result.byAuthor[author][key] ?? 0) + 1;
      }
    }

    result.contributors = Object.keys(result.byAuthor);
  } catch {
    // Leave the matrix empty; the reviewer engine reports low confidence.
  }

  return result;
}

export { expertiseKey, WINDOW_DAYS };
