"use client";

import { RefreshCw } from "lucide-react";

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
      <button
        onClick={onRefresh}
        disabled={loading}
        className="p-2 rounded-full hover:bg-gray-100 transition-colors disabled:opacity-50 shrink-0"
        aria-label="Refresh triage queue"
      >
        <RefreshCw
          size={18}
          className={loading ? "animate-spin text-gray-400" : "text-gray-600"}
        />
      </button>
    </header>
  );
}
