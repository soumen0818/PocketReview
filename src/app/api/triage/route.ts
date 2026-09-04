import { NextResponse } from "next/server";
import { toErrorResponse, notFound, readJsonBody } from "@/lib/api-error";
import { isValidRepo } from "@/lib/signals/github";
import { collectSignals } from "@/lib/signals/collect";
import { assessRisk } from "@/lib/engines/risk-engine";
import { evaluateFastTrack } from "@/lib/policy/gate";
import { loadConfig, isDemoMode } from "@/lib/config";
import { DEMO_SIGNALS } from "@/lib/demo/fixtures";
import type { TriageAction } from "@/lib/types";

const ACTIONS: TriageAction[] = ["fast-track", "needs-review", "defer"];

/**
 * POST /api/triage
 *
 * Records a triage decision and, for a fast-track, runs it past the policy
 * gate first.
 *
 * **This endpoint performs no merge and no approval.** There is no call to
 * `pulls.merge` or `pulls.createReview` here or anywhere else in the codebase —
 * the approve endpoint that once existed was deliberately deleted (Decision
 * Log #3). A fast-track marks a queue lane; a human still opens the PR.
 *
 * The gate can only *remove* eligibility. A vetoed fast-track is refused and
 * the reasons are returned so the card can show them.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return toErrorResponse(error);
  }

  const { repo, number, action } = (body ?? {}) as {
    repo?: string;
    number?: number;
    action?: TriageAction;
  };

  if (!isValidRepo(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  if (!Number.isInteger(number) || (number as number) <= 0) {
    return NextResponse.json(
      { error: "`number` must be a positive integer." },
      { status: 400 },
    );
  }

  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `\`action\` must be one of: ${ACTIONS.join(", ")}.` },
      { status: 400 },
    );
  }

  try {
    const config = await loadConfig();

    const signals = isDemoMode()
      ? DEMO_SIGNALS.find((s) => s.repo === repo && s.number === number)
      : await collectSignals(repo, number as number, { rules: config.rules });

    if (!signals) throw notFound(`${repo}#${number}`);

    const risk = assessRisk(signals, { thresholds: config.thresholds });

    // Only fast-track passes through the gate. Sending a PR to deep review or
    // deferring it needs no permission — neither reduces the scrutiny it gets.
    const verdict =
      action === "fast-track"
        ? evaluateFastTrack(signals, risk, { policy: config.policy })
        : null;

    const accepted = action !== "fast-track" || (verdict?.eligible ?? false);

    // The record the client stores. `riskAtDecision` is the audit trail: it
    // lets the queue later say "you fast-tracked this at 18; it now scores 61".
    const record = {
      repo,
      prNumber: number,
      action,
      riskAtDecision: risk.score,
      timestamp: Date.now(),
    };

    return NextResponse.json({
      accepted,
      record: accepted ? record : null,
      verdict,
      // Stated in the response, not just the docs: this endpoint never writes
      // to GitHub, whatever the verdict.
      performedOnGitHub: "none",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
