import { NextResponse } from "next/server";
import { getPRDiff } from "@/lib/signals/github";
import { redactSecrets } from "@/lib/signals/diff";

/**
 * GET /api/prs/:repo/:number/diff
 *
 * Returns the unified diff as plain text. Credentials are redacted before the
 * text leaves this process.
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

  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  try {
    const diff = await getPRDiff(repo, number);
    return new NextResponse(redactSecrets(diff), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
