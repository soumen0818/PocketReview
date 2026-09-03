/**
 * The explanation layer.
 *
 * The LLM has exactly one job: **turn computed facts into readable prose.**
 * It never computes a score, never ranks, never decides. Every number it is
 * allowed to use was passed to it as input, already computed by the risk
 * engine.
 *
 * That constraint is not enforced by asking politely in the prompt — it is
 * enforced structurally. The score exists before this file is ever called, and
 * nothing here can write back to it. If the model hallucinates a number, the
 * card still shows the arithmetic one; the prose is the only thing at risk.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  classifyError,
  hasApiKey,
  LLMUnavailable,
  MODELS,
} from "./client";
import { ExplanationCache } from "./cache";
import { prioritiseDiff } from "./diff-prioritise";
import { redactSecrets } from "../signals/diff";
import { loadConfig } from "../config";
import type { PRSignals } from "../signals/types";
import type { RiskAssessment } from "../engines/types";

/** The structured explanation the UI renders. */
export interface Explanation {
  /** Deck card summary, <= 90 characters. */
  oneLine: string;
  /** 2-3 sentences on what changed — behaviour, not diff mechanics. */
  whatChanged: string;
  /** Why it matters, grounded in the computed reasons. */
  whyItMatters: string;
  /** Ranked pointers to where a reviewer should look first. */
  whereToLookFirst: string[];
  /** What the reviewer should verify. */
  questionsToAsk: string[];
  /** Which model produced this, for the UI footer. */
  model: string;
  /** True when the diff did not fit and files were withheld. */
  diffTruncated: boolean;
}

const explanationCache = new ExplanationCache<Explanation>();
const summaryCache = new ExplanationCache<string>();

/** Clear both caches. Used by tests. */
export function resetExplanationCache(): void {
  explanationCache.clear();
  summaryCache.clear();
}

/** Cache statistics, for the debug endpoint. */
export function cacheStats(): { explanations: number; summaries: number } {
  return { explanations: explanationCache.size, summaries: summaryCache.size };
}

/**
 * The system prompt.
 *
 * Three rules carry the weight: never invent a number, describe behaviour
 * rather than diff mechanics, and say when a signal is absent instead of
 * speculating. The last one matters most — a model that fills gaps with
 * plausible guesses is worse than no explanation, because it reads exactly
 * like a real one.
 */
const SYSTEM_PROMPT = `You explain pre-computed pull-request risk assessments to a reviewer deciding where to spend their attention.

Rules, in order of importance:
1. NEVER invent, alter, or recompute a numeric score. Every number you may use is given to you below. If you want to cite a figure that is not provided, omit it.
2. Describe BEHAVIOUR, not diff mechanics. "Removes the token expiry check" — not "modifies 3 lines in middleware.ts".
3. If a signal is absent or a file was not shown to you, say so plainly. Never speculate about code you were not given.
4. Be concrete and brief. A reviewer reads this on a phone, between meetings.
5. Do not pass judgement on whether the code is correct — you cannot know that. Say what a reviewer should check.

You are not reviewing the code. You are helping someone decide what to read first.`;

/** JSON shape the model must return. */
const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    oneLine: {
      type: "string" as const,
      description:
        "Deck card summary, at most 90 characters. Behavioural, no score.",
    },
    whatChanged: {
      type: "string" as const,
      description: "2-3 sentences describing what the change does.",
    },
    whyItMatters: {
      type: "string" as const,
      description:
        "Why this needs attention, grounded in the supplied risk reasons.",
    },
    whereToLookFirst: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "2-4 ranked pointers, ideally file or file:area.",
    },
    questionsToAsk: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "2-4 things the reviewer should verify.",
    },
  },
  required: [
    "oneLine",
    "whatChanged",
    "whyItMatters",
    "whereToLookFirst",
    "questionsToAsk",
  ],
  additionalProperties: false,
};

/** Render the computed facts the model is allowed to talk about. */
function renderFacts(signals: PRSignals, risk: RiskAssessment): string {
  const dimensions = risk.dimensions
    .filter((d) => d.contribution > 0.5)
    .sort((a, b) => b.contribution - a.contribution)
    .map(
      (d) =>
        `  - ${d.name}: ${d.contribution} points — ${d.reasons[0] ?? "no detail"}`,
    )
    .join("\n");

  const modifiers = risk.modifiers.length
    ? risk.modifiers
        .map((m) => `  - ${m.label} (${m.delta > 0 ? "+" : ""}${m.delta})`)
        .join("\n")
    : "  (none)";

  const floor = risk.floor
    ? `\nA floor of ${risk.floor} was applied because: ${risk.floorReasons.join("; ")}.`
    : "";

  const confidence = risk.lowConfidence
    ? `\nSIGNAL CONFIDENCE IS LOW (${Math.round(risk.confidence * 100)}%) — some measurements were unavailable. Mention this.`
    : "";

  return `COMPUTED RISK ASSESSMENT (do not alter these numbers)
Score: ${risk.score}/100 (${risk.level})

Dimension contributions:
${dimensions || "  (none above threshold)"}

Modifiers applied:
${modifiers}${floor}${confidence}

Top computed reasons:
${risk.topReasons.map((r) => `  - ${r}`).join("\n")}

MEASURED SIGNALS
  Title: ${signals.title}
  Files changed: ${signals.changedFiles} (+${signals.additions} −${signals.deletions})
  Critical paths touched: ${signals.criticalPaths.length ? signals.criticalPaths.slice(0, 5).join(", ") : "none"}
  Tests: ${signals.testsRemoved ? "TESTS WERE REMOVED" : signals.hasNoTests ? "no tests added alongside production code" : `${signals.testLinesAdded} test lines for ${signals.productionLinesAdded} production lines`}
  CI: ${signals.ciStatus}${signals.failingChecks.length ? ` (failing: ${signals.failingChecks.slice(0, 3).join(", ")})` : ""}
  Dependencies added: ${signals.dependenciesAdded}
  Author: ${signals.author}${signals.authorIsFirstTimeContributor ? " (first-time contributor)" : ""}`;
}

/** Extract the model's JSON, tolerating prose around it. */
function parseExplanation(
  text: string,
): Omit<Explanation, "model" | "diffTruncated"> {
  // Structured outputs should give clean JSON, but a model that wraps it in
  // a fence must not crash the screen.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  const parsed = JSON.parse(candidate) as Record<string, unknown>;

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    oneLine:
      typeof parsed.oneLine === "string" ? parsed.oneLine.slice(0, 120) : "",
    whatChanged:
      typeof parsed.whatChanged === "string" ? parsed.whatChanged : "",
    whyItMatters:
      typeof parsed.whyItMatters === "string" ? parsed.whyItMatters : "",
    whereToLookFirst: asStringArray(parsed.whereToLookFirst).slice(0, 5),
    questionsToAsk: asStringArray(parsed.questionsToAsk).slice(0, 5),
  };
}

/**
 * Explain one pull request.
 *
 * Cached on `repo:number:headSha`, so an unchanged PR is explained once
 * however many times the demo is rehearsed.
 *
 * Throws `LLMUnavailable` when the model cannot be reached. Callers must treat
 * that as a missing sentence, never as a failed request — the deck has already
 * painted by the time this resolves.
 */
export async function explainRisk(
  signals: PRSignals,
  risk: RiskAssessment,
): Promise<Explanation> {
  const config = await loadConfig();

  if (!config.llm.enabled) {
    throw new LLMUnavailable(
      "disabled",
      "The explanation layer is disabled in .pocketreview.yml.",
    );
  }

  const client = anthropic();
  if (!client) {
    throw new LLMUnavailable(
      "no-api-key",
      "ANTHROPIC_API_KEY is not set — scores and plans still work without it.",
    );
  }

  const key = ExplanationCache.key(
    signals.repo,
    signals.number,
    signals.headSha,
  );

  return explanationCache.resolve(key, async () => {
    const diff = prioritiseDiff(signals.files, config.llm.maxDiffChars);

    // Redaction happens on the way out, without exception. Diffs are the only
    // thing that leaves this process, and a leaked credential cannot be recalled.
    const safeDiff = redactSecrets(diff.text);

    const userPrompt = `${renderFacts(signals, risk)}

PR DESCRIPTION
${signals.body?.trim() ? signals.body.slice(0, 1500) : "(no description provided)"}

DIFF (ranked by review consequence, most consequential first)
${safeDiff}

Explain this pull request as JSON matching the required schema.`;

    try {
      const response = await client.messages.create({
        model: MODELS.explain,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        output_config: {
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
      });

      if (response.stop_reason === "refusal") {
        throw new LLMUnavailable(
          "api-error",
          "The model declined to explain this diff.",
        );
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = parseExplanation(text);

      return {
        ...parsed,
        model: MODELS.explain,
        diffTruncated: diff.truncated,
      };
    } catch (error) {
      throw classifyError(error);
    }
  });
}

/**
 * A one-line deck summary.
 *
 * Haiku rather than Sonnet: this is the high-volume path — potentially every
 * card in the queue — and a single behavioural sentence does not need the
 * larger model.
 */
export async function summarisePR(
  signals: PRSignals,
  risk: RiskAssessment,
): Promise<string> {
  const config = await loadConfig();
  if (!config.llm.enabled) {
    throw new LLMUnavailable("disabled", "Explanation layer disabled.");
  }

  const client = anthropic();
  if (!client) {
    throw new LLMUnavailable("no-api-key", "ANTHROPIC_API_KEY is not set.");
  }

  const key = ExplanationCache.key(
    signals.repo,
    signals.number,
    signals.headSha,
  );

  return summaryCache.resolve(key, async () => {
    // A summary needs far less diff than a full explanation — a quarter of the
    // budget keeps the high-volume path cheap.
    const diff = prioritiseDiff(
      signals.files,
      Math.floor(config.llm.maxDiffChars / 4),
    );

    try {
      const response = await client.messages.create({
        model: MODELS.summary,
        max_tokens: 100,
        system:
          "You write one-line summaries of pull requests for a triage card. " +
          "Describe what the change does behaviourally, in at most 90 characters. " +
          "No score, no verdict, no preamble — just the sentence.",
        messages: [
          {
            role: "user",
            content: `Title: ${signals.title}
Files: ${signals.changedFiles} changed${signals.criticalPaths.length ? `, touching ${signals.criticalPaths.slice(0, 3).join(", ")}` : ""}

${redactSecrets(diff.text)}

One line, at most 90 characters:`,
          },
        ],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      return text.slice(0, 120);
    } catch (error) {
      throw classifyError(error);
    }
  });
}

export { hasApiKey };
