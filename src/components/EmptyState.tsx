"use client";

import { CheckCircle, RefreshCw } from "lucide-react";

interface EmptyStateProps {
  onRefresh: () => void;
  loading: boolean;
}

export default function EmptyState({ onRefresh, loading }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 px-8 text-center">
      <CheckCircle size={64} className="text-green-400" />
      <h2 className="text-2xl font-bold text-gray-800">Queue cleared</h2>
      <p className="text-gray-500">
        Nothing left to triage. Your attention is free.
      </p>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white rounded-full text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        Refresh
      </button>
    </div>
  );
}
