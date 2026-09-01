import { NextRequest, NextResponse } from "next/server";
import { getPRDiff } from "@/lib/signals/github";
import { chatWithClaude } from "@/lib/claude";
import type { ChatMessage } from "@/lib/types";

// Server-side diff cache: repo:number -> diff string
const diffCache = new Map<string, string>();

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { repo, prNumber, prTitle, prBody, message, history } = body as {
    repo: string;
    prNumber: number;
    prTitle: string;
    prBody: string;
    message: string;
    history: ChatMessage[];
  };

  if (!repo || !prNumber || !message) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  // Fetch diff with caching
  const cacheKey = `${repo}:${prNumber}`;
  let diff = diffCache.get(cacheKey);
  if (!diff) {
    try {
      diff = await getPRDiff(repo, prNumber);
      diffCache.set(cacheKey, diff);
    } catch {
      diff = "(diff unavailable)";
    }
  }

  try {
    const reply = await chatWithClaude({
      prTitle,
      prBody,
      diff,
      history,
      message,
    });
    return NextResponse.json({ reply });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
