import { execFile } from "child_process";
import { promisify } from "util";
import type { ChatMessage } from "./types";

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 8000;

export async function chatWithClaude({
  prTitle,
  prBody,
  diff,
  history,
  message,
}: {
  prTitle: string;
  prBody: string;
  diff: string;
  history: ChatMessage[];
  message: string;
}): Promise<string> {
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)"
      : diff;

  const conversationLines = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  const prompt = `You are a code review assistant. Answer questions about this PR concisely.

PR: ${prTitle}
Description: ${prBody || "(no description)"}

Diff:
${truncatedDiff}${
    conversationLines ? `\n\nConversation so far:\n${conversationLines}` : ""
  }

User: ${message}`;

  const { stdout } = await execFileAsync(
    "claude",
    ["-p", "--model", "sonnet", prompt],
    {
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  return stdout.trim();
}
