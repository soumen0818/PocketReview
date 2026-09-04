"use client";

import { formatDuration } from "@/lib/engines/effort-estimator";

interface BudgetPickerProps {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}

/**
 * "How long have you got?"
 *
 * Presets rather than a free-form input: the question is asked in the shape a
 * reviewer already thinks about it — a coffee, a gap between meetings, a
 * morning — and a preset is one tap on a phone where a number field is four.
 */
const PRESETS = [15, 30, 45, 60, 90];

export default function BudgetPicker({
  value,
  onChange,
  disabled = false,
}: BudgetPickerProps) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
        How long have you got?
      </p>

      <div
        className="flex gap-1.5"
        role="radiogroup"
        aria-label="Review time budget"
      >
        {PRESETS.map((minutes) => {
          const selected = minutes === value;
          return (
            <button
              key={minutes}
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(minutes)}
              className={`flex-1 rounded-lg px-2 py-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${
                selected
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 active:bg-gray-300"
              }`}
            >
              {formatDuration(minutes)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
