"use client";

import { CloudOff } from "lucide-react";

interface StaleBannerProps {
  stale: { ageMs: number; reason: string } | null;
}

/**
 * Shown when the queue came from cache rather than from GitHub.
 *
 * A silent fallback would be worse than the error it replaces: the reviewer
 * would trust an out-of-date queue. Saying *why* and *how old* is what makes
 * serving stale data honest rather than misleading.
 */
export default function StaleBanner({ stale }: StaleBannerProps) {
  if (!stale) return null;

  return (
    <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5">
      <CloudOff size={12} className="shrink-0 text-amber-600" />
      <p className="text-[10.5px] text-amber-800">
        <span className="font-semibold">{stale.reason}</span> — showing the
        queue as of {describeAge(stale.ageMs)}.
      </p>
    </div>
  );
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
