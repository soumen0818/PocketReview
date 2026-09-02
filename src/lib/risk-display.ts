/**
 * Presentation tokens for risk levels.
 *
 * Centralised so the badge, the card border, the breakdown bars and the queue
 * summary cannot drift apart. A level means the same colour everywhere in the
 * product, which is what lets a reviewer read the deck at a glance.
 */

import type { RiskLevel } from "./engines/types";

export interface LevelStyle {
  label: string;
  /** Emoji marker, used where colour alone is not enough. */
  dot: string;
  /** Badge background. */
  bg: string;
  /** Badge text. */
  text: string;
  /** Badge border. */
  border: string;
  /** Solid fill for progress bars. */
  bar: string;
  /** Card edge accent. */
  accent: string;
}

export const LEVEL_STYLES: Record<RiskLevel, LevelStyle> = {
  low: {
    label: "Low",
    dot: "🟢",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    bar: "bg-emerald-500",
    accent: "bg-emerald-400",
  },
  medium: {
    label: "Medium",
    dot: "🟡",
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    bar: "bg-amber-500",
    accent: "bg-amber-400",
  },
  high: {
    label: "High",
    dot: "🟠",
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    bar: "bg-orange-500",
    accent: "bg-orange-400",
  },
  critical: {
    label: "Critical",
    dot: "🔴",
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
    bar: "bg-red-500",
    accent: "bg-red-400",
  },
};

export function levelStyle(level: RiskLevel): LevelStyle {
  return LEVEL_STYLES[level];
}

/** Compact relative time: "4h ago", "2d ago". */
export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Short repository name — "acme/payments-api" becomes "payments-api". */
export function shortRepo(nameWithOwner: string): string {
  const slash = nameWithOwner.indexOf("/");
  return slash === -1 ? nameWithOwner : nameWithOwner.slice(slash + 1);
}
