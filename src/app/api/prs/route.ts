import { NextResponse } from "next/server";
import { listReviewRequested, listRepoPRs } from "@/lib/signals/github";
import { collectQueueSignals } from "@/lib/signals/collect";
import { assessRisk, baselineScore } from "@/lib/engines/risk-engine";
import { loadConfig, isDemoMode } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import type { PRSignals } from "@/lib/signals/types";
import type { TriagedPR, QueueSummary } from "@/lib/types";

/**
 * GET /api/prs
 *
 * Returns the scored triage queue, highest risk first.
 *
 * Query:
 *   repo=owner/name   scope to one repository (default: review-requested
 *                     across every repository the token can see)
 *   limit=50          maximum PRs to consider
 *   signals=1         include the full signal set per PR (heavier response,
 *                     lets the breakdown view open with no round trip)
 *
 * Entirely deterministic — no LLM is involved. The deck paints from this
 * response alone, so it must never block on anything optional.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
  const limitParam = url.searchParams.get("limit");
  const includeSignals = url.searchParams.get("signals") === "1";

  const limit = Number.isFinite(Number(limitParam))
    ? Math.min(Math.max(Number(limitParam) || 50, 1), 100)
    : 50;

  if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  try {
    const config = await loadConfig();

    // Demo mode swaps the data source, never the scoring — fixtures run
    // through the same engine, so what you see offline is what the engine
    // genuinely produces.
    const signals = isDemoMode()
      ? DEMO_SIGNALS
      : await collectLiveSignals(repo, limit, config.rules);

    if (signals.length === 0) {
      return NextResponse.json({ prs: [], summary: emptySummary() });
    }

    const prs: TriagedPR[] = signals.map((signal) => ({
      number: signal.number,
      title: signal.title,
      body: signal.body,
      author: { login: signal.author },
      repository: { nameWithOwner: signal.repo },
      createdAt: signal.createdAt,
      additions: signal.additions,
      deletions: signal.deletions,
      changedFiles: signal.changedFiles,
      url: signal.url,
      headSha: signal.headSha,
      risk: assessRisk(signal, { thresholds: config.thresholds }),
      baseline: baselineScore(signal),
      signals: includeSignals ? signal : undefined,
    }));

    // Rank by score. Full priority ordering — urgency, age, blocking impact —
    // lands in Phase 4; until then risk order is the honest approximation.
    prs.sort((a, b) => b.risk.score - a.risk.score);

    return NextResponse.json({ prs, summary: summarise(prs) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Fetch and measure the live queue from GitHub. */
async function collectLiveSignals(
  repo: string | null,
  limit: number,
  rules: Awaited<ReturnType<typeof loadConfig>>["rules"],
): Promise<PRSignals[]> {
  const summaries = repo
    ? await listRepoPRs(repo, limit)
    : await listReviewRequested(limit);

  if (summaries.length === 0) return [];

  // Collected in parallel. This pass also resolves `isBlockingOthers`, which
  // can only be known by looking across the queue as a whole.
  return collectQueueSignals(
    summaries.map((pr) => ({ repo: pr.repo, number: pr.number })),
    { rules },
  );
}

function emptySummary(): QueueSummary {
  return {
    total: 0,
    byLevel: { low: 0, medium: 0, high: 0, critical: 0 },
    hasLowConfidence: false,
  };
}

function summarise(prs: TriagedPR[]): QueueSummary {
  const summary = emptySummary();
  summary.total = prs.length;

  for (const pr of prs) {
    summary.byLevel[pr.risk.level]++;
    if (pr.risk.lowConfidence) summary.hasLowConfidence = true;
  }

  return summary;
}
