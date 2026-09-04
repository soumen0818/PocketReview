import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { toErrorResponse, readJsonBody } from "@/lib/api-error";
import {
  listReviewRequested,
  listRepoPRs,
  isValidRepo,
} from "@/lib/signals/github";
import { collectQueueSignals } from "@/lib/signals/collect";
import { assessRisk } from "@/lib/engines/risk-engine";
import { priorityScore } from "@/lib/engines/priority-engine";
import { estimateEffort } from "@/lib/engines/effort-estimator";
import {
  buildReviewPlan,
  capacityReport,
  MIN_BUDGET_MINUTES,
  MAX_BUDGET_MINUTES,
  type PlanCandidate,
} from "@/lib/engines/review-plan";
import { loadConfig } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import type { PRSignals } from "@/lib/signals/types";

/**
 * POST /api/review-plan
 *
 * Body:
 *   { repo?: string, budgetMinutes: number, limit?: number, includeDrafts?: boolean }
 *
 * Answers "I have N minutes — what should I do?" with an exact 0/1 knapsack
 * over the scored queue, plus the capacity report behind the deficit panel.
 *
 * Entirely deterministic: no LLM, no randomness. The same queue and budget
 * produce the same plan every time.
 */
export async function POST(request: Request) {
  let body: unknown;
  return withAuth(async (identity) => {
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return toErrorResponse(error);
    }

    const {
      repo,
      budgetMinutes,
      limit: rawLimit,
      includeDrafts = false,
    } = (body ?? {}) as {
      repo?: string;
      budgetMinutes?: number;
      limit?: number;
      includeDrafts?: boolean;
    };

    if (typeof budgetMinutes !== "number" || !Number.isFinite(budgetMinutes)) {
      return NextResponse.json(
        { error: "`budgetMinutes` is required and must be a number." },
        { status: 400 },
      );
    }

    if (repo !== undefined && !isValidRepo(repo)) {
      return NextResponse.json(
        { error: `Invalid repository "${repo}" — expected "owner/name".` },
        { status: 400 },
      );
    }

    const limit = Number.isFinite(Number(rawLimit))
      ? Math.min(Math.max(Number(rawLimit) || 50, 1), 100)
      : 50;

    try {
      const config = await loadConfig();

      const signals: PRSignals[] = identity.demo
        ? DEMO_SIGNALS
        : await collectLive(repo ?? null, limit, config.rules);

      const viewer = identity.login;

      // Only PRs that belong in the deck can belong in a plan: a draft or an
      // already-approved PR is not work this reviewer should schedule.
      const candidates: PlanCandidate[] = [];
      for (const signal of signals) {
        const risk = assessRisk(signal, { thresholds: config.thresholds });
        const priority = priorityScore(signal, risk, {
          viewer: viewer ?? undefined,
          includeDrafts,
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

      const plan = buildReviewPlan(candidates, budgetMinutes);
      const capacity = capacityReport(candidates, plan.budgetMinutes);

      return NextResponse.json({ plan, capacity });
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}

/**
 * GET /api/review-plan
 *
 * Documents the endpoint rather than 405-ing a curious caller.
 */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/review-plan",
    body: {
      repo: "owner/name — optional, defaults to review-requested",
      budgetMinutes: `number, clamped to [${MIN_BUDGET_MINUTES}, ${MAX_BUDGET_MINUTES}]`,
      limit: "optional, 1-100, default 50",
      includeDrafts: "optional boolean, default false",
    },
  });
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
