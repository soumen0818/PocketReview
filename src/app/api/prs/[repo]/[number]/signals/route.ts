import { NextResponse } from "next/server";
import { collectSignals } from "@/lib/signals/collect";
import { signalConfidence } from "@/lib/signals/types";
import { assessRisk, baselineScore } from "@/lib/engines/risk-engine";
import { loadConfig } from "@/lib/config";
import { guardRequest } from "@/lib/api-auth";

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
  request: Request,
  { params }: { params: Promise<{ repo: string; number: string }> },
) {
  const guard = guardRequest(request);
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

  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  try {
    const config = await loadConfig();
    const signals = await collectSignals(repo, number, {
      rules: config.rules,
    });

    // The baseline is returned alongside the real score so the difference is
    // inspectable rather than merely asserted.
    return NextResponse.json({
      signals,
      confidence: signalConfidence(signals.availability),
      risk: assessRisk(signals, { thresholds: config.thresholds }),
      baseline: baselineScore(signals),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
