/**
 * The Signal Layer contract.
 *
 * `PRSignals` is a flat, typed record of *measurements* about a pull request.
 * It contains no judgements, no scores and no opinions — only facts that were
 * observed. Every downstream engine (risk, priority, effort, reviewer) reads
 * from this and nothing else.
 *
 * Keeping measurement separate from scoring is what makes the risk score
 * explainable: each point of the score traces back to a named field here.
 */

/** Coarse classification of a file's role in the codebase. */
export type FileCategory =
  | "auth"
  | "payments"
  | "database"
  | "infra"
  | "api"
  | "config"
  | "test"
  | "docs"
  | "ui"
  | "generated"
  | "other";

/** How a file was affected by the PR. */
export type FileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

/** Aggregate CI state across all check runs on the head commit. */
export type CIStatus = "passing" | "failing" | "pending" | "none";

/** Review state as reported by GitHub. */
export type ReviewState =
  | "none"
  | "pending"
  | "commented"
  | "changes_requested"
  | "approved";

/** Per-file measurements. */
export interface FileSignal {
  path: string;
  additions: number;
  deletions: number;
  status: FileStatus;
  category: FileCategory;
  /** Criticality weight of this file's category, 0..1. */
  categoryWeight: number;
  isTest: boolean;
  /** Lockfiles, snapshots, build output — excluded from size scoring. */
  isGenerated: boolean;
  /** Commits touching this file in the history window. 0 when unavailable. */
  churn: number;
  /** CODEOWNERS entries matching this path. */
  owners: string[];
  /** Unified diff text for this file, when fetched. */
  patch?: string;
}

/**
 * A file signal with its diff text removed.
 *
 * Used wherever signals cross a persistence boundary — the disk cache and the
 * committed demo fixtures. `docs/security.md` promises no source code is
 * persisted, and a single shared helper is how that stays true: the two call
 * sites cannot drift, and a future third one has an obvious thing to reach for.
 */
export function stripPatch(file: FileSignal): FileSignal {
  if (file.patch === undefined) return file;

  const copy: FileSignal = { ...file };
  delete copy.patch;
  return copy;
}

/**
 * Heuristic hints that a PR was authored by an agent rather than a person.
 *
 * These are provenance signals, not code analysis — we do not attempt to
 * detect AI authorship from the code itself, which is unreliable. This is
 * deliberately a weak signal and carries a correspondingly small weight in
 * the risk score.
 */
export interface AIAuthorshipHints {
  /** Author account is a known bot or agent. */
  botAuthor: boolean;
  /** Commit trailers credit an agent as co-author. */
  coAuthoredByTrailer: boolean;
  /** Branch name matches an agent convention (codex/, claude/, cursor/...). */
  branchNamePattern: boolean;
  /** Many files landed in a single commit within seconds. */
  commitCadence: boolean;
  /** PR body matches a generated template. */
  templatedBody: boolean;
}

/**
 * The complete measured state of one pull request.
 *
 * Fields are grouped by what they describe. Any field that could not be
 * measured degrades to a neutral value (0, false, empty) rather than throwing,
 * and the omission is recorded in `availability` so downstream scoring can
 * report reduced confidence instead of silently pretending.
 */
export interface PRSignals {
  // ---- identity
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;

  // ---- size & shape
  additions: number;
  deletions: number;
  changedFiles: number;
  files: FileSignal[];
  /** Largest single-file change, in lines touched. */
  largestFileChange: number;
  /** 0..1 — how evenly the diff is spread across files. */
  diffEntropy: number;
  /** Distinct non-generated categories touched. */
  distinctCategories: number;

  // ---- semantic classification
  touchesAuth: boolean;
  touchesPayments: boolean;
  touchesDatabase: boolean;
  touchesInfra: boolean;
  touchesPublicAPI: boolean;
  touchesConfig: boolean;
  /** Human-readable list of critical paths matched, for explanation text. */
  criticalPaths: string[];

  // ---- test posture
  testFilesChanged: number;
  testLinesAdded: number;
  testLinesDeleted: number;
  productionLinesAdded: number;
  productionLinesDeleted: number;
  /** testLinesAdded / productionLinesAdded. */
  testRatio: number;
  /** Production code changed with zero test lines added. */
  hasNoTests: boolean;
  /** Net removal of test code alongside production changes. */
  testsRemoved: boolean;

  // ---- dependencies
  dependencyFilesChanged: string[];
  dependenciesAdded: number;
  dependenciesRemoved: number;
  /** Only lockfiles changed — near-noise, should not read as risk. */
  lockfileOnly: boolean;

  // ---- historical instability
  /** Commits per file in the history window. */
  fileChurn: Record<string, number>;
  /** Reverts / commits per file, 0..1. */
  fileRevertRate: Record<string, number>;
  /** 0..1 aggregate instability of the touched files. */
  hotspotScore: number;
  /** Files that appeared in a past revert or hotfix commit. */
  priorIncidentFiles: string[];

  // ---- CI & review state
  ciStatus: CIStatus;
  failingChecks: string[];
  reviewState: ReviewState;
  existingApprovals: number;
  commentCount: number;
  reviewRounds: number;

  // ---- author context
  authorPriorPRs: number;
  authorRevertRate: number;
  authorIsFirstTimeContributor: boolean;
  authorIsBot: boolean;

  // ---- provenance
  aiAuthorshipHints: AIAuthorshipHints;
  likelyAIAuthored: boolean;

  // ---- urgency
  ageHours: number;
  isBlockingOthers: boolean;
  linkedIssueLabels: string[];
  labels: string[];
  isDraft: boolean;
  /** Targets a release or hotfix branch. */
  isHotfix: boolean;

  // ---- meta
  /** Which signal groups were actually available for this PR. */
  availability: SignalAvailability;
}

/**
 * Records which signal groups could be measured.
 *
 * Not every repository yields every signal: a shallow clone has no history,
 * a repo without CI has no checks. Rather than silently substituting zeros,
 * we record what was missing so the risk engine can report lower confidence
 * and the UI can say "limited signals" honestly.
 */
export interface SignalAvailability {
  /** PR metadata and file list — the baseline, always required. */
  metadata: boolean;
  /** Per-file patches were fetched. */
  patches: boolean;
  /** Git history was readable (churn, reverts, incidents). */
  history: boolean;
  /** CI check runs were available. */
  ci: boolean;
  /** Review state and approvals were available. */
  reviews: boolean;
  /** CODEOWNERS was present and parsed. */
  codeowners: boolean;
  /** Author's contribution history was available. */
  authorHistory: boolean;
}

/** Weight of each signal group when computing overall confidence. */
export const AVAILABILITY_WEIGHTS: Record<keyof SignalAvailability, number> = {
  metadata: 0.35,
  patches: 0.15,
  history: 0.2,
  ci: 0.1,
  reviews: 0.08,
  codeowners: 0.05,
  authorHistory: 0.07,
};

/** Overall confidence in a signal set, 0..1. */
export function signalConfidence(availability: SignalAvailability): number {
  let available = 0;
  let total = 0;
  for (const key of Object.keys(AVAILABILITY_WEIGHTS) as Array<
    keyof SignalAvailability
  >) {
    const weight = AVAILABILITY_WEIGHTS[key];
    total += weight;
    if (availability[key]) available += weight;
  }
  return total === 0 ? 0 : available / total;
}

/** A signal set with nothing measured — the safe default. */
export function emptyAvailability(): SignalAvailability {
  return {
    metadata: false,
    patches: false,
    history: false,
    ci: false,
    reviews: false,
    codeowners: false,
    authorHistory: false,
  };
}
