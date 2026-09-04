/**
 * Turning an upstream failure into an honest HTTP response.
 *
 * Two things were wrong before this existed, and both are the kind of thing a
 * tester finds immediately:
 *
 *   1. **A missing PR returned 500.** GitHub's 404 propagated as an unhandled
 *      error, so "you typed a PR number that does not exist" was reported as
 *      "the server broke". The status code is part of the API contract, not
 *      decoration.
 *   2. **Upstream text was forwarded verbatim.** `"Not Found -
 *      https://docs.github.com/rest/..."` tells a user nothing and leaks the
 *      shape of our internals. It also risks echoing whatever an upstream
 *      service decides to put in a message.
 *
 * Every route funnels its `catch` through `toErrorResponse`, so the mapping
 * lives in one place and cannot drift between endpoints.
 */

import { NextResponse } from "next/server";

/** An error we raised deliberately, with the status it should produce. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 404 helper — the case that was previously a 500. */
export function notFound(what: string): ApiError {
  return new ApiError(404, `${what} was not found.`);
}

/** 400 helper for malformed input. */
export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

/**
 * Largest JSON body any endpoint here accepts.
 *
 * Every request body in this app is a handful of fields — a repo slug, a PR
 * number, a budget in minutes. 64KB is generous by three orders of magnitude.
 * Without a cap, `request.json()` will happily buffer and parse tens of
 * megabytes, which is memory amplification for free. Not exploitable in a
 * local single-user tool, but the guard costs one function.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read and parse a JSON request body, bounded.
 *
 * Throws `ApiError` with the right status for both failure modes, so callers
 * just `await readJsonBody(request)` inside their existing try/catch.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.");
  }

  const text = await request.text();

  // Content-Length can be absent or wrong (chunked encoding), so the actual
  // length is checked too.
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "Request body is too large.");
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
}

interface UpstreamError {
  status?: number;
  message?: string;
}

/**
 * Map any thrown value onto a response.
 *
 * Upstream status codes are honoured where they are meaningful to the caller
 * (404 missing, 403/429 rate limited, 401 bad credentials) and collapsed to a
 * plain 500 otherwise. The message is always ours, never the upstream's.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }

  const upstream = error as UpstreamError;
  const status = typeof upstream?.status === "number" ? upstream.status : 0;

  switch (status) {
    case 404:
      return NextResponse.json(
        {
          error:
            "Not found on GitHub — check the repository and pull request number.",
        },
        { status: 404 },
      );

    case 401:
    case 403:
    case 429: {
      const rateLimited = status !== 401;
      return NextResponse.json(
        {
          error: rateLimited
            ? "GitHub rate limit reached, or access to this repository is denied."
            : "GITHUB_TOKEN was rejected. Check the token in .env.local.",
        },
        { status: rateLimited ? 429 : 401 },
      );
    }

    case 422:
      return NextResponse.json(
        { error: "GitHub rejected the request as invalid." },
        { status: 400 },
      );
  }

  // Anything else: log the detail server-side, tell the client nothing beyond
  // the fact that it failed.
  console.error("[api] unhandled error:", error);

  return NextResponse.json(
    { error: "Something went wrong handling this request." },
    { status: 500 },
  );
}
