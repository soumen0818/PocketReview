/**
 * Shared types crossing the server/client boundary.
 *
 * `TriagedPR` is the object the deck renders. Everything on it except
 * `explanation` is deterministic and arrives with the first response — the
 * card must never wait on an LLM to paint.
 */

import type { RiskAssessment } from "./engines/types";
import type { PRSignals } from "./signals/types";

/** Raw PR metadata, before scoring. */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: {
    login: string;
  };
  repository: {
    nameWithOwner: string;
  };
  createdAt: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  url: string;
}

/**
 * A scored pull request — what the triage deck consumes.
 *
 * `signals` is carried along so the breakdown view can show the measurements
 * behind the score without a second round trip. It is the "show your working"
 * data, and shipping it with the card is what lets the audit view open
 * instantly during a demo.
 */
export interface TriagedPR extends PullRequest {
  headSha: string;
  risk: RiskAssessment;
  /** Score from the naive lines-changed model, for comparison. */
  baseline: number;
  /** Present when the full signal set was collected. */
  signals?: PRSignals;
}

/**
 * Triage actions.
 *
 * `fast-track` records a queue-lane decision. It never approves or merges —
 * a human still reviews the PR, it simply is not what they open first.
 */
export type TriageAction = "fast-track" | "needs-review" | "defer";

/** Swipe directions the deck supports. */
export type SwipeDirection = "left" | "right";

/**
 * A recorded triage decision.
 *
 * `riskAtDecision` is an audit trail: it lets the queue later surface
 * "you fast-tracked this at 18; it has since changed and now scores 61".
 */
export interface TriageRecord {
  repo: string;
  prNumber: number;
  action: TriageAction;
  riskAtDecision: number;
  timestamp: number;
}

/** Legacy alias retained while the swipe history migrates to TriageRecord. */
export interface SwipeRecord {
  repo: string;
  prNumber: number;
  direction: SwipeDirection;
  timestamp: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Queue-level totals for the capacity view. */
export interface QueueSummary {
  total: number;
  byLevel: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  /** True when any PR scored with reduced signal availability. */
  hasLowConfidence: boolean;
}
