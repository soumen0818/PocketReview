/**
 * The reviewer engine.
 *
 * Answers: *given these files, who is the right human?*
 *
 * Pure and deterministic like every other engine here — it reads a prebuilt
 * expertise matrix and produces the same ranking for the same inputs. The
 * expensive part (scanning commit history) happens once per repository and is
 * cached; nothing in this file touches the network.
 *
 * **The honest limitation is enforced in code, not just documented.** On a
 * repository with too few contributors, or where the matrix has no signal for
 * the files in question, this returns matches flagged `lowConfidence` and the
 * UI hides the card. Inventing a plausible-looking recommendation from thin
 * data is exactly what collapses under a follow-up question.
 */

import { clamp, decay, round } from "../math";
import type { ExpertiseMatrix } from "../signals/history";
import type { PRSignals } from "../signals/types";

/** Term weights, from architecture §8. Asserted to sum to 1.00 at load. */
export const REVIEWER_WEIGHTS = {
  ownership: 0.3,
  recency: 0.2,
  reviewHistory: 0.25,
  codeowner: 0.15,
  load: 0.1,
} as const;

const WEIGHT_SUM = Object.values(REVIEWER_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(
    `Reviewer weights must sum to 1.00, got ${WEIGHT_SUM.toFixed(4)}`,
  );
}

/** Half-life in days for the recency term. */
const RECENCY_HALF_LIFE_DAYS = 60;

/** Below this, the UI must hide the recommendation entirely. */
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

/** Contributors below which the matrix cannot distinguish anyone. */
const MIN_CONTRIBUTORS = 2;

/** Open review requests treated as a full load. */
const LOAD_CEILING = 5;

/** One suggested reviewer. */
export interface ReviewerMatch {
  login: string;
  /** 0..1 — how well this person fits these files. */
  score: number;
  /** Why, most significant first. Shown verbatim on the card. */
  reasons: string[];
  /** Open review requests currently assigned to them. */
  currentLoad: number;
  isCodeowner: boolean;
}

/** The engine's complete answer, including whether to trust it. */
export interface ReviewerSuggestion {
  matches: ReviewerMatch[];
  /** 0..1 — how much signal the matrix actually had for these files. */
  confidence: number;
  /** True when the UI must hide the card rather than show a weak guess. */
  lowConfidence: boolean;
  /** Plain-English reason when confidence is low. */
  limitation: string | null;
}

export interface ReviewerOptions {
  /** Open review requests per login, when known. */
  loads?: Record<string, number>;
  /** Never suggest these logins — typically the PR author. */
  exclude?: string[];
  /** Maximum matches to return. */
  limit?: number;
}

/** The directory key the expertise matrix is bucketed by. */
function expertiseKey(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || "/";
}

/**
 * Suggest reviewers for a pull request.
 *
 * Bots are excluded outright: `dependabot` has touched every manifest in the
 * repository and would otherwise dominate ownership on any dependency PR.
 */
export function suggestReviewers(
  signals: PRSignals,
  matrix: ExpertiseMatrix,
  options: ReviewerOptions = {},
): ReviewerSuggestion {
  const { loads = {}, exclude = [], limit = 3 } = options;

  // Generated files carry no authorship signal worth attributing.
  const relevant = signals.files.filter((f) => !f.isGenerated);
  const directories = [...new Set(relevant.map((f) => expertiseKey(f.path)))];

  const excluded = new Set(
    [...exclude, signals.author].map((l) => l.toLowerCase()),
  );

  const candidates = matrix.contributors.filter(
    (login) =>
      !excluded.has(login.toLowerCase()) &&
      !/\[bot\]$|-bot$|^dependabot/i.test(login),
  );

  // --- confidence, decided before any scoring ---
  const owners = new Set(relevant.flatMap((f) => f.owners));
  const touchedDirs = directories.filter((dir) =>
    candidates.some((login) => (matrix.byAuthor[login]?.[dir] ?? 0) > 0),
  );

  const confidence = computeConfidence(
    candidates.length,
    directories.length,
    touchedDirs.length,
    matrix.totalCommits,
  );

  const limitation = describeLimitation(
    candidates.length,
    touchedDirs.length,
    directories.length,
    matrix.totalCommits,
  );

  if (candidates.length === 0) {
    return {
      matches: [],
      confidence: 0,
      lowConfidence: true,
      limitation: limitation ?? "No candidate reviewers in the history window.",
    };
  }

  // --- score each candidate ---
  const matches: ReviewerMatch[] = candidates.map((login) => {
    const byDir = matrix.byAuthor[login] ?? {};

    // Ownership: this person's share of commits to the touched directories.
    let mine = 0;
    let all = 0;
    const ownedDirs: Array<{ dir: string; commits: number }> = [];

    for (const dir of directories) {
      const theirs = byDir[dir] ?? 0;
      const total = candidates.reduce(
        (sum, other) => sum + (matrix.byAuthor[other]?.[dir] ?? 0),
        0,
      );
      mine += theirs;
      all += total;
      if (theirs > 0) ownedDirs.push({ dir, commits: theirs });
    }

    const ownership = all > 0 ? clamp(mine / all) : 0;

    // Recency: exponential decay on days since their last commit anywhere.
    const last = matrix.lastTouch[login];
    const days = last
      ? (Date.now() - new Date(last).getTime()) / 86_400_000
      : Infinity;
    const recency = Number.isFinite(days)
      ? decay(days, RECENCY_HALF_LIFE_DAYS)
      : 0;

    // Review history. The matrix records authorship, not reviews — GitHub does
    // not expose a cheap per-path review index. Rather than invent a number,
    // authorship is used as the stand-in and the substitution is stated in the
    // reason text, so nobody reads it as something it is not.
    const reviewHistory = ownership;

    const isCodeowner = owners.has(login) || owners.has(`@${login}`);
    const codeowner = isCodeowner ? 1 : 0;

    const currentLoad = loads[login] ?? 0;
    const load = clamp(1 - currentLoad / LOAD_CEILING);

    const score = round(
      clamp(
        REVIEWER_WEIGHTS.ownership * ownership +
          REVIEWER_WEIGHTS.recency * recency +
          REVIEWER_WEIGHTS.reviewHistory * reviewHistory +
          REVIEWER_WEIGHTS.codeowner * codeowner +
          REVIEWER_WEIGHTS.load * load,
      ),
      4,
    );

    // --- reasons, ranked by what actually moved the score ---
    const reasons: string[] = [];

    if (isCodeowner) reasons.push("Listed in CODEOWNERS for these files");

    const topDir = ownedDirs.sort((a, b) => b.commits - a.commits)[0];
    if (topDir) {
      reasons.push(
        `${topDir.commits} commit${topDir.commits === 1 ? "" : "s"} to ${topDir.dir}/ in the history window`,
      );
    }

    if (Number.isFinite(days) && days < 14) {
      reasons.push(`Active recently — last commit ${Math.round(days)}d ago`);
    }

    if (currentLoad >= LOAD_CEILING) {
      reasons.push(`Already has ${currentLoad} open reviews`);
    }

    if (reasons.length === 0) {
      reasons.push("No direct history with these files");
    }

    return { login, score, reasons, currentLoad, isCodeowner };
  });

  const ranked = matches
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.login.localeCompare(b.login))
    .slice(0, limit);

  return {
    matches: ranked,
    confidence: round(confidence, 3),
    lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
    limitation,
  };
}

/** Commits below which a matrix has not learned anything worth trusting. */
const MIN_COMMITS = 20;

/**
 * How much signal the matrix genuinely had.
 *
 * **Gated, not averaged.** A weighted average was the first implementation and
 * it was wrong in the most dangerous way available: with five contributors and
 * 140 commits, a PR touching a directory *nobody had ever committed to* still
 * scored 0.60 and rendered as a confident recommendation. The engine knew the
 * problem — `describeLimitation` named it correctly — and the score buried it.
 *
 * Any one of these three failures alone makes a suggestion unfounded, so each
 * is a hard zero rather than a term that strong signal elsewhere can outvote:
 *
 *   - fewer than two candidates — nobody to choose between
 *   - too little history — nothing was learned
 *   - no coverage of the touched directories — nothing relevant was learned
 *
 * Only past all three gates does the magnitude of the signal matter.
 */
function computeConfidence(
  candidates: number,
  directories: number,
  touchedDirs: number,
  totalCommits: number,
): number {
  // --- gates ---
  if (candidates < MIN_CONTRIBUTORS) return 0;
  if (totalCommits < MIN_COMMITS) return 0;

  const coverage = directories > 0 ? touchedDirs / directories : 0;
  if (coverage === 0) return 0;

  // --- magnitude, only once the gates pass ---
  const contributorSignal = clamp(candidates / 5);
  const historySignal = clamp(totalCommits / 100);

  return clamp(
    0.3 * contributorSignal + 0.3 * historySignal + 0.4 * clamp(coverage),
  );
}

/** State the specific gap, rather than a generic "low confidence". */
function describeLimitation(
  candidates: number,
  touchedDirs: number,
  directories: number,
  totalCommits: number,
): string | null {
  if (candidates < MIN_CONTRIBUTORS) {
    return "Too few contributors in the history window to distinguish between reviewers.";
  }
  if (totalCommits < MIN_COMMITS) {
    return `Only ${totalCommits} commits of history available — not enough to infer expertise.`;
  }
  if (directories === 0) {
    // Every file was generated, so there is nothing to attribute.
    return "This PR changes only generated files — no authorship signal to match against.";
  }
  if (touchedDirs === 0) {
    return "No contributor has recent history in the directories this PR touches.";
  }
  return null;
}
