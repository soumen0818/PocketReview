"use client";

interface RiskReasonsProps {
  reasons: string[];
  max?: number;
  className?: string;
}

/**
 * The ranked "why" list on the triage card.
 *
 * Reasons arrive already sorted by how many points each dimension actually
 * contributed, so showing the top few is honest — these genuinely are the
 * reasons, not a sample of them.
 */
export default function RiskReasons({
  reasons,
  max = 4,
  className = "",
}: RiskReasonsProps) {
  if (reasons.length === 0) return null;

  const shown = reasons.slice(0, max);
  const hidden = reasons.length - shown.length;

  return (
    <ul className={`space-y-1.5 ${className}`}>
      {shown.map((reason, index) => (
        <li
          key={index}
          className="flex gap-2 text-[13px] leading-snug text-gray-600"
        >
          <span className="text-gray-300 select-none shrink-0 mt-px">▸</span>
          <span>{reason}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li className="pl-4 text-[11px] text-gray-400">
          +{hidden} more signal{hidden === 1 ? "" : "s"}
        </li>
      )}
    </ul>
  );
}
