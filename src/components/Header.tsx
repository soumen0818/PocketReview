"use client";

import Link from "next/link";
import { RefreshCw, CalendarClock, LogOut } from "lucide-react";

interface HeaderProps {
  onRefresh: () => void;
  loading: boolean;
  login?: string | null;
  avatarUrl?: string | null;
  demoMode?: boolean;
  /** "local" when running on a personal token with no sign-in. */
  mode?: "demo" | "oauth" | "local" | "unconfigured";
  onSignOut?: () => void;
}

export default function Header({
  onRefresh,
  loading,
  login,
  avatarUrl,
  demoMode,
  mode,
  onSignOut,
}: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
      <div className="flex min-w-0 items-center gap-2.5">
        {avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-full"
          />
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight leading-none">
            PocketReview
          </h1>
          <p className="text-[11px] text-gray-400 mt-0.5">
            {demoMode
              ? "Demo — sample data"
              : login
                ? `@${login}`
                : mode === "local"
                  ? "Local — your token"
                  : "Triage queue"}
          </p>
        </div>
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

        {login && onSignOut && (
          <button
            onClick={onSignOut}
            className="rounded-full p-2 text-gray-600 transition-colors hover:bg-gray-100"
            aria-label="Sign out"
            title={`Sign out of @${login}`}
          >
            <LogOut size={17} />
          </button>
        )}

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
