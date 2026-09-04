import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api-error";
import {
  listReviewRequested,
  listRepoPRs,
  isRateLimitError,
  rateLimitState,
  isValidRepo,
} from "@/lib/signals/github";
import {
  read as cacheRead,
  write as cacheWrite,
  ageOf,
  queueKey,
} from "@/lib/cache/store";
import { collectQueueSignals } from "@/lib/signals/collect";
import { assessRisk, baselineScore } from "@/lib/engines/risk-engine";
import { priorityScore, rankQueue } from "@/lib/engines/priority-engine";
import { estimateEffort, formatDuration } from "@/lib/engines/effort-estimator";
import { loadConfig } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import { guardRequest } from "@/lib/api-auth";
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
 *   drafts=1          include draft PRs, which are suppressed by default
 *
 * Ordered by *priority*, not risk: risk says how much attention a PR needs,
 * priority says what to open right now. Suppressed PRs (drafts, approved,
 * the viewer's own) are excluded from `prs` but still counted in the summary.
 *
 * Entirely deterministic — no LLM is involved. The deck paints from this
 * response alone, so it must never block on anything optional.
 */
export async function GET(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  const url = new URL(request.url);
  const repo = url.searchParams.get("repo");
  const limitParam = url.searchParams.get("limit");
  const includeSignals = url.searchParams.get("signals") === "1";
  const includeDrafts = url.searchParams.get("drafts") === "1";

  const limit = Number.isFinite(Number(limitParam))
    ? Math.min(Math.max(Number(limitParam) || 50, 1), 100)
    : 50;

  if (repo && !isValidRepo(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  return withAuth(async (identity) => {
    try {
      const config = await loadConfig();

      // Demo mode swaps the data source, never the scoring — fixtures run
      // through the same engine, so what you see offline is what the engine
      // genuinely produces.
      // Namespaced per user: two people asking for the same repo must not
      // share a cache entry, because their GitHub permissions differ.
      const cacheKeyForQueue = queueKey(identity.userId, repo, limit);

      let signals: PRSignals[];
      let stale: { ageMs: number; reason: string } | null = null;

      if (identity.demo) {
        signals = DEMO_SIGNALS;
      } else {
        try {
          signals = await collectLiveSignals(repo, limit, config.rules);
          // Cache the measurements — never the diffs. `cacheWrite` enforces that
          // structurally and throws if a patch ever reaches it.
          await cacheWrite(
            cacheKeyForQueue,
            signals.map((s) => ({
              ...s,
              files: s.files.map((file) => stripPatch(file)),
            })),
          ).catch(() => {});
        } catch (error) {
          // Rate limited, or GitHub unreachable. Serve the last good queue rather
          // than an error page — but say plainly that it is stale.
          const cached = await cacheRead<PRSignals[]>(cacheKeyForQueue);
          if (!cached) throw error;

          const ageMs = (await ageOf(cacheKeyForQueue)) ?? 0;
          const limited = isRateLimitError(error);
          stale = {
            ageMs,
            reason: limited
              ? "GitHub rate limit reached"
              : "GitHub is unreachable",
          };
          signals = cached;
        }
      }

      if (signals.length === 0) {
        return NextResponse.json({ prs: [], summary: emptySummary() });
      }

      // Who is triaging, so their own PRs drop out of the deck. Never fatal:
      // `getViewerLogin` returns null rather than throwing, and demo mode has
      // no token to ask about.
      const viewer = identity.login;

      // How many PRs each one blocks, resolved across the queue as a whole.
      const blockedCounts = countBlocked(signals);

      const scored = signals.map((signal) => {
        const risk = assessRisk(signal, { thresholds: config.thresholds });
        return {
          signal,
          number: signal.number,
          risk,
          priority: priorityScore(signal, risk, {
            viewer: viewer ?? undefined,
            blockedCount: blockedCounts.get(signal.number) ?? 0,
            includeDrafts,
          }),
          effort: estimateEffort(signal),
        };
      });

      const visible = rankQueue(scored.filter((s) => !s.priority.suppressed));

      const prs: TriagedPR[] = visible.map(
        ({ signal, risk, priority, effort }) => ({
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
          risk,
          priority,
          effort,
          baseline: baselineScore(signal),
          signals: includeSignals ? signal : undefined,
        }),
      );

      return NextResponse.json({
        prs,
        summary: summarise(prs, scored.length - prs.length),
        // Present only when the queue came from cache. The UI must show a banner.
        stale,
        rateLimit: identity.demo ? null : rateLimitState(),
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  });
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

/**
 * How many PRs each PR blocks.
 *
 * A PR blocks another when the other targets its head branch — a stacked PR
 * cannot merge until its base does. Only knowable by looking across the queue
 * as a whole, which is why it lives here rather than in a per-PR signal.
 */
function countBlocked(signals: PRSignals[]): Map<number, number> {
  const byHeadBranch = new Map<string, number>();
  for (const s of signals) {
    if (s.headBranch) byHeadBranch.set(`${s.repo}#${s.headBranch}`, s.number);
  }

  const counts = new Map<number, number>();
  for (const s of signals) {
    const blocker = byHeadBranch.get(`${s.repo}#${s.baseBranch}`);
    if (blocker !== undefined && blocker !== s.number) {
      counts.set(blocker, (counts.get(blocker) ?? 0) + 1);
    }
  }

  return counts;
}

function emptySummary(): QueueSummary {
  return {
    total: 0,
    byLevel: { low: 0, medium: 0, high: 0, critical: 0 },
    hasLowConfidence: false,
    totalMinutes: 0,
    totalMinutesLabel: "0 min",
    minutesByLevel: { low: 0, medium: 0, high: 0, critical: 0 },
    suppressed: 0,
  };
}

/**
 * Queue totals.
 *
 * `totalMinutes` is the "required" half of the capacity deficit: the review
 * work sitting in the queue right now. The "available" half — team capacity —
 * arrives with the capacity panel in Phase 5.
 */
function summarise(prs: TriagedPR[], suppressed: number): QueueSummary {
  const summary = emptySummary();
  summary.total = prs.length;
  summary.suppressed = suppressed;

  for (const pr of prs) {
    summary.byLevel[pr.risk.level]++;
    summary.minutesByLevel[pr.risk.level] += pr.effort.minutes;
    summary.totalMinutes += pr.effort.minutes;
    if (pr.risk.lowConfidence) summary.hasLowConfidence = true;
  }

  summary.totalMinutesLabel = formatDuration(summary.totalMinutes);
  return summary;
}
