import { NextResponse } from "next/server";
import { toErrorResponse, notFound } from "@/lib/api-error";
import { isValidRepo } from "@/lib/signals/github";
import { collectSignals } from "@/lib/signals/collect";
import { assessRisk } from "@/lib/engines/risk-engine";
import { loadConfig, isDemoMode } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";

/**
 * GET /api/prs/:repo/:number/risk
 *
 * Returns the full risk assessment for one PR, including the per-dimension
 * contribution breakdown that makes the score auditable.
 *
 * Deterministic and fast: no LLM is involved at any point.
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

  try {
    const config = await loadConfig();
    // Demo mode reads the same fixtures the deck does, so every documented
    // endpoint works offline rather than only the ones the UI happens to call.
    const signals = isDemoMode()
      ? DEMO_SIGNALS.find((s) => s.repo === repo && s.number === number)
      : await collectSignals(repo, number, { rules: config.rules });

    if (!signals) throw notFound(`${repo}#${number}`);
    const risk = assessRisk(signals, { thresholds: config.thresholds });

    return NextResponse.json({
      repo,
      number,
      title: signals.title,
      author: signals.author,
      url: signals.url,
      headSha: signals.headSha,
      risk,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
