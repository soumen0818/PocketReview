import { NextResponse } from "next/server";
import { collectSignals } from "@/lib/signals/collect";
import { assessRisk } from "@/lib/engines/risk-engine";
import { loadConfig } from "@/lib/config";
import { guardRequest } from "@/lib/api-auth";

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
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
