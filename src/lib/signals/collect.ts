/**
 * Signal collection orchestrator.
 *
 * Assembles a complete `PRSignals` object from every available source. This is
 * the only place that knows how the sources fit together; everything upstream
 * fetches, everything downstream scores.
 *
 * Design rule: a missing source degrades the result, it never fails it. Each
 * optional fetch is caught individually and its absence recorded in
 * `availability`, so the risk engine can report reduced confidence instead of
 * silently scoring on zeros.
 */

import {
  getPR,
  getPRFiles,
  getChecks,
  getReviews,
  getCodeowners,
  getAuthorHistory,
  getPRCommits,
  mapLimit,
  MAX_CONCURRENT,
  type PRSummary,
  type RawFile,
} from "./github";
import { collectHistory, getAuthorRevertRate } from "./history";
import {
  classifyPath,
  isDependencyManifest,
  isLockfile,
  parseCodeowners,
  ownersForPath,
} from "./classify";
import {
  countPatchLines,
  countDependencyChanges,
  detectTestRemoval,
} from "./diff";
import { normalisedEntropy, clamp, ratio, round, saturate } from "../math";
import {
  emptyAvailability,
  type PRSignals,
  type FileSignal,
  type FileStatus,
  type AIAuthorshipHints,
  type SignalAvailability,
} from "./types";
import { DEFAULT_PATH_RULES, type PathRule } from "./path-rules";

/** Options controlling how much work collection does. */
export interface CollectOptions {
  /** Fetch churn and revert history. Expensive; skip for fast list views. */
  includeHistory?: boolean;
  /** Fetch CODEOWNERS. Cheap and cached per repo. */
  includeCodeowners?: boolean;
  /** Fetch author contribution history. */
  includeAuthorHistory?: boolean;
  /** Path rules, overridable per repository. */
  rules?: PathRule[];
  /** Cap on files fetched. */
  maxFiles?: number;
}

const DEFAULTS: Required<Omit<CollectOptions, "rules">> = {
  includeHistory: true,
  includeCodeowners: true,
  includeAuthorHistory: true,
  maxFiles: 300,
};

/** Branch-name prefixes used by coding agents. */
const AGENT_BRANCH_PATTERN =
  /^(codex|claude|cursor|devin|copilot|aider|sweep|bot)[/-]/i;

/** Known agent account suffixes. */
const BOT_ACCOUNT_PATTERN = /(\[bot\]|-bot$|^bot-|dependabot|renovate)/i;

/** PR body templates emitted by agents. */
const TEMPLATED_BODY_PATTERN =
  /(generated (with|by) .{0,40}(claude|copilot|codex|cursor)|🤖|co-authored-by:.*(bot|claude|copilot))/i;

/** Branches whose changes ship immediately. */
const HOTFIX_BRANCH_PATTERN = /^(release|hotfix|patch)[/-]/i;

/** Issue labels that mark urgency. */
const URGENT_LABELS = [
  "incident",
  "outage",
  "p0",
  "p1",
  "critical",
  "urgent",
  "security",
  "hotfix",
  "regression",
];

/** Map GitHub's file status string onto our own union. */
function toFileStatus(status: string): FileStatus {
  switch (status) {
    case "added":
    case "removed":
    case "modified":
    case "renamed":
    case "copied":
    case "changed":
    case "unchanged":
      return status;
    default:
      return "modified";
  }
}

/** Build the per-file signal set. */
function buildFileSignals(
  raw: RawFile[],
  rules: PathRule[],
  codeownersRules: Array<{ pattern: string; owners: string[] }>,
  churn: Record<string, number>,
): FileSignal[] {
  return raw.map((file) => {
    const { category, weight } = classifyPath(file.path, rules);
    return {
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      status: toFileStatus(file.status),
      category,
      categoryWeight: weight,
      isTest: category === "test",
      isGenerated: category === "generated",
      churn: churn[file.path] ?? 0,
      owners:
        codeownersRules.length > 0
          ? ownersForPath(file.path, codeownersRules)
          : [],
      patch: file.patch,
    };
  });
}

/** Derive AI-provenance hints from metadata only, never from code content. */
function detectAIAuthorship(
  pr: PRSummary,
  commitMessages: string[],
  commitTimes: string[],
  fileCount: number,
): { hints: AIAuthorshipHints; likely: boolean } {
  const botAuthor = pr.authorIsBot || BOT_ACCOUNT_PATTERN.test(pr.author);
  const branchNamePattern = AGENT_BRANCH_PATTERN.test(pr.headBranch);
  const templatedBody = TEMPLATED_BODY_PATTERN.test(pr.body);
  const coAuthoredByTrailer = commitMessages.some((m) =>
    /co-authored-by:.*(bot|claude|copilot|codex|cursor|devin)/i.test(m),
  );

  // Cadence: many files landing in one or two commits seconds apart is a
  // machine-authored shape, not a human one.
  let commitCadence = false;
  if (commitTimes.length > 0 && commitTimes.length <= 2 && fileCount >= 8) {
    commitCadence = true;
  } else if (commitTimes.length >= 2) {
    const times = commitTimes
      .map((t) => new Date(t).getTime())
      .filter((t) => !Number.isNaN(t))
      .sort((a, b) => a - b);
    if (times.length >= 2) {
      const span = times[times.length - 1] - times[0];
      // Every commit inside 60 seconds.
      commitCadence = span < 60_000 && fileCount >= 5;
    }
  }

  const hints: AIAuthorshipHints = {
    botAuthor,
    coAuthoredByTrailer,
    branchNamePattern,
    commitCadence,
    templatedBody,
  };

  // Require two independent hints. One alone is too weak to act on, and this
  // signal carries only a small weight in the score regardless.
  const hintCount = Object.values(hints).filter(Boolean).length;

  return { hints, likely: hintCount >= 2 };
}

/**
 * Collect the full signal set for one pull request.
 *
 * Optional sources are fetched in parallel and failures are absorbed
 * individually, so a repo without CI or without history still produces a
 * usable — if less confident — result.
 */
export async function collectSignals(
  repo: string,
  number: number,
  options: CollectOptions = {},
): Promise<PRSignals> {
  const opts = { ...DEFAULTS, ...options };
  const rules = options.rules ?? DEFAULT_PATH_RULES;
  const availability: SignalAvailability = emptyAvailability();

  // --- required: metadata and files ---
  const pr = await getPR(repo, number);
  availability.metadata = true;

  const rawFiles = await getPRFiles(repo, number, opts.maxFiles);
  availability.patches = rawFiles.some((f) => f.patch !== undefined);

  const paths = rawFiles.map((f) => f.path);

  // --- optional sources, fetched in parallel ---
  const [checks, reviews, codeownersText, history, commits, authorStats] =
    await Promise.all([
      getChecks(repo, pr.headSha).catch(() => null),
      getReviews(repo, number).catch(() => null),
      opts.includeCodeowners ? getCodeowners(repo).catch(() => null) : null,
      opts.includeHistory
        ? collectHistory(repo, paths).catch(() => null)
        : null,
      getPRCommits(repo, number).catch(() => []),
      opts.includeAuthorHistory
        ? getAuthorHistory(repo, pr.author).catch(() => null)
        : null,
    ]);

  if (checks && checks.status !== "none") availability.ci = true;
  if (reviews) availability.reviews = true;
  if (codeownersText) availability.codeowners = true;
  if (history?.available) availability.history = true;
  if (authorStats) availability.authorHistory = true;

  const codeownersRules = codeownersText
    ? parseCodeowners(codeownersText)
    : [];

  const files = buildFileSignals(
    rawFiles,
    rules,
    codeownersRules,
    history?.fileChurn ?? {},
  );

  // --- size & shape ---
  const realFiles = files.filter((f) => !f.isGenerated);
  const lineCounts = realFiles.map((f) => f.additions + f.deletions);
  const largestFileChange = lineCounts.length > 0 ? Math.max(...lineCounts) : 0;
  const diffEntropy = normalisedEntropy(lineCounts);
  const distinctCategories = new Set(
    realFiles.filter((f) => !f.isTest).map((f) => f.category),
  ).size;

  // --- semantic classification ---
  const categories = new Set(files.map((f) => f.category));
  const criticalPaths = files
    .filter((f) => f.categoryWeight >= 0.7 && !f.isGenerated)
    .map((f) => f.path);

  // --- test posture ---
  const testFiles = files.filter((f) => f.isTest);
  const productionFiles = files.filter((f) => !f.isTest && !f.isGenerated);

  const testLinesAdded = testFiles.reduce((n, f) => n + f.additions, 0);
  const testLinesDeleted = testFiles.reduce((n, f) => n + f.deletions, 0);
  const productionLinesAdded = productionFiles.reduce(
    (n, f) => n + f.additions,
    0,
  );
  const productionLinesDeleted = productionFiles.reduce(
    (n, f) => n + f.deletions,
    0,
  );

  const testRatio = round(ratio(testLinesAdded, productionLinesAdded), 3);
  const hasNoTests = productionLinesAdded > 0 && testLinesAdded === 0;
  const testsRemoved = detectTestRemoval(
    testLinesAdded,
    testLinesDeleted,
    productionLinesAdded,
  );

  // --- dependencies ---
  const dependencyFiles = files.filter(
    (f) => isDependencyManifest(f.path) || isLockfile(f.path),
  );
  let dependenciesAdded = 0;
  let dependenciesRemoved = 0;

  for (const file of dependencyFiles) {
    if (!file.patch || isLockfile(file.path)) continue;
    const counts = countDependencyChanges(file.patch);
    dependenciesAdded += counts.added;
    dependenciesRemoved += counts.removed;
  }

  const lockfileOnly =
    files.length > 0 && files.every((f) => f.isGenerated || isLockfile(f.path));

  // --- historical instability ---
  const churnValues = realFiles.map((f) => saturate(f.churn, 15));
  const revertValues = realFiles.map(
    (f) => history?.fileRevertRate[f.path] ?? 0,
  );
  const hotspotScore = round(
    clamp(
      0.5 * (churnValues.length > 0 ? Math.max(...churnValues) : 0) +
        0.5 * (revertValues.length > 0 ? Math.max(...revertValues) * 5 : 0),
    ),
    3,
  );

  // --- author context ---
  const authorRevertRate = opts.includeAuthorHistory
    ? await getAuthorRevertRate(repo, pr.author).catch(() => 0)
    : 0;

  // --- provenance ---
  const { hints, likely } = detectAIAuthorship(
    pr,
    commits.map((c) => c.message),
    commits.map((c) => c.authoredAt),
    files.length,
  );

  // --- urgency ---
  const ageHours = round(
    (Date.now() - new Date(pr.createdAt).getTime()) / 3_600_000,
    1,
  );
  const labels = pr.labels.map((l) => l.toLowerCase());
  const linkedIssueLabels = labels.filter((l) =>
    URGENT_LABELS.some((u) => l.includes(u)),
  );

  return {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author,
    url: pr.url,
    headSha: pr.headSha,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,

    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    files,
    largestFileChange,
    diffEntropy: round(diffEntropy, 3),
    distinctCategories,

    touchesAuth: categories.has("auth"),
    touchesPayments: categories.has("payments"),
    touchesDatabase: categories.has("database"),
    touchesInfra: categories.has("infra"),
    touchesPublicAPI: categories.has("api"),
    touchesConfig: categories.has("config"),
    criticalPaths,

    testFilesChanged: testFiles.length,
    testLinesAdded,
    testLinesDeleted,
    productionLinesAdded,
    productionLinesDeleted,
    testRatio,
    hasNoTests,
    testsRemoved,

    dependencyFilesChanged: dependencyFiles.map((f) => f.path),
    dependenciesAdded,
    dependenciesRemoved,
    lockfileOnly,

    fileChurn: history?.fileChurn ?? {},
    fileRevertRate: history?.fileRevertRate ?? {},
    hotspotScore,
    priorIncidentFiles: history?.priorIncidentFiles ?? [],

    ciStatus: checks?.status ?? "none",
    failingChecks: checks?.failing ?? [],
    reviewState: reviews?.state ?? "none",
    existingApprovals: reviews?.approvals ?? 0,
    commentCount: reviews?.comments ?? 0,
    reviewRounds: reviews?.rounds ?? 0,

    authorPriorPRs: authorStats?.priorPRs ?? 0,
    authorRevertRate: round(authorRevertRate, 3),
    authorIsFirstTimeContributor: authorStats?.isFirstTime ?? false,
    authorIsBot: pr.authorIsBot,

    aiAuthorshipHints: hints,
    likelyAIAuthored: likely,

    ageHours,
    isBlockingOthers: false, // populated by the queue-level pass
    linkedIssueLabels,
    labels,
    isDraft: pr.isDraft,
    isHotfix: HOTFIX_BRANCH_PATTERN.test(pr.baseBranch),

    availability,
  };
}

/**
 * Collect signals for many PRs in parallel.
 *
 * Also fills `isBlockingOthers`, which can only be determined by looking at
 * the queue as a whole: a PR is blocking when another open PR targets its
 * head branch.
 */
export async function collectQueueSignals(
  prs: Array<{ repo: string; number: number }>,
  options: CollectOptions = {},
): Promise<PRSignals[]> {
  const collected = await mapLimit(prs, MAX_CONCURRENT, async (ref) => {
    try {
      return await collectSignals(ref.repo, ref.number, options);
    } catch {
      return null;
    }
  });

  const signals = collected.filter((s): s is PRSignals => s !== null);

  // A PR whose head branch is another PR's base is blocking that PR.
  const baseBranches = new Set(
    signals.map((s) => `${s.repo}:${s.baseBranch}`),
  );
  for (const signal of signals) {
    signal.isBlockingOthers = baseBranches.has(
      `${signal.repo}:${signal.headBranch}`,
    );
  }

  return signals;
}
