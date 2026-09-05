"use client";

import { CheckCircle, RefreshCw, Zap, Eye, ExternalLink, Inbox } from "lucide-react";
import { shortRepo } from "@/lib/risk-display";
import RepoScopeInput from "@/components/RepoScopeInput";
import type { TriageRecord } from "@/lib/types";

interface EmptyStateProps {
  onRefresh: () => void;
  loading: boolean;
  /** What was decided this session, newest last. */
  history?: TriageRecord[];
  onClearHistory?: () => void;
  /** The repository the queue is scoped to, if any. */
  scopedRepo?: string | null;
  /** Scope the queue to a repository. Omitted in demo mode. */
  onScopeRepo?: (repo: string) => void;
}

/**
 * The end of the queue.
 *
 * Previously this said "queue cleared" and nothing else, which left the
 * obvious question unanswered: *what happened to everything I just swiped?*
 * A triage decision that produces no visible outcome reads as a decision that
 * did nothing.
 *
 * So the lanes are shown. This is the whole product in one screen — the
 * reviewer's attention has been allocated, and here is where it went.
 */
export default function EmptyState({
  onRefresh,
  loading,
  history = [],
  onClearHistory,
  scopedRepo = null,
  onScopeRepo,
}: EmptyStateProps) {
  const fastTracked = history.filter((r) => r.action === "fast-track");
  const needsReview = history.filter((r) => r.action === "needs-review");
  const hasDecisions = history.length > 0;

  /**
   * Two very different situations share this screen, and conflating them was
   * misleading. "Queue cleared" after triaging ten PRs is an accomplishment;
   * the same words on a fresh account with no review requests reads as though
   * the app silently failed.
   *
   * With no decisions made and no scope set, the honest reading is that the
   * search found nothing — which is a normal state, not an error, and the one
   * place a repository is worth offering.
   */
  const nothingFound = !hasDecisions;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-6 py-6">
      <div className="flex flex-col items-center gap-2 text-center">
        {nothingFound ? (
          <Inbox size={44} className="text-gray-300" />
        ) : (
          <CheckCircle size={44} className="text-emerald-400" />
        )}

        <h2 className="text-xl font-bold text-gray-900">
          {nothingFound
            ? scopedRepo
              ? "No open pull requests"
              : "No reviews waiting"
            : "Queue cleared"}
        </h2>

        <p className="max-w-[280px] text-[13px] leading-relaxed text-gray-500">
          {nothingFound
            ? scopedRepo
              ? `${shortRepo(scopedRepo)} has no open pull requests to triage right now.`
              : "Nobody has requested your review yet. This queue fills up when someone adds you as a reviewer."
            : `${history.length} pull request${history.length === 1 ? "" : "s"} triaged. Your attention is free.`}
        </p>
      </div>

      {/* The way out of a dead end. Offered only when there is genuinely
          nothing to show — after a real triage session the queue being empty
          is the goal, and a repository field there would just be clutter. */}
      {nothingFound && onScopeRepo && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
          <RepoScopeInput
            onSubmit={onScopeRepo}
            label={
              scopedRepo
                ? "Try a different repository"
                : "Or triage a specific repository"
            }
          />
          <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
            Loads every open PR in that repository, not just the ones assigned
            to you. You still only see repositories your GitHub account can
            access.
          </p>
        </div>
      )}

      {hasDecisions && (
        <div className="mt-6 space-y-3">
          <Lane
            icon={<Eye size={13} />}
            title="Needs review"
            subtitle="Open these properly, highest risk first"
            records={needsReview}
            tone="amber"
          />
          <Lane
            icon={<Zap size={13} />}
            title="Fast-track"
            subtitle="A quick look is enough — still needs a human to approve"
            records={fastTracked}
            tone="emerald"
          />

          {/* The honest footnote. Without it, a reviewer could reasonably
              believe swiping right did something on GitHub. */}
          <p className="px-1 pt-1 text-[10.5px] leading-relaxed text-gray-400">
            These lanes are your notes, kept in this browser. PocketReview has
            no write access to GitHub — nothing here was approved, merged or
            commented on. Open a PR to act on it.
          </p>
        </div>
      )}

      <div className="mt-6 flex items-center justify-center gap-2">
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-2 rounded-full bg-gray-900 px-5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>

        {hasDecisions && onClearHistory && (
          <button
            onClick={onClearHistory}
            className="rounded-full px-4 py-2.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-100"
          >
            Start over
          </button>
        )}
      </div>
    </div>
  );
}

function Lane({
  icon,
  title,
  subtitle,
  records,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  records: TriageRecord[];
  tone: "amber" | "emerald";
}) {
  if (records.length === 0) return null;

  const palette =
    tone === "amber"
      ? {
          border: "border-amber-200",
          bg: "bg-amber-50",
          text: "text-amber-700",
        }
      : {
          border: "border-emerald-200",
          bg: "bg-emerald-50",
          text: "text-emerald-700",
        };

  return (
    <div className={`rounded-xl border ${palette.border} ${palette.bg} p-3`}>
      <div className="flex items-baseline gap-1.5">
        <span className={palette.text}>{icon}</span>
        <span className={`text-[12px] font-semibold ${palette.text}`}>
          {title}
        </span>
        <span className="text-[11px] tabular-nums text-gray-400">
          {records.length}
        </span>
      </div>
      <p className="mt-0.5 text-[10.5px] text-gray-500">{subtitle}</p>

      <ul className="mt-2 space-y-1">
        {/* Highest risk at the time of the decision first — the order the
            reviewer should work through them in. */}
        {[...records]
          .sort((a, b) => b.riskAtDecision - a.riskAtDecision)
          .map((record) => (
            <li key={`${record.repo}#${record.prNumber}`}>
              <a
                href={`https://github.com/${record.repo}/pull/${record.prNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                // A 44px row: these are tap targets on a phone, not dense
                // desktop list items.
                className="flex min-h-[36px] items-center gap-2 rounded-lg bg-white/70 px-2 py-1.5 text-[12px] text-gray-700 transition-colors hover:bg-white active:bg-white"
              >
                {/* The score at the time of the decision — the audit trail. */}
                <span
                  className="w-7 shrink-0 rounded bg-white px-1 py-0.5 text-center text-[11px] font-semibold tabular-nums text-gray-500"
                  title={`Scored ${record.riskAtDecision}/100 when you triaged it`}
                >
                  {record.riskAtDecision}
                </span>

                <span className="truncate font-medium">
                  {shortRepo(record.repo)}{" "}
                  <span className="text-gray-400">#{record.prNumber}</span>
                </span>

                {/* Was 9px at gray-300 — effectively invisible on a tinted
                    background, so the rows did not read as links at all. */}
                <ExternalLink
                  size={13}
                  strokeWidth={2}
                  className="ml-auto shrink-0 text-gray-500"
                  aria-hidden
                />
                <span className="sr-only">Open on GitHub</span>
              </a>
            </li>
          ))}
      </ul>
    </div>
  );
}
