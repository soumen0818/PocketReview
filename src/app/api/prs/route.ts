import { NextResponse } from "next/server";
import { listReviewRequested, listRepoPRs } from "@/lib/signals/github";
import type { PullRequest } from "@/lib/types";

/**
 * GET /api/prs
 *
 * Returns the open PRs awaiting the viewer's attention.
 *
 * Query:
 *   repo=owner/name   scope to one repository (defaults to review-requested
 *                     across every repository the token can see)
 *   limit=50          maximum PRs to return
 *
 * This endpoint is deterministic and must never block on an LLM call — the
 * deck has to paint from this response alone. Scoring is layered on in a
 * later phase; today it returns measured metadata only.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

  if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  try {
    const summaries = repo
      ? await listRepoPRs(repo, limit)
      : await listReviewRequested(limit);

    const prs: PullRequest[] = summaries.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: { login: pr.author },
      repository: { nameWithOwner: pr.repo },
      createdAt: pr.createdAt,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      url: pr.url,
    }));

    return NextResponse.json(prs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
