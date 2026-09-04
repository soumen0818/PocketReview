import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { toErrorResponse, notFound } from "@/lib/api-error";
import { isValidRepo } from "@/lib/signals/github";
import { buildExpertiseMatrix } from "@/lib/signals/history";
import { collectSignals } from "@/lib/signals/collect";
import { suggestReviewers } from "@/lib/engines/reviewer-engine";
import { loadConfig } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import type { ExpertiseMatrix } from "@/lib/signals/history";

/**
 * Expertise matrices, cached per repository.
 *
 * Scanning commit history is the most expensive computation in the system —
 * hundreds of API calls — and it must never run per request. Cached for the
 * process lifetime; a restart costs one rebuild.
 */
const matrices = new Map<
  string,
  { matrix: ExpertiseMatrix; builtAt: number }
>();
const MATRIX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Cap on cached repositories.
 *
 * Each matrix is small (bounded to 200 commits), so the realistic exposure is
 * a few KB per repo — but a map with a TTL and no size limit still grows
 * without bound across a long-lived process serving many repositories. The
 * eviction is cheap insurance rather than a response to a measured problem.
 */
const MAX_MATRICES = 20;

async function getMatrix(repo: string): Promise<ExpertiseMatrix> {
  const cached = matrices.get(repo);
  if (cached && Date.now() - cached.builtAt < MATRIX_TTL_MS) {
    // Refresh recency so the LRU eviction below keeps what is in active use.
    matrices.delete(repo);
    matrices.set(repo, cached);
    return cached.matrix;
  }

  const matrix = await buildExpertiseMatrix(repo);

  if (matrices.size >= MAX_MATRICES && !matrices.has(repo)) {
    const oldest = matrices.keys().next().value;
    if (oldest !== undefined) matrices.delete(oldest);
  }

  matrices.set(repo, { matrix, builtAt: Date.now() });
  return matrix;
}

/**
 * GET /api/reviewers
 *
 * Suggests reviewers for one PR, or summarises the expertise matrix.
 *
 * Query:
 *   repo=owner/name    required
 *   number=123         optional — when given, returns ranked matches for that PR
 *
 * **When confidence is below the threshold the UI must hide the card.** The
 * response says so explicitly via `lowConfidence` and names the specific gap in
 * `limitation`, rather than returning a plausible-looking guess.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
  const numberParam = url.searchParams.get("number");

  if (!isValidRepo(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  return withAuth(async (identity) => {
    try {
      const config = await loadConfig();

      // Demo mode has no git history to scan, so the matrix is empty and the
      // engine correctly reports low confidence rather than inventing names.
      const matrix = identity.demo
        ? { byAuthor: {}, lastTouch: {}, contributors: [], totalCommits: 0 }
        : await getMatrix(repo);

      if (!numberParam) {
        return NextResponse.json({
          repo,
          contributors: matrix.contributors.length,
          totalCommits: matrix.totalCommits,
          directories: [
            ...new Set(
              Object.values(matrix.byAuthor).flatMap((d) => Object.keys(d)),
            ),
          ].length,
        });
      }

      const number = Number.parseInt(numberParam, 10);
      if (!Number.isInteger(number) || number <= 0) {
        return NextResponse.json(
          { error: `Invalid PR number "${numberParam}".` },
          { status: 400 },
        );
      }

      const signals = identity.demo
        ? DEMO_SIGNALS.find((s) => s.repo === repo && s.number === number)
        : await collectSignals(repo, number, { rules: config.rules });

      if (!signals) throw notFound(`${repo}#${number}`);

      const suggestion = suggestReviewers(signals, matrix);

      return NextResponse.json({ repo, number, ...suggestion });
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}
