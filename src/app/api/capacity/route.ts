import { NextResponse } from "next/server";
import {
  listReviewRequested,
  listRepoPRs,
  getViewerLogin,
} from "@/lib/signals/github";
import { collectQueueSignals } from "@/lib/signals/collect";
import { assessRisk } from "@/lib/engines/risk-engine";
import { priorityScore } from "@/lib/engines/priority-engine";
import { estimateEffort } from "@/lib/engines/effort-estimator";
import { capacityReport, type PlanCandidate } from "@/lib/engines/review-plan";
import { loadConfig, isDemoMode } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import type { PRSignals } from "@/lib/signals/types";

/** Default assumed review capacity, in minutes, when none is given. */
const DEFAULT_CAPACITY_MINUTES = 90;

/**
 * GET /api/capacity
 *
 * Queue load against available review capacity — the deficit panel.
 *
 * Query:
 *   repo=owner/name    scope to one repository
 *   capacity=90        minutes available; the reviewer's own stated budget
 *   limit=50           maximum PRs to consider
 *
 * The capacity figure is the reviewer's, not an inferred team roster. A number
 * they control and can vouch for is worth more than a fabricated one.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
  const capacityParam = url.searchParams.get("capacity");
  const limitParam = url.searchParams.get("limit");

  if (repo && !/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  const capacityMinutes = Number.isFinite(Number(capacityParam))
    ? Math.max(Number(capacityParam) || DEFAULT_CAPACITY_MINUTES, 0)
    : DEFAULT_CAPACITY_MINUTES;

  const limit = Number.isFinite(Number(limitParam))
    ? Math.min(Math.max(Number(limitParam) || 50, 1), 100)
    : 50;

  try {
    const config = await loadConfig();

    const signals: PRSignals[] = isDemoMode()
      ? DEMO_SIGNALS
      : await collectLive(repo, limit, config.rules);

    const viewer = isDemoMode() ? null : await getViewerLogin();

    const candidates: PlanCandidate[] = [];
    for (const signal of signals) {
      const risk = assessRisk(signal, { thresholds: config.thresholds });
      const priority = priorityScore(signal, risk, {
        viewer: viewer ?? undefined,
      });

      if (priority.suppressed) continue;

      candidates.push({
        repo: signal.repo,
        number: signal.number,
        title: signal.title,
        priority: priority.score,
        risk: risk.score,
        riskLevel: risk.level,
        minutes: estimateEffort(signal).minutes,
      });
    }

    return NextResponse.json(capacityReport(candidates, capacityMinutes));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function collectLive(
  repo: string | null,
  limit: number,
  rules: Awaited<ReturnType<typeof loadConfig>>["rules"],
): Promise<PRSignals[]> {
  const summaries = repo
    ? await listRepoPRs(repo, limit)
    : await listReviewRequested(limit);

  if (summaries.length === 0) return [];

  return collectQueueSignals(
    summaries.map((pr) => ({ repo: pr.repo, number: pr.number })),
    { rules },
  );
}
