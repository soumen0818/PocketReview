"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { isRepoSlug } from "@/hooks/useRepoScope";

/**
 * Point the queue at one repository.
 *
 * The fallback path when nobody has requested your review on anything — a real
 * state on a working account, and one where an empty screen is a dead end.
 *
 * Accepts a pasted GitHub URL as well as an `owner/name` slug, because people
 * copy the address bar rather than retyping the slug. Normalising here rather
 * than rejecting is the difference between a field that works and one that
 * technically works.
 */

/** Pull `owner/name` out of whatever the user pasted. */
export function normaliseRepoInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // A full GitHub URL: https://github.com/owner/name/pull/123, with or without
  // protocol, trailing path, query or fragment.
  const url = value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^github\.com\//i, "");

  const [owner, name] = url.split(/[/?#]/);
  if (!owner || !name) return null;

  // Strip a trailing `.git` from a clone URL.
  const slug = `${owner}/${name.replace(/\.git$/i, "")}`;
  return isRepoSlug(slug) ? slug : null;
}

interface RepoScopeInputProps {
  onSubmit: (repo: string) => void;
  /** Rendered above the field — why the user is being asked. */
  label?: string;
  autoFocus?: boolean;
}

export default function RepoScopeInput({
  onSubmit,
  label,
  autoFocus = false,
}: RepoScopeInputProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();

    const repo = normaliseRepoInput(value);
    if (!repo) {
      setError("Enter a repository as owner/name, or paste its GitHub URL.");
      return;
    }

    setError(null);
    onSubmit(repo);
  }

  return (
    <form onSubmit={submit} className="w-full">
      {label && (
        <label
          htmlFor="repo-scope"
          className="mb-1.5 block text-[12px] font-medium text-gray-700"
        >
          {label}
        </label>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            aria-hidden
          />
          <input
            id="repo-scope"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder="owner/name"
            aria-invalid={error !== null}
            aria-describedby={error ? "repo-scope-error" : undefined}
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-8 pr-3 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
        </div>

        <button
          type="submit"
          disabled={value.trim().length === 0}
          className="shrink-0 rounded-lg bg-gray-900 px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
        >
          Load
        </button>
      </div>

      {error && (
        <p id="repo-scope-error" className="mt-1.5 text-[11px] text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * The active scope, with a way out of it.
 *
 * Shown whenever the queue is not the default. Without this the user has no
 * signal that they are looking at a filtered view, and no way back — the most
 * common way a scoped view becomes a trap.
 */
export function RepoScopeBadge({
  repo,
  onClear,
}: {
  repo: string;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2">
      <p className="min-w-0 truncate text-[11.5px] text-amber-800">
        Showing all open PRs in{" "}
        <span className="font-semibold">{repo}</span>
      </p>
      <button
        onClick={onClear}
        className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100"
      >
        <X size={12} />
        Clear
      </button>
    </div>
  );
}
