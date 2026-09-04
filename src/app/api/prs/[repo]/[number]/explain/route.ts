import { NextResponse } from "next/server";
import { isValidRepo } from "@/lib/signals/github";
import { withAuth } from "@/lib/auth/guard";
import { toErrorResponse, notFound } from "@/lib/api-error";
import { collectSignals } from "@/lib/signals/collect";
import { assessRisk } from "@/lib/engines/risk-engine";
import { explainRisk } from "@/lib/llm/explain";
import { LLMUnavailable } from "@/lib/llm/client";
import { loadConfig } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import { guardRequest } from "@/lib/rate-limit";

/**
 * GET /api/prs/:repo/:number/explain
 *
 * Prose about an already-computed assessment. The score is calculated first,
 * here, in code — the model only narrates it.
 *
 * Cached on `repo:number:headSha`, so an unchanged PR is explained once.
 *
 * This endpoint is **optional by construction**: the deck has already painted
 * from `/api/prs` before it is called, and every failure returns a structured
 * reason rather than breaking the card.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ repo: string; number: string }> },
) {
  // explain triggers an LLM call — stricter limit than other endpoints
  const guard = guardRequest(request, { maxPerMinute: 10 });
  if (guard) return guard;

  const { repo: encodedRepo, number: rawNumber } = await params;

  const repo = decodeURIComponent(encodedRepo);
  const number = Number.parseInt(rawNumber, 10);

  if (!Number.isInteger(number) || number <= 0) {
    return NextResponse.json(
      { error: `Invalid PR number "${rawNumber}".` },
      { status: 400 },
    );
  }

  if (!isValidRepo(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  return withAuth(async (identity) => {
    try {
      const config = await loadConfig();

      // Demo mode explains the fixtures, so the offline demo exercises the real
      // prompt and the real model rather than canned prose.
      const signals = identity.demo
        ? DEMO_SIGNALS.find((s) => s.repo === repo && s.number === number)
        : await collectSignals(repo, number, { rules: config.rules });

      if (!signals) throw notFound(`${repo}#${number}`);

      const risk = assessRisk(signals, { thresholds: config.thresholds });
      const explanation = await explainRisk(signals, risk);

      return NextResponse.json({ repo, number, explanation });
    } catch (error) {
      // An unavailable model is an expected state, not a server fault. 503 with
      // a machine-readable `kind` lets the UI say something specific and true.
      if (error instanceof LLMUnavailable) {
        return NextResponse.json(
          { error: error.message, kind: error.kind },
          { status: 503 },
        );
      }

      return toErrorResponse(error);
    }
  });
}
