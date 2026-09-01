"use client";

import { Plus, Minus, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PullRequest } from "@/lib/types";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface PRCardProps {
  pr: PullRequest;
  style?: React.CSSProperties;
}

export default function PRCard({ pr, style }: PRCardProps) {
  const hasBody = pr.body && pr.body.trim().length > 0;

  return (
    <div
      className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden select-none h-full flex flex-col"
      style={style}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-2 mb-1">
          <span className="text-xs text-gray-400 font-medium truncate">
            {pr.repository.nameWithOwner}
          </span>
          <span className="text-xs text-gray-400 font-mono shrink-0">
            #{pr.number}
          </span>
        </div>
        <h2 className="text-base font-semibold text-gray-900 leading-snug">
          {pr.title}
        </h2>
        <p className="text-xs text-gray-400 mt-1">
          @{pr.author.login} · {timeAgo(pr.createdAt)}
        </p>
      </div>

      {/* Stats */}
      {(pr.additions != null ||
        pr.deletions != null ||
        pr.changedFiles != null) && (
        <div className="mx-5 py-2.5 border-t border-b border-gray-100 flex items-center gap-4 text-xs">
          {pr.additions != null && (
            <span className="flex items-center gap-1 text-green-600 font-medium">
              <Plus size={12} />
              {pr.additions}
            </span>
          )}
          {pr.deletions != null && (
            <span className="flex items-center gap-1 text-red-500 font-medium">
              <Minus size={12} />
              {pr.deletions}
            </span>
          )}
          {pr.changedFiles != null && (
            <span className="flex items-center gap-1 text-gray-500">
              <FileText size={12} />
              {pr.changedFiles} file{pr.changedFiles !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}

      {/* Description */}
      <div className="px-5 py-3 flex-1 overflow-y-auto">
        {hasBody ? (
          <div className="prose-card">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {pr.body}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-gray-400 italic">No description</p>
        )}
      </div>
    </div>
  );
}
