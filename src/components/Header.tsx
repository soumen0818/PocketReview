"use client";

import Link from "next/link";
import { RefreshCw, CalendarClock } from "lucide-react";

interface HeaderProps {
  onRefresh: () => void;
  loading: boolean;
}

export default function Header({ onRefresh, loading }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight leading-none">
          PocketReview
        </h1>
        <p className="text-[11px] text-gray-400 mt-0.5">Triage queue</p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* "I have 30 minutes — what should I do?" is one tap away. */}
        <Link
          href="/plan"
          className="p-2 rounded-full hover:bg-gray-100 transition-colors text-gray-600"
          aria-label="Open the review plan"
          title="Review plan"
        >
          <CalendarClock size={18} />
        </Link>

        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-2 rounded-full hover:bg-gray-100 transition-colors disabled:opacity-50"
          aria-label="Refresh triage queue"
        >
          <RefreshCw
            size={18}
            className={loading ? "animate-spin text-gray-400" : "text-gray-600"}
          />
        </button>
      </div>
    </header>
  );
}
