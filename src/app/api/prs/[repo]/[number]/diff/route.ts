import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api-error";
import { getPRDiff, isValidRepo } from "@/lib/signals/github";
import { redactSecrets } from "@/lib/signals/diff";
import { guardRequest } from "@/lib/api-auth";

/**
 * GET /api/prs/:repo/:number/diff
 *
 * Returns the unified diff as plain text. Credentials are redacted before the
 * text leaves this process.
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

  if (!isValidRepo(repo)) {
    return NextResponse.json(
      { error: `Invalid repository "${repo}" — expected "owner/name".` },
      { status: 400 },
    );
  }

  return withAuth(async (identity) => {
    // Demo fixtures deliberately carry no diff text — they are committed to
    // the repository, and `docs/security.md` promises no source code is
    // persisted. Saying so is better than a 500 from a GitHub call that
    // cannot succeed without a token.
    if (identity.demo) {
      return NextResponse.json(
        {
          error:
            "Diffs are unavailable in demo mode — the committed fixtures carry measurements only, never source code.",
        },
        { status: 409 },
      );
    }

    try {
      const diff = await getPRDiff(repo, number);
      return new NextResponse(redactSecrets(diff), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  });
}
