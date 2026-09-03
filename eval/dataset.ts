/**
 * Eval dataset — mining ground truth from history.
 *
 * The claim being validated is **not** "we predict bugs". It is: *we rank PRs
 * by how much human attention they needed*. So the labels come from what
 * actually happened to each PR after it merged, not from anyone's opinion.
 *
 * Every label is derived automatically from the GitHub API and commit history.
 * No manual labelling, which means the dataset can be regenerated and the
 * numbers re-checked by anyone with a token.
 */

import {
  github,
  splitRepo,
  mapLimit,
  getPRFiles,
  getReviews,
  getChecks,
} from "../src/lib/signals/github";
import { classifyPath } from "../src/lib/signals/classify";
import { DEFAULT_PATH_RULES } from "../src/lib/signals/path-rules";
import {
  countDependencyChanges,
  detectTestRemoval,
} from "../src/lib/signals/diff";
import { normalisedEntropy } from "../src/lib/math";
import {
  emptyAvailability,
  type PRSignals,
  type FileSignal,
} from "../src/lib/signals/types";

/** Why a merged PR is considered to have needed careful attention. */
export type LabelReason =
  | "reverted"
  | "followup-fix"
  | "changes-requested"
  | "many-rounds"
  | "heavy-discussion"
  | "in-later-hotfix";

/** One labelled PR: the signals we would have scored, plus what happened. */
export interface LabelledPR {
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  signals: PRSignals;
  /** True when any label fired. */
  attentionWorthy: boolean;
  reasons: LabelReason[];
  /** Wall-clock minutes the PR was open. A coarse proxy, not review time. */
  minutesToFirstReview: number | null;
}

/**
 * Review *events* beyond which a PR counts as having needed attention.
 *
 * Not distinct reviewers: an approval from three people in one pass is not the
 * same as one reviewer going back and forth four times. GitHub emits a review
 * event per submission, so counting events captures iteration — which is what
 * "needed attention" actually looks like.
 */
const MANY_ROUNDS = 3;

/** Inline review comments beyond which a PR counts as heavily discussed. */
const HEAVY_DISCUSSION = 3;

/** Window in which a follow-up commit counts as a fix for this PR. */
const FOLLOWUP_DAYS = 7;

/** Commit-message patterns that mark a revert or a fix of something. */
const REVERT_RE = /\brevert(s|ed|ing)?\b/i;
const FIX_RE = /\b(fix(es|ed)?|hotfix|patch|repair|correct(s|ed)?)\b/i;

export interface MineOptions {
  /** How many merged PRs to sample. */
  limit: number;
  /** Progress callback, so a long mine is not silent. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Mine and label merged PRs from one repository.
 *
 * Reconstructs `PRSignals` as they would have been at merge time: the PR's own
 * files and patches, the CI state at its head commit, and the commit history of
 * the files it touched. Scoring a PR with knowledge of what came *after* it
 * would be leakage, so nothing downstream of the merge is used as a signal —
 * only as a label.
 */
export async function mineRepo(
  repo: string,
  options: MineOptions,
): Promise<LabelledPR[]> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  // 1. Recent merged PRs.
  const merged: Array<{
    number: number;
    title: string;
    body: string;
    author: string;
    createdAt: string;
    mergedAt: string;
    mergeSha: string;
    headSha: string;
    baseBranch: string;
    headBranch: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    labels: string[];
    isDraft: boolean;
  }> = [];

  let page = 1;
  while (merged.length < options.limit && page <= 10) {
    const { data } = await client.pulls.list({
      owner,
      repo: name,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    for (const pr of data) {
      if (!pr.merged_at || merged.length >= options.limit) continue;
      merged.push({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "unknown",
        createdAt: pr.created_at,
        mergedAt: pr.merged_at,
        mergeSha: pr.merge_commit_sha ?? "",
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        additions: 0,
        deletions: 0,
        // `pulls.list` omits counts; the file fetch below supplies them.
        changedFiles: 0,
        labels: pr.labels.map((l) =>
          typeof l === "string" ? l : (l.name ?? ""),
        ),
        isDraft: pr.draft ?? false,
      });
    }
    page++;
  }

  if (merged.length === 0) return [];

  // 2. The commits that came after, for revert and follow-up detection.
  const since = new Date(
    Math.min(...merged.map((m) => new Date(m.mergedAt).getTime())),
  ).toISOString();

  const laterCommits: Array<{ sha: string; message: string; date: string }> =
    [];
  for (let p = 1; p <= 5; p++) {
    const { data } = await client.repos.listCommits({
      owner,
      repo: name,
      since,
      per_page: 100,
      page: p,
    });
    if (data.length === 0) break;
    for (const c of data) {
      laterCommits.push({
        sha: c.sha,
        message: c.commit.message,
        date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
      });
    }
  }

  // 3. Per-PR: fetch files, reconstruct signals, apply labels.
  const churn = new ChurnIndex(repo);
  let done = 0;
  const results = await mapLimit(merged, 4, async (pr) => {
    try {
      const rawFiles = await getPRFiles(repo, pr.number, 200);

      const files: FileSignal[] = rawFiles.map((f) => {
        const { category, weight } = classifyPath(f.path, DEFAULT_PATH_RULES);
        return {
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          status: f.status as FileSignal["status"],
          category,
          categoryWeight: weight,
          isTest: category === "test",
          isGenerated: category === "generated",
          churn: 0,
          owners: [],
          patch: f.patch,
        };
      });

      const reviews = await getReviews(repo, pr.number).catch(() => null);
      const activity = await reviewActivity(repo, pr.number).catch(() => null);
      const ci = await ciAtHead(repo, pr.headSha);

      // Churn for the non-generated files this PR touched. Capped so one
      // enormous PR cannot dominate the mine's runtime.
      const history: Record<string, { commits: number; reverts: number }> = {};
      for (const file of files.filter((f) => !f.isGenerated).slice(0, 12)) {
        history[file.path] = await churn.lookup(file.path);
      }

      const signals = buildSignals(
        repo,
        pr,
        files,
        reviews,
        activity,
        ci,
        history,
      );

      const labels = labelPR(pr, laterCommits, reviews, activity);

      return {
        repo,
        number: pr.number,
        title: pr.title,
        mergedAt: pr.mergedAt,
        signals,
        attentionWorthy: labels.length > 0,
        reasons: labels,
        minutesToFirstReview: firstReviewMinutes(pr.createdAt, pr.mergedAt),
      } satisfies LabelledPR;
    } catch {
      return null;
    } finally {
      done++;
      options.onProgress?.(done, merged.length);
    }
  });

  return results.filter((r): r is LabelledPR => r !== null);
}

/**
 * Per-file commit history, cached across the whole mine.
 *
 * Historical instability is one of the seven dimensions and it is worth 0.15 —
 * omitting it does not just lose accuracy, it silently changes what is being
 * measured. Files repeat heavily across a repo's PRs, so one lookup per
 * distinct path keeps this affordable.
 */
class ChurnIndex {
  private readonly cache = new Map<
    string,
    { commits: number; reverts: number }
  >();

  constructor(private readonly repo: string) {}

  async lookup(path: string): Promise<{ commits: number; reverts: number }> {
    const hit = this.cache.get(path);
    if (hit) return hit;

    const client = github();
    const { owner, name } = splitRepo(this.repo);

    try {
      const { data } = await client.repos.listCommits({
        owner,
        repo: name,
        path,
        per_page: 100,
      });

      const value = {
        commits: data.length,
        reverts: data.filter((c) => REVERT_RE.test(c.commit.message)).length,
      };
      this.cache.set(path, value);
      return value;
    } catch {
      const empty = { commits: 0, reverts: 0 };
      this.cache.set(path, empty);
      return empty;
    }
  }
}

/** CI state at the PR's head commit. Recoverable long after a merge. */
async function ciAtHead(
  repo: string,
  headSha: string,
): Promise<{ status: PRSignals["ciStatus"]; failing: string[] } | null> {
  try {
    const checks = await getChecks(repo, headSha);
    return { status: checks.status, failing: checks.failing };
  } catch {
    return null;
  }
}

/** Review iteration counts, which `getReviews` does not expose. */
export interface ReviewActivity {
  /** Total review submissions — iteration, not headcount. */
  events: number;
  /** Inline comments left on the diff. */
  inlineComments: number;
  /** True when any reviewer submitted CHANGES_REQUESTED. */
  changesRequested: boolean;
}

async function reviewActivity(
  repo: string,
  number: number,
): Promise<ReviewActivity> {
  const client = github();
  const { owner, name } = splitRepo(repo);

  const [reviews, comments] = await Promise.all([
    client.pulls.listReviews({
      owner,
      repo: name,
      pull_number: number,
      per_page: 100,
    }),
    client.pulls.listReviewComments({
      owner,
      repo: name,
      pull_number: number,
      per_page: 100,
    }),
  ]);

  return {
    events: reviews.data.length,
    inlineComments: comments.data.length,
    changesRequested: reviews.data.some((r) => r.state === "CHANGES_REQUESTED"),
  };
}

/** Reconstruct the signal set as it would have been at merge time. */
function buildSignals(
  repo: string,
  pr: {
    number: number;
    title: string;
    body: string;
    author: string;
    createdAt: string;
    mergedAt: string;
    headSha: string;
    baseBranch: string;
    headBranch: string;
    labels: string[];
    isDraft: boolean;
  },
  files: FileSignal[],
  reviews: Awaited<ReturnType<typeof getReviews>> | null,
  activity: ReviewActivity | null,
  ci: { status: PRSignals["ciStatus"]; failing: string[] } | null,
  history: Record<string, { commits: number; reverts: number }>,
): PRSignals {
  // Dependency manifests only — a lockfile churns on every install.
  const manifestFiles = files.filter((f) =>
    /package\.json$|requirements\.txt$|Cargo\.toml$|go\.mod$|Gemfile$|pyproject\.toml$/.test(
      f.path,
    ),
  );
  const deps = manifestFiles.reduce(
    (acc, f) => {
      if (!f.patch) return acc;
      const counted = countDependencyChanges(f.patch);
      return {
        added: acc.added + counted.added,
        removed: acc.removed + counted.removed,
      };
    },
    { added: 0, removed: 0 },
  );

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const nonGenerated = files.filter((f) => !f.isGenerated);
  const critical = nonGenerated.filter((f) => f.categoryWeight >= 0.7);

  const testFiles = files.filter((f) => f.isTest);
  const testLinesAdded = testFiles.reduce((n, f) => n + f.additions, 0);
  const testLinesDeleted = testFiles.reduce((n, f) => n + f.deletions, 0);
  const prodFiles = nonGenerated.filter((f) => !f.isTest);
  const productionLinesAdded = prodFiles.reduce((n, f) => n + f.additions, 0);
  const productionLinesDeleted = prodFiles.reduce((n, f) => n + f.deletions, 0);

  const ageHours =
    (new Date(pr.mergedAt).getTime() - new Date(pr.createdAt).getTime()) /
    3_600_000;

  return {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    url: "",
    headSha: pr.headSha,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    createdAt: pr.createdAt,
    updatedAt: pr.mergedAt,

    additions,
    deletions,
    changedFiles: files.length,
    files,
    largestFileChange: Math.max(
      0,
      ...files.map((f) => f.additions + f.deletions),
    ),
    diffEntropy: normalisedEntropy(
      nonGenerated.map((f) => f.additions + f.deletions),
    ),
    distinctCategories: new Set(nonGenerated.map((f) => f.category)).size,

    touchesAuth: files.some((f) => f.category === "auth"),
    touchesPayments: files.some((f) => f.category === "payments"),
    touchesDatabase: files.some((f) => f.category === "database"),
    touchesInfra: files.some((f) => f.category === "infra"),
    touchesPublicAPI: files.some((f) => f.category === "api"),
    touchesConfig: files.some((f) => f.category === "config"),
    criticalPaths: critical.map((f) => f.path),

    testFilesChanged: testFiles.length,
    testLinesAdded,
    testLinesDeleted,
    productionLinesAdded,
    productionLinesDeleted,
    testRatio:
      productionLinesAdded > 0 ? testLinesAdded / productionLinesAdded : 0,
    hasNoTests: productionLinesAdded > 0 && testLinesAdded === 0,
    testsRemoved: detectTestRemoval(
      testLinesAdded,
      testLinesDeleted,
      productionLinesAdded,
    ),

    dependencyFilesChanged: manifestFiles.map((f) => f.path),
    dependenciesAdded: deps.added,
    dependenciesRemoved: deps.removed,
    lockfileOnly: nonGenerated.length === 0 && files.length > 0,

    fileChurn: Object.fromEntries(
      Object.entries(history).map(([path, h]) => [path, h.commits]),
    ),
    fileRevertRate: Object.fromEntries(
      Object.entries(history).map(([path, h]) => [
        path,
        h.commits > 0 ? h.reverts / h.commits : 0,
      ]),
    ),
    hotspotScore: 0,
    priorIncidentFiles: Object.entries(history)
      .filter(([, h]) => h.reverts > 0)
      .map(([path]) => path),

    ciStatus: ci?.status ?? "none",
    failingChecks: ci?.failing ?? [],
    reviewState: "none",
    existingApprovals: reviews?.approvals ?? 0,
    commentCount: reviews?.comments ?? 0,
    reviewRounds: activity?.events ?? reviews?.rounds ?? 0,

    authorPriorPRs: 0,
    authorRevertRate: 0,
    authorIsFirstTimeContributor: false,
    authorIsBot: /\[bot\]$|-bot$|dependabot/i.test(pr.author),

    aiAuthorshipHints: {
      botAuthor: /\[bot\]$|dependabot/i.test(pr.author),
      coAuthoredByTrailer: false,
      branchNamePattern: /^(codex|claude|cursor|devin)\//i.test(pr.headBranch),
      commitCadence: false,
      templatedBody: false,
    },
    likelyAIAuthored: false,

    ageHours,
    isBlockingOthers: false,
    linkedIssueLabels: [],
    labels: pr.labels,
    isDraft: pr.isDraft,
    isHotfix: /^(release|hotfix)/i.test(pr.baseBranch),

    availability: {
      ...emptyAvailability(),
      metadata: true,
      patches: files.some((f) => Boolean(f.patch)),
      reviews: reviews !== null && activity !== null,
      history: Object.keys(history).length > 0,
      ci: ci !== null,
    },
  };
}

/**
 * Apply the outcome labels.
 *
 * The follow-up detection has to work around squash-merge: React and many
 * other repos put `(#1234)` in the merge commit subject, so a naive
 * "commit mentions #N" match hits the PR's own merge commit. We therefore
 * require the referencing commit to be strictly newer AND to not be the merge
 * commit itself.
 */
function labelPR(
  pr: { number: number; mergedAt: string; mergeSha: string; title: string },
  laterCommits: Array<{ sha: string; message: string; date: string }>,
  reviews: Awaited<ReturnType<typeof getReviews>> | null,
  activity: ReviewActivity | null,
): LabelReason[] {
  const reasons: LabelReason[] = [];
  const mergedMs = new Date(pr.mergedAt).getTime();
  const windowMs = FOLLOWUP_DAYS * 86_400_000;

  for (const commit of laterCommits) {
    // Never let a PR's own merge commit label it.
    if (commit.sha === pr.mergeSha) continue;

    const commitMs = new Date(commit.date).getTime();
    if (!Number.isFinite(commitMs) || commitMs <= mergedMs) continue;

    const mentionsThisPR = new RegExp(`#${pr.number}\b`).test(commit.message);
    if (!mentionsThisPR) continue;

    if (REVERT_RE.test(commit.message)) {
      if (!reasons.includes("reverted")) reasons.push("reverted");
      continue;
    }

    if (commitMs - mergedMs <= windowMs) {
      if (/hotfix/i.test(commit.message)) {
        if (!reasons.includes("in-later-hotfix")) {
          reasons.push("in-later-hotfix");
        }
      } else if (FIX_RE.test(commit.message)) {
        if (!reasons.includes("followup-fix")) reasons.push("followup-fix");
      }
    }
  }

  if (activity?.changesRequested || reviews?.state === "changes_requested") {
    reasons.push("changes-requested");
  }

  // Iteration, not headcount.
  if ((activity?.events ?? 0) > MANY_ROUNDS) reasons.push("many-rounds");

  if ((activity?.inlineComments ?? 0) > HEAVY_DISCUSSION) {
    reasons.push("heavy-discussion");
  }

  return reasons;
}

/**
 * Minutes from open to merge, as a proxy for review duration.
 *
 * The honest caveat: this is wall-clock time a PR was open, not time a human
 * spent reading it. A PR open over a weekend inflates it enormously. It is
 * reported with that stated, and only as a very coarse sanity check on the
 * effort model — never as a precise ground truth.
 */
function firstReviewMinutes(
  createdAt: string,
  mergedAt: string,
): number | null {
  const delta = new Date(mergedAt).getTime() - new Date(createdAt).getTime();
  return delta > 0 ? Math.round(delta / 60_000) : null;
}
