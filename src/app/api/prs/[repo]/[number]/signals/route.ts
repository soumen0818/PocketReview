import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { toErrorResponse, notFound } from "@/lib/api-error";
import { isValidRepo } from "@/lib/signals/github";
import { collectSignals } from "@/lib/signals/collect";
import { signalConfidence } from "@/lib/signals/types";
import { assessRisk, baselineScore } from "@/lib/engines/risk-engine";
import { loadConfig } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";

/**
 * GET /api/prs/:repo/:number/signals
 *
 * Returns the raw measured signals for one PR — the "show your working" view.
 * Everything the risk engine reads is visible here, which is what makes a
 * score auditable rather than assertable.
 *
 * `repo` is URL-encoded "owner%2Fname".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repo: string; number: string }> },
) {
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
      // Demo mode reads the same fixtures the deck does, so every documented
      // endpoint works offline rather than only the ones the UI happens to call.
      const signals = identity.demo
        ? DEMO_SIGNALS.find((s) => s.repo === repo && s.number === number)
        : await collectSignals(repo, number, { rules: config.rules });

      if (!signals) throw notFound(`${repo}#${number}`);

      // The baseline is returned alongside the real score so the difference is
      // inspectable rather than merely asserted.
      return NextResponse.json({
        signals,
        confidence: signalConfidence(signals.availability),
        risk: assessRisk(signals, { thresholds: config.thresholds }),
        baseline: baselineScore(signals),
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}
