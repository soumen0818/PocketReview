"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import BudgetPicker from "@/components/plan/BudgetPicker";
import CapacityPanel from "@/components/plan/CapacityPanel";
import ReviewPlanView from "@/components/plan/ReviewPlan";
import { useReviewPlan } from "@/hooks/useReviewPlan";

/** Opening budget: a typical gap between meetings. */
const DEFAULT_BUDGET = 30;

/**
 * The review plan screen.
 *
 * The closing moment of the demo: not a sorted list, but an exact answer to
 * "I have 30 minutes — what should I do?", with the deficit panel above it
 * stating why that question needed asking.
 */
export default function PlanPage() {
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const { plan, capacity, loading, error, refetch } = useReviewPlan(budget);

  return (
    <main className="mx-auto flex h-[100dvh] w-full max-w-md flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-100 bg-white px-4 py-3 shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="-ml-1 rounded-full p-1.5 text-gray-600 transition-colors hover:bg-gray-100"
            aria-label="Back to the triage queue"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-none tracking-tight">
              Review plan
            </h1>
            <p className="mt-0.5 text-[11px] text-gray-400">
              What to do with the time you have
            </p>
          </div>
        </div>

        <button
          onClick={refetch}
          disabled={loading}
          className="shrink-0 rounded-full p-2 transition-colors hover:bg-gray-100 disabled:opacity-50"
          aria-label="Rebuild the plan"
        >
          <RefreshCw
            size={18}
            className={loading ? "animate-spin text-gray-400" : "text-gray-600"}
          />
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <BudgetPicker
            value={budget}
            onChange={setBudget}
            disabled={loading}
          />
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-[12px] font-medium text-red-700">
              Could not build a plan
            </p>
            <p className="mt-1 text-[11px] text-red-600">{error}</p>
            <button
              onClick={refetch}
              className="mt-2 text-[11px] font-medium text-red-700 underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* The deterministic data arrives in one response, so there is no
            partial state to render — either the plan is here or it is not. */}
        {!error && loading && !plan && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
            <p className="text-[12px] text-gray-400">Solving…</p>
          </div>
        )}

        {!error && capacity && <CapacityPanel capacity={capacity} />}
        {!error && plan && <ReviewPlanView plan={plan} />}

        {!error &&
          plan &&
          plan.items.length === 0 &&
          plan.deferred.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
              <p className="text-[13px] font-medium text-gray-900">
                Queue cleared
              </p>
              <p className="mt-1 text-[11px] text-gray-400">
                Your attention is free.
              </p>
            </div>
          )}
      </div>
    </main>
  );
}
